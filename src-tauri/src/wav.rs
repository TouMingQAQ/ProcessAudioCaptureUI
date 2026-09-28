//! 极简 WAV（16-bit PCM）写入器。
//!
//! 用于把 DLL 回调送来的 32-bit float 交错采样落盘，方便验证捕获链路是否真的通了。

use std::fs::File;
use std::io::{self, Seek, SeekFrom, Write};
use std::path::Path;

pub struct WavWriter {
    file: File,
    channels: u16,
    sample_rate: u32,
    /// 已写入的音频数据字节数（不含 44 字节头）。
    data_bytes: u32,
}

impl WavWriter {
    /// 创建文件并写入占位头，真正的尺寸在 `finalize` 时回填。
    pub fn create(path: &Path, sample_rate: u32, channels: u16) -> io::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut file = File::create(path)?;
        file.write_all(&header(sample_rate, channels, 0))?;
        Ok(Self {
            file,
            channels: channels.max(1),
            sample_rate,
            data_bytes: 0,
        })
    }

    /// 写入一段交错的 32-bit float 采样（自动钳位并转换为 int16）。
    pub fn write_interleaved(&mut self, samples: &[f32]) -> io::Result<()> {
        let mut pcm = Vec::with_capacity(samples.len());
        for &value in samples {
            let clamped = if value > 1.0 {
                1.0
            } else if value < -1.0 {
                -1.0
            } else if value.is_finite() {
                value
            } else {
                0.0
            };
            pcm.extend_from_slice(&((clamped * 32767.0) as i16).to_le_bytes());
        }
        self.file.write_all(&pcm)?;
        self.data_bytes = self.data_bytes.saturating_add(pcm.len() as u32);
        Ok(())
    }

    /// 回填 RIFF / data 长度。
    pub fn finalize(&mut self) -> io::Result<()> {
        let bytes = self.data_bytes;
        self.file.seek(SeekFrom::Start(0))?;
        self.file
            .write_all(&header(self.sample_rate, self.channels, bytes))?;
        self.file.flush()?;
        self.file.seek(SeekFrom::Start(44 + bytes as u64))?;
        Ok(())
    }
}

fn header(sample_rate: u32, channels: u16, data_bytes: u32) -> [u8; 44] {
    let channels = channels.max(1);
    let bits = 16u16;
    let block_align = channels * bits / 8;
    let byte_rate = sample_rate * block_align as u32;
    let riff_size = 36 + data_bytes;

    let mut out = [0u8; 44];
    out[0..4].copy_from_slice(b"RIFF");
    out[4..8].copy_from_slice(&riff_size.to_le_bytes());
    out[8..12].copy_from_slice(b"WAVE");
    out[12..16].copy_from_slice(b"fmt ");
    out[16..20].copy_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    out[20..22].copy_from_slice(&1u16.to_le_bytes()); // PCM
    out[22..24].copy_from_slice(&channels.to_le_bytes());
    out[24..28].copy_from_slice(&sample_rate.to_le_bytes());
    out[28..32].copy_from_slice(&byte_rate.to_le_bytes());
    out[32..34].copy_from_slice(&block_align.to_le_bytes());
    out[34..36].copy_from_slice(&bits.to_le_bytes());
    out[36..40].copy_from_slice(b"data");
    out[40..44].copy_from_slice(&data_bytes.to_le_bytes());
    out
}
