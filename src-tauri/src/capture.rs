//! 采集会话：把 DLL 的回调桥接到「环形缓冲 → 发射线程 → 前端事件」。
//!
//! 关键设计：
//! * DLL 回调跑在采集线程上，必须极快返回 —— 这里只做一次 `try_lock` + 拷贝，
//!   拿不到锁宁可丢这一块数据，也绝不阻塞音频线程；
//! * 发射线程按固定节奏（`EMIT_INTERVAL_MS`）把累计的采样做 DSP 后通过 Tauri 事件推给前端，
//!   顺带把原始交错采样写进 WAV（如果开启了录制）。

use std::collections::VecDeque;
use std::ffi::c_void;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::dsp::{Analyzer, AudioFrame};
use crate::pac::{PacAudioCallback, PacCaptureHandle, PacLibrary};
use crate::wav::WavWriter;

/// 前端监听的事件名。
pub const AUDIO_EVENT: &str = "pac://audio-frame";
/// 会话结束事件（DLL 侧异常中断 / 手动停止）。
pub const STOPPED_EVENT: &str = "pac://stopped";

/// 事件推送节奏（毫秒）。20ms ≈ 50fps。
const EMIT_INTERVAL_MS: u64 = 20;
/// 环形缓冲上限：约 1 秒 @48kHz 立体声，超了丢最旧的数据。
const MAX_BUFFERED_SAMPLES: usize = 48_000 * 2;

/// 跨线程共享的会话计数器。
#[derive(Default)]
pub struct SharedCounters {
    pub sample_rate: AtomicU32,
    pub channels: AtomicU32,
    pub total_frames: AtomicU64,
    /// 因为缓冲溢出被丢弃的采样数，用于 UI 提示。
    pub dropped_samples: AtomicU64,
}

/// 传给 DLL 回调的上下文。通过 `Box::into_raw` 固定地址后交给 C 侧。
pub struct CallbackCtx {
    queue: Arc<Mutex<VecDeque<f32>>>,
    counters: Arc<SharedCounters>,
}

/// 活跃的采集会话。
pub struct ActiveCapture {
    pub pid: u32,
    pub process_name: String,
    pub started_at: Instant,
    pub counters: Arc<SharedCounters>,
    pub wav_path: Option<PathBuf>,
    pub wav_enabled: bool,

    lib: Arc<PacLibrary>,
    handle: *mut PacCaptureHandle,
    ctx: *mut CallbackCtx,
    stop_flag: Arc<AtomicBool>,
    emitter: Option<JoinHandle<()>>,
}

// 句柄与上下文都是裸指针，但生命周期由本结构体严格管理（stop 时统一释放）。
unsafe impl Send for ActiveCapture {}

impl ActiveCapture {
    pub fn elapsed(&self) -> Duration {
        self.started_at.elapsed()
    }

    /// 停止采集：先让 DLL 停下（此后不会再触发回调），再让发射线程排空退出，最后回收内存。
    pub fn stop(mut self, app: &AppHandle) -> StopReport {
        let mut warnings = Vec::new();

        // 1. 停止 DLL 侧采集。该调用会 join 采集线程，返回后不会再有任何回调。
        let stop_code = unsafe { self.lib.stop_capture(self.handle) };
        if stop_code != 0 {
            warnings.push(self.lib.describe(stop_code));
        }

        // 2. 通知发射线程做最后一次排空并退出。
        self.stop_flag.store(true, Ordering::SeqCst);
        if let Some(handle) = self.emitter.take() {
            if handle.join().is_err() {
                warnings.push("发射线程异常退出".to_string());
            }
        }

        // 3. 释放回调上下文的内存（此时 C 侧已不再持有它）。
        if !self.ctx.is_null() {
            unsafe { drop(Box::from_raw(self.ctx)) };
            self.ctx = std::ptr::null_mut();
        }

        let report = StopReport {
            pid: self.pid,
            process_name: self.process_name.clone(),
            total_frames: self.counters.total_frames.load(Ordering::Relaxed),
            sample_rate: self.counters.sample_rate.load(Ordering::Relaxed),
            channels: self.counters.channels.load(Ordering::Relaxed),
            duration_ms: self.elapsed().as_millis() as u64,
            wav_path: if self.wav_enabled {
                self.wav_path.clone()
            } else {
                None
            },
            dropped_samples: self.counters.dropped_samples.load(Ordering::Relaxed),
            warnings,
        };

        let _ = app.emit(STOPPED_EVENT, &report);
        report
    }
}

/// 停止后的汇总信息。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopReport {
    pub pid: u32,
    pub process_name: String,
    pub total_frames: u64,
    pub sample_rate: u32,
    pub channels: u32,
    pub duration_ms: u64,
    pub wav_path: Option<PathBuf>,
    pub dropped_samples: u64,
    pub warnings: Vec<String>,
}

/// 启动结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartReport {
    pub pid: u32,
    pub process_name: String,
    pub sample_rate: u32,
    pub channels: u32,
    pub dll_version: u32,
    pub wav_path: Option<PathBuf>,
    pub warnings: Vec<String>,
}

/// 以阻塞方式启动一个采集会话。**必须在阻塞线程池里调用**（`pac_start_capture` 最多阻塞 10 秒）。
pub fn start_capture(
    app: AppHandle,
    lib: Arc<PacLibrary>,
    pid: u32,
    process_name: String,
    wav_path: Option<PathBuf>,
) -> Result<ActiveCapture, String> {
    let counters = Arc::new(SharedCounters::default());
    let queue: Arc<Mutex<VecDeque<f32>>> = Arc::new(Mutex::new(VecDeque::with_capacity(MAX_BUFFERED_SAMPLES)));
    let stop_flag = Arc::new(AtomicBool::new(false));

    let ctx = Box::new(CallbackCtx {
        queue: Arc::clone(&queue),
        counters: Arc::clone(&counters),
    });
    let ctx_ptr = Box::into_raw(ctx);

    // 发射线程：排空缓冲 → DSP → 事件推送 / 写盘
    let started_at = Instant::now();
    let emitter = spawn_emitter(
        app.clone(),
        Arc::clone(&queue),
        Arc::clone(&counters),
        Arc::clone(&stop_flag),
        wav_path.clone(),
        pid,
        started_at,
    );

    // SAFETY: 回调指针在会话存续期间不会移动，且我们保证在 stop 之后再释放。
    let (code, handle) = unsafe {
        lib.start_capture(pid, audio_callback as PacAudioCallback, ctx_ptr as *mut c_void)
    };

    if code != 0 || handle.is_null() {
        // 启动失败：先关掉发射线程，再回收上下文内存
        stop_flag.store(true, Ordering::SeqCst);
        let _ = emitter.join();
        unsafe { drop(Box::from_raw(ctx_ptr)) };

        let detail = lib.describe(code);
        return Err(format!("启动 PID {pid} 的音频捕获失败：{detail}"));
    }

    Ok(ActiveCapture {
        pid,
        process_name,
        started_at,
        counters,
        wav_path,
        wav_enabled: true,
        lib,
        handle,
        ctx: ctx_ptr,
        stop_flag,
        emitter: Some(emitter),
    })
}

/// DLL 回调。运行在采集线程上，必须尽快返回且绝不 panic。
unsafe extern "C" fn audio_callback(
    samples: *const f32,
    frames: u32,
    channels: u16,
    sample_rate: u32,
    user_data: *mut c_void,
) {
    if samples.is_null() || user_data.is_null() || frames == 0 || channels == 0 {
        return;
    }

    let ctx = &*(user_data as *const CallbackCtx);
    ctx.counters.sample_rate.store(sample_rate, Ordering::Relaxed);
    ctx.counters
        .channels
        .store(channels as u32, Ordering::Relaxed);
    ctx.counters
        .total_frames
        .fetch_add(frames as u64, Ordering::Relaxed);

    let len = frames as usize * channels as usize;
    let slice = std::slice::from_raw_parts(samples, len);

    // 音频线程上只做 try_lock：拿不到锁就丢掉这一块，绝不阻塞回调。
    if let Ok(mut guard) = ctx.queue.try_lock() {
        guard.extend(slice.iter().copied());
        let overflow = guard.len().saturating_sub(MAX_BUFFERED_SAMPLES);
        for _ in 0..overflow {
            guard.pop_front();
        }
        if overflow > 0 {
            ctx.counters
                .dropped_samples
                .fetch_add(overflow as u64, Ordering::Relaxed);
        }
    } else {
        ctx.counters
            .dropped_samples
            .fetch_add(len as u64, Ordering::Relaxed);
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_emitter(
    app: AppHandle,
    queue: Arc<Mutex<VecDeque<f32>>>,
    counters: Arc<SharedCounters>,
    stop_flag: Arc<AtomicBool>,
    wav_path: Option<PathBuf>,
    pid: u32,
    started_at: Instant,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name(format!("pac-emitter-{pid}"))
        .spawn(move || {
            let mut analyzer = Analyzer::new();
            let mut scratch: Vec<f32> = Vec::with_capacity(65_536);
            let mut pending: Vec<f32> = Vec::with_capacity(65_536);
            let mut recorder: Option<WavWriter> = None;
            let mut recorder_failed = false;
            let mut last_sample_rate = 0u32;
            let mut last_emit = Instant::now();
            let mut pending_interleaved: Vec<f32> = Vec::new();

            loop {
                // 1. 把缓冲里的数据搬到本地
                let drained: usize = {
                    let mut guard = lock(&queue);
                    let take = guard.len().min(131_072);
                    scratch.clear();
                    scratch.extend(guard.drain(..take));
                    take
                };

                let channels = counters.channels.load(Ordering::Relaxed).max(1) as usize;
                let sample_rate = counters.sample_rate.load(Ordering::Relaxed);

                if sample_rate != 0 && sample_rate != last_sample_rate {
                    last_sample_rate = sample_rate;
                    analyzer.rebuild_bin_ranges(sample_rate as f32);
                }

                if drained > 0 {
                    // 原始交错数据 → WAV
                    if let Some(path) = wav_path.as_ref() {
                        if recorder.is_none() && !recorder_failed && sample_rate != 0 {
                            match WavWriter::create(path, sample_rate, channels as u16) {
                                Ok(w) => recorder = Some(w),
                                Err(err) => {
                                    recorder_failed = true;
                                    let _ = app.emit(
                                        "pac://error",
                                        format!("创建 WAV 文件失败：{err}"),
                                    );
                                }
                            }
                        }
                        if let Some(w) = recorder.as_mut() {
                            if w.write_interleaved(&scratch).is_err() {
                                recorder_failed = true;
                                recorder = None;
                            }
                        }
                    }

                    // 降混到单声道，累积到 pending
                    if channels <= 1 {
                        pending.extend_from_slice(&scratch);
                    } else {
                        pending_interleaved.clear();
                        pending_interleaved.extend_from_slice(&scratch);
                        let frames = pending_interleaved.len() / channels;
                        let scale = 1.0 / channels as f32;
                        pending.reserve(frames);
                        for frame in 0..frames {
                            let base = frame * channels;
                            let mut sum = 0.0f32;
                            for ch in 0..channels {
                                sum += pending_interleaved[base + ch];
                            }
                            pending.push(sum * scale);
                        }
                    }

                    // 只保留最近 2 秒用于可视化，防止慢消费者拖垮内存
                    let cap = (sample_rate as usize).max(48_000) * 2;
                    if pending.len() > cap {
                        let excess = pending.len() - cap;
                        pending.drain(..excess);
                    }
                }

                // 2. 到点了就推一帧（未收到过数据时不推送，避免空转消耗 IPC）
                if last_emit.elapsed() >= Duration::from_millis(EMIT_INTERVAL_MS) {
                    if last_sample_rate != 0 {
                        let frame: AudioFrame = analyzer.analyze(&pending, last_sample_rate);
                        if app
                            .emit(
                                AUDIO_EVENT,
                                FrameEnvelope {
                                    pid,
                                    frame,
                                    total_frames: counters.total_frames.load(Ordering::Relaxed),
                                    elapsed_ms: started_at.elapsed().as_millis() as u64,
                                },
                            )
                            .is_err()
                        {
                            break;
                        }
                    }
                    pending.clear();
                    last_emit = Instant::now();
                }

                // 3. 停止条件：DLL 已停 + 缓冲排空
                if stop_flag.load(Ordering::SeqCst) && drained == 0 {
                    if let Some(mut w) = recorder.take() {
                        let _ = w.finalize();
                    }
                    if last_sample_rate != 0 {
                        let final_frame = analyzer.analyze(&pending, last_sample_rate);
                        let _ = app.emit(
                            AUDIO_EVENT,
                            FrameEnvelope {
                                pid,
                                frame: final_frame,
                                total_frames: counters.total_frames.load(Ordering::Relaxed),
                                elapsed_ms: started_at.elapsed().as_millis() as u64,
                            },
                        );
                    }
                    break;
                }

                if drained == 0 {
                    thread::sleep(Duration::from_millis(2));
                }
            }
        })
        .expect("无法创建音频发射线程")
}

/// 事件负载：会话信息 + 单帧 DSP 结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FrameEnvelope {
    pid: u32,
    total_frames: u64,
    elapsed_ms: u64,
    #[serde(flatten)]
    frame: AudioFrame,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}
