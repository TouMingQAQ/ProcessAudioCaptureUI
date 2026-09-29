//! 后台实时扫描。
//!
//! 每 `SCAN_INTERVAL_MS` 毫秒枚举一次音频会话，做两件事：
//!
//! 1. 把「当前采集窗口」的最新信息（标题、会话状态、峰值）广播给两个窗口 ——
//!    音乐软件切歌时标题会跟着变，界面上就能实时看到；
//! 2. 开启自动跟随后，如果当前源已经没在出声、而另一个窗口开始发声，
//!    就把采集切到新的源上（带连续确认，避免抖动）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::filter;
use crate::sessions::{self, AudioWindowInfo, MediaInfo};
use crate::{ensure_library, start_active, stop_active, AppState};

/// 实时扫描结果事件，两个窗口都会收到。
pub const MONITOR_EVENT: &str = "pac://monitor";
/// 采集源变化（自动跟随切换）或托盘快捷操作结束时的结果提示。
pub const CAPTURE_CHANGED_EVENT: &str = "pac://capture-changed";

/// 扫描周期。
const SCAN_INTERVAL_MS: u64 = 1200;
/// 候选源至少要达到这个峰值，避免把"有会话但没出声"的窗口抢过来。
const CANDIDATE_MIN_PEAK: f32 = 0.015;
/// 当前源低于这个峰值就认为它已经没在出声。
const CURRENT_SILENT_PEAK: f32 = 0.006;
/// 连续多少次扫描都满足条件才真的切换。
const SWITCH_STREAK: u32 = 2;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorTick {
    /// 正在采集的那个窗口（每次扫描都刷新）。
    pub capturing: Option<AudioWindowInfo>,
    /// 自动跟随会切过去的窗口（和当前源不同）。
    pub candidate: Option<AudioWindowInfo>,
    /// 当前采集源正在播放的媒体信息（来自 SMTC）。
    ///
    /// 播放器缩进托盘时窗口标题就没了，这是那时候唯一的"在放什么"来源；
    /// 平时它也更规整（歌名与歌手是分开的字段）。
    pub media: Option<MediaInfo>,
    pub active: bool,
    pub pid: Option<u32>,
    pub process_name: Option<String>,
    pub total_frames: u64,
    pub sample_rate: u32,
    pub channels: u32,
    pub auto_follow: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureChanged {
    pub pid: u32,
    pub process_name: String,
    /// 自动跟随是否成功。
    pub switched: bool,
    pub message: String,
}

/// 挑一个"值得监听"的窗口：会话处于 active，峰值最高，且不是自己。
///
/// `exclude` 用来排除当前已经在采集的 PID，这样候选永远是"另一个源"。
///
/// 名单过滤是**调用方**的事（`filter::allowed_windows`）：被拉黑的窗口根本不该走到这里，
/// 而这里也只管挑峰值最高的那一个。
pub fn pick_candidate(
    windows: &[AudioWindowInfo],
    exclude: Option<u32>,
    self_pid: u32,
) -> Option<AudioWindowInfo> {
    windows
        .iter()
        .filter(|w| w.pid != self_pid && Some(w.pid) != exclude)
        .filter(|w| w.session_state == "active" && w.session_peak >= CANDIDATE_MIN_PEAK)
        .max_by(|a, b| {
            a.session_peak
                .partial_cmp(&b.session_peak)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .cloned()
}

pub fn spawn(app: AppHandle) {
    if let Err(err) = thread::Builder::new()
        .name("pac-monitor".to_string())
        .spawn(move || run(app))
    {
        eprintln!("[ProcessAudioCapture] 无法启动实时扫描线程：{err}");
    }
}

fn run(app: AppHandle) {
    let mut streak = 0u32;
    let busy = Arc::new(AtomicBool::new(false));

    loop {
        thread::sleep(Duration::from_millis(SCAN_INTERVAL_MS));

        let state = app.state::<AppState>();

        // 目标枚举现在完全走采集内核
        let library = match ensure_library(&app, &state) {
            Ok(library) => library,
            Err(err) => {
                eprintln!("[ProcessAudioCapture] 采集内核不可用：{err}");
                continue;
            }
        };
        let result = match sessions::list_audio_windows(&library) {
            Ok(result) => result,
            Err(err) => {
                eprintln!("[ProcessAudioCapture] 枚举可采集目标失败：{err}");
                continue;
            }
        };

        let self_pid = std::process::id();

        let current_pid = state.captured_pid();

        // "正在采集的那个"照旧从完整列表里找：名单只决定谁**能被挑中**。用户把正在采的
        // 进程拉黑，意思是"以后别再选它"，不是"立刻把手上这条掐掉"。
        let capturing = current_pid
            .and_then(|pid| result.windows.iter().find(|w| w.pid == pid).cloned());

        let (allow, block) = state.window_lists();
        let selectable = filter::allowed_windows(&result.windows, &allow, &block);
        let candidate = pick_candidate(&selectable, current_pid, self_pid);
        let auto_follow = state.auto_follow();

        let status = state.capture_status();

        // 内核报告采集线程已经结束，而用户并没有点停止 —— 说明这条流自己断了。
        // 先收尾（stop_active 会广播 pac://stopped），下一轮扫描再刷新界面。
        if let Some(code) = state.failed_session() {
            let message = if code == 0 {
                "采集已结束".to_string()
            } else {
                format!("采集异常结束：{}", library.describe(code))
            };
            println!("[ProcessAudioCapture] {message}");

            let pid = status.pid.unwrap_or(0);
            let process_name = status.process_name.clone().unwrap_or_default();
            stop_active(&app, &state, true);
            let _ = app.emit(
                CAPTURE_CHANGED_EVENT,
                CaptureChanged { pid, process_name, switched: false, message },
            );
            continue;
        }

        // 媒体信息（曲名 / 歌手 / 播放状态）跟着目标条目一起由内核给出
        let media = capturing.as_ref().and_then(|window| window.media.clone());

        let _ = app.emit(
            MONITOR_EVENT,
            MonitorTick {
                capturing: capturing.clone(),
                candidate: candidate.clone(),
                media,
                active: status.active,
                pid: status.pid,
                process_name: status.process_name,
                total_frames: status.total_frames,
                sample_rate: status.sample_rate,
                channels: status.channels,
                auto_follow,
            },
        );

        // 这个循环本来就在盯采集状态，顺手把托盘菜单的文字 / 勾选刷新掉
        crate::tray::sync(&app);

        // ---- 自动跟随 ----------------------------------------------------
        let Some(candidate) = candidate else {
            streak = 0;
            continue;
        };
        let Some(current_pid) = current_pid else {
            // 没在采集时不自动开启，交给用户点"开始采集"
            streak = 0;
            continue;
        };
        if !auto_follow || candidate.pid == current_pid || busy.load(Ordering::SeqCst) {
            streak = 0;
            continue;
        }

        let current_peak = capturing.as_ref().map(|w| w.session_peak).unwrap_or(0.0);
        if current_peak >= CURRENT_SILENT_PEAK {
            // 当前源还在出声，不抢
            streak = 0;
            continue;
        }

        streak += 1;
        if streak < SWITCH_STREAK {
            continue;
        }
        streak = 0;

        let pid = candidate.pid;
        let process_name = candidate.process_name.clone();
        let record_wav = state.record_wav();
        drop(state);

        busy.store(true, Ordering::SeqCst);
        let app_for_switch = app.clone();
        let busy_for_switch = Arc::clone(&busy);
        tauri::async_runtime::spawn_blocking(move || {
            let state = app_for_switch.state::<AppState>();
            stop_active(&app_for_switch, &state, false);
            let (switched, message) =
                match start_active(&app_for_switch, &state, pid, process_name.clone(), record_wav) {
                    Ok(report) => (
                        true,
                        format!("自动跟随切到 {}（PID {}）", report.process_name, report.pid),
                    ),
                    Err(err) => (false, format!("自动跟随切换失败：{err}")),
                };

            println!("[ProcessAudioCapture] {message}");
            let _ = app_for_switch.emit(
                CAPTURE_CHANGED_EVENT,
                CaptureChanged {
                    pid,
                    process_name,
                    switched,
                    message,
                },
            );
            busy_for_switch.store(false, Ordering::SeqCst);
        });
    }
}
