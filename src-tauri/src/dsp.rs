//! 可视化用的轻量 DSP：把单声道 PCM 压成"包络波形 + 对数频谱 + 电平"。
//!
//! 全部计算放在 Rust 侧，是为了避免每帧把几万个原始采样点通过 IPC 发到前端。

use std::sync::Arc;

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use serde::Serialize;

/// 送往前端的一帧可视化数据。
pub const WAVE_BUCKETS: usize = 256; // 每帧输出 256 组 (min,max) → 512 个 f32
pub const SPECTRUM_BINS: usize = 128; // 频谱柱数量
pub const FFT_SIZE: usize = 2048; // FFT 窗口长度
const FFT_LOW_HZ: f32 = 20.0;
const DB_FLOOR: f32 = -90.0;

/// 单帧分析结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFrame {
    /// `[min0, max0, min1, max1, ...]`，长度 2 * WAVE_BUCKETS。
    pub waveform: Vec<f32>,
    /// 归一化到 0..1 的对数频谱幅度，长度 SPECTRUM_BINS。
    pub spectrum: Vec<f32>,
    /// 均方根电平（线性 0..1）。
    pub rms: f32,
    /// 峰值电平（线性 0..1）。
    pub peak: f32,
    /// 单帧对应的时间跨度（毫秒）。
    pub window_ms: f32,
}

/// 持有 FFT 计划与复用缓冲区，避免每帧重新分配。
pub struct Analyzer {
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    scratch: Vec<Complex<f32>>,
    /// 每个频谱柱对应的 FFT bin 区间（闭区间）。
    bin_ranges: Vec<(usize, usize)>,
    /// 对数频率轴，用于前端绘制刻度。
    pub bin_frequencies: Vec<f32>,
}

impl Analyzer {
    pub fn new() -> Self {
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(FFT_SIZE);

        // Hann 窗
        let window = (0..FFT_SIZE)
            .map(|i| {
                let x = std::f32::consts::PI * 2.0 * i as f32 / (FFT_SIZE as f32 - 1.0);
                0.5 - 0.5 * x.cos()
            })
            .collect();

        // 对数分布的频率柱（20Hz → Nyquist，按 48kHz 名义采样率预先算好频率标注）
        let nyquist = 24000.0f32;
        let bin_frequencies: Vec<f32> = (0..SPECTRUM_BINS)
            .map(|i| {
                let t = i as f32 / (SPECTRUM_BINS as f32 - 1.0);
                FFT_LOW_HZ * (nyquist / FFT_LOW_HZ).powf(t)
            })
            .collect();

        let mut analyzer = Self {
            fft,
            window,
            scratch: vec![Complex::new(0.0, 0.0); FFT_SIZE],
            bin_ranges: Vec::new(),
            bin_frequencies,
        };
        analyzer.rebuild_bin_ranges(48000.0);
        analyzer
    }

    /// 采样率变化时重算频率 → bin 的映射。
    pub fn rebuild_bin_ranges(&mut self, sample_rate: f32) {
        let nyquist = (sample_rate / 2.0).max(FFT_LOW_HZ * 2.0);
        let bin_hz = sample_rate / FFT_SIZE as f32;
        self.bin_frequencies = (0..SPECTRUM_BINS)
            .map(|i| {
                let t = i as f32 / (SPECTRUM_BINS as f32 - 1.0);
                FFT_LOW_HZ * (nyquist / FFT_LOW_HZ).powf(t)
            })
            .collect();

        self.bin_ranges = self
            .bin_frequencies
            .iter()
            .map(|&freq| {
                let center = (freq / bin_hz).round() as isize;
                let half = 1isize;
                let lo = (center - half).clamp(1, (FFT_SIZE / 2 - 1) as isize) as usize;
                let hi = (center + half).clamp(1, (FFT_SIZE / 2 - 1) as isize) as usize;
                (lo.min(hi), hi.max(lo))
            })
            .collect();
    }

    /// 分析一段单声道采样（长度为 0 时返回静音帧）。
    pub fn analyze(&mut self, mono: &[f32], sample_rate: u32) -> AudioFrame {
        let (rms, peak) = levels(mono);
        let waveform = envelope(mono);
        let spectrum = self.spectrum(mono);
        let window_ms = if sample_rate == 0 {
            0.0
        } else {
            mono.len() as f32 / sample_rate as f32 * 1000.0
        };
        AudioFrame {
            waveform,
            spectrum,
            rms,
            peak,
            window_ms,
        }
    }

    /// 频谱：取最后 FFT_SIZE 个采样做加窗 FFT，再按对数频率聚合。
    fn spectrum(&mut self, mono: &[f32]) -> Vec<f32> {
        for slot in self.scratch.iter_mut() {
            *slot = Complex::new(0.0, 0.0);
        }

        let take = mono.len().min(FFT_SIZE);
        if take > 0 {
            let start = mono.len() - take;
            for i in 0..take {
                self.scratch[i] = Complex::new(mono[start + i] * self.window[i], 0.0);
            }
        }

        self.fft.process(&mut self.scratch);

        let norm = 2.0 / FFT_SIZE as f32;
        let mut out = Vec::with_capacity(SPECTRUM_BINS);
        for &(lo, hi) in &self.bin_ranges {
            let mut mag = 0.0f32;
            for bin in lo..=hi {
                let value = self.scratch[bin].norm() * norm;
                if value > mag {
                    mag = value;
                }
            }
            let db = 20.0 * (mag + 1e-9).log10();
            out.push(((db - DB_FLOOR) / -DB_FLOOR).clamp(0.0, 1.0));
        }
        out
    }
}

impl Default for Analyzer {
    fn default() -> Self {
        Self::new()
    }
}

/// 单声道采样的 RMS / 峰值。
pub fn levels(mono: &[f32]) -> (f32, f32) {
    if mono.is_empty() {
        return (0.0, 0.0);
    }
    let mut sum_sq = 0.0f64;
    let mut peak = 0.0f32;
    for &sample in mono {
        let value = if sample.is_finite() { sample } else { 0.0 };
        sum_sq += (value as f64) * (value as f64);
        let abs = value.abs();
        if abs > peak {
            peak = abs;
        }
    }
    let rms = (sum_sq / mono.len() as f64).sqrt() as f32;
    (rms.min(1.0), peak.min(1.0))
}

/// 把采样压成 `[min, max]` 包络对，长度固定为 `2 * WAVE_BUCKETS`。
pub fn envelope(mono: &[f32]) -> Vec<f32> {
    let mut out = vec![0.0f32; WAVE_BUCKETS * 2];
    if mono.is_empty() {
        return out;
    }

    let bucket = (mono.len() as f32 / WAVE_BUCKETS as f32).max(1.0);
    for i in 0..WAVE_BUCKETS {
        let start = ((i as f32) * bucket) as usize;
        let end = if i == WAVE_BUCKETS - 1 {
            mono.len()
        } else {
            (((i + 1) as f32) * bucket) as usize
        };
        if start >= mono.len() {
            break;
        }
        let end = end.min(mono.len()).max(start + 1);

        let mut min = f32::MAX;
        let mut max = f32::MIN;
        for &sample in &mono[start..end] {
            let value = if sample.is_finite() { sample } else { 0.0 };
            if value < min {
                min = value;
            }
            if value > max {
                max = value;
            }
        }
        if min == f32::MAX {
            min = 0.0;
            max = 0.0;
        }
        out[i * 2] = min;
        out[i * 2 + 1] = max;
    }
    out
}
