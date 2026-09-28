//! 可采集目标列表 —— 数据全部来自采集内核。
//!
//! 「枚举窗口 + 探测 WASAPI 音频会话 + 读 SMTC 媒体信息 + 把三者按 PID 合并」
//! 原本是在这个模块里自己实现的，现在这些能力都在 `ProcessAudioCapture.dll`
//! 里（`pac_enum_targets`），宿主只剩一件事：把内核的条目转成前端要的形状。

use serde::Serialize;

use crate::pac::{
    PacLibrary, PAC_MEDIA_CHANGING, PAC_MEDIA_CLOSED, PAC_MEDIA_OPENED, PAC_MEDIA_PAUSED,
    PAC_MEDIA_PLAYING, PAC_MEDIA_STOPPED, PAC_MEDIA_UNKNOWN, PAC_SESSION_ACTIVE,
    PAC_SESSION_EXPIRED, PAC_SESSION_INACTIVE, PAC_SESSION_NONE,
};

/// 一个"可捕获音频的窗口"条目（前端直接消费这个结构）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioWindowInfo {
    /// 窗口句柄（HWND 的整数值，仅用于前端展示/去重）；没有窗口时为 0。
    pub hwnd: i64,
    /// 进程 ID —— 传给 `pac_start_capture` 的就是它。
    pub pid: u32,
    /// 窗口标题；没有窗口时是内核从媒体信息拼出来的曲目名。
    pub title: String,
    /// 进程可执行文件名，如 `chrome.exe`。
    pub process_name: String,
    /// 进程完整路径。
    pub process_path: String,
    /// 是否在 WASAPI 中存在音频会话。
    pub has_session: bool,
    /// 会话状态：`active` / `inactive` / `expired` / `none`。
    pub session_state: String,
    /// 会话实时峰值（0.0 ~ 1.0+），无会话时为 0。
    pub session_peak: f32,
    /// 进程是否有可见窗口。`false` 表示它只存在于音频会话里（播放器缩在托盘里）。
    pub window_visible: bool,
    /// 该进程正在播放的媒体信息（来自系统媒体控件）；没有则为 `None`。
    pub media: Option<MediaInfo>,
}

/// SMTC 读到的媒体信息（与前端 `MediaInfo` 对应）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    /// 会话所属应用；内核只回传匹配结果，这里用进程名代替。
    pub app_id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// `playing` / `paused` / `stopped` / `closed` / `changing` / `opened` / `unknown`
    pub status: String,
}

/// 枚举结果 + 可能的降级警告。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowListResult {
    pub windows: Vec<AudioWindowInfo>,
    /// 读取音频会话列表时的警告（例如没有默认播放设备）；为空表示一切正常。
    pub warnings: Vec<String>,
}

/// 问内核要一份"当前可采集目标"，转换成前端结构。
pub fn list_audio_windows(lib: &PacLibrary) -> Result<WindowListResult, String> {
    let snapshot = lib.enumerate_targets()?;

    let windows = snapshot
        .entries
        .into_iter()
        .map(|entry| {
            let media = (!entry.media_title.is_empty()).then(|| MediaInfo {
                app_id: entry.process_name.clone(),
                title: entry.media_title.clone(),
                artist: entry.media_artist.clone(),
                album: entry.media_album.clone(),
                status: media_status_name(entry.media_status),
            });

            AudioWindowInfo {
                hwnd: entry.hwnd as i64,
                pid: entry.pid,
                title: entry.title,
                process_name: entry.process_name,
                process_path: entry.process_path,
                has_session: entry.has_session,
                session_state: session_state_name(entry.session_state),
                session_peak: entry.session_peak,
                window_visible: entry.has_window,
                media,
            }
        })
        .collect();

    let mut warnings = Vec::new();
    if !snapshot.sessions_error.is_empty() {
        warnings.push(snapshot.sessions_error);
    }

    Ok(WindowListResult { windows, warnings })
}

/// 内核的会话状态码 → 前端使用的字符串。
fn session_state_name(state: i32) -> String {
    match state {
        PAC_SESSION_ACTIVE => "active",
        PAC_SESSION_INACTIVE => "inactive",
        PAC_SESSION_EXPIRED => "expired",
        _ => {
            debug_assert_eq!(state, PAC_SESSION_NONE);
            "none"
        }
    }
    .to_string()
}

/// 内核的媒体状态码 → 前端使用的字符串。
fn media_status_name(status: i32) -> String {
    match status {
        PAC_MEDIA_PLAYING => "playing",
        PAC_MEDIA_PAUSED => "paused",
        PAC_MEDIA_STOPPED => "stopped",
        PAC_MEDIA_CLOSED => "closed",
        PAC_MEDIA_CHANGING => "changing",
        PAC_MEDIA_OPENED => "opened",
        _ => {
            debug_assert_eq!(status, PAC_MEDIA_UNKNOWN);
            "unknown"
        }
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真机验证：内核交回来的列表要能被正确翻译成前端结构。
    #[test]
    fn translates_the_kernel_snapshot() {
        let candidates = crate::pac::candidate_paths(None);
        let lib = PacLibrary::load(&candidates[0]).expect("加载 DLL 失败");

        let result = list_audio_windows(&lib).expect("枚举失败");
        println!("条目数：{}", result.windows.len());
        for warning in &result.warnings {
            println!("警告：{warning}");
        }
        for window in result.windows.iter().take(12) {
            println!(
                "pid={:<7} state={:<9} peak={:.3} window={:<5} {:<26} {}",
                window.pid,
                window.session_state,
                window.session_peak,
                window.window_visible,
                window.process_name,
                window.title
            );
            if let Some(media) = &window.media {
                println!("      media: {} / {} ({})", media.title, media.artist, media.status);
            }
        }

        assert!(!result.windows.is_empty(), "一个条目都没有");
        // 没有窗口的条目必须被标出来，前端才好打「托盘」标记
        assert!(
            result.windows.iter().all(|window| window.hwnd != 0 || !window.window_visible),
            "无窗口条目的 hwnd 必须为 0"
        );
    }
}
