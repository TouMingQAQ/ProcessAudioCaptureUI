//! 补齐 `ProcessAudioCapture.dll` 缺失的接口。
//!
//! DLL 只接受 `pid`，它**不提供任何窗口枚举 / 音频会话查询能力**，
//! 因此"选择可以捕获音频的窗口"必须由宿主程序实现。这里做了两件事：
//!
//! 1. 用 `EnumWindows` 枚举可见的顶层窗口（Alt-Tab 级别的窗口），拿到 `HWND + PID + 标题`；
//! 2. 用 WASAPI（`IMMDeviceEnumerator` → `IAudioSessionManager2`）列出当前所有音频会话，
//!    得到每个 PID 的会话状态（是否正在出声）与实时峰值，用来标注"哪些窗口现在能抓到声音"。
//!
//! 最终把两者以 PID 合并，交给前端展示。

use std::collections::HashMap;

use serde::Serialize;

#[cfg(windows)]
use windows::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM, MAX_PATH};
#[cfg(windows)]
use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
#[cfg(windows)]
use windows::Win32::Media::Audio::{
    eMultimedia, eRender, AudioSessionState, AudioSessionStateActive, AudioSessionStateExpired,
    IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator,
};
#[cfg(windows)]
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
};
#[cfg(windows)]
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindow, GetWindowLongW, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsWindowVisible, GWL_EXSTYLE, GW_OWNER, WS_EX_TOOLWINDOW,
};
#[cfg(windows)]
use windows::core::{Interface, PWSTR};

/// 一个"可捕获音频的窗口"条目。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioWindowInfo {
    /// 窗口句柄（HWND 的整数值，仅用于前端展示/去重）。
    pub hwnd: i64,
    /// 进程 ID —— 传给 `pac_start_capture` 的就是它。
    pub pid: u32,
    /// 窗口标题。
    pub title: String,
    /// 进程可执行文件名，如 `chrome.exe`。
    pub process_name: String,
    /// 进程完整路径。
    pub process_path: String,
    /// 是否在 WASAPI 中存在音频会话。
    pub has_session: bool,
    /// 会话状态：`active` / `inactive` / `expired`。
    pub session_state: String,
    /// 会话实时峰值（0.0 ~ 1.0），无会话时为 0。
    pub session_peak: f32,
}

/// 枚举结果 + 可能的降级警告。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowListResult {
    pub windows: Vec<AudioWindowInfo>,
    /// 采集音频会话信息时的警告（例如没有默认输出设备）；为空表示一切正常。
    pub warnings: Vec<String>,
}

/// 一个音频会话的摘要信息。
#[cfg(windows)]
#[derive(Debug, Clone, Copy)]
struct SessionInfo {
    state: AudioSessionState,
    peak: f32,
}

/// 枚举可见窗口并合并 WASAPI 音频会话信息。
pub fn list_audio_windows() -> WindowListResult {
    let mut warnings = Vec::new();

    let session_map = match collect_audio_sessions() {
        Ok(map) => map,
        Err(err) => {
            warnings.push(err);
            HashMap::new()
        }
    };

    let windows = collect_windows(&session_map);
    WindowListResult { windows, warnings }
}

/// 枚举所有音频会话，按 PID 归档。
#[cfg(windows)]
fn collect_audio_sessions() -> Result<HashMap<u32, SessionInfo>, String> {
    let guard = ComGuard::new()?;

    let mut map: HashMap<u32, SessionInfo> = HashMap::new();

    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| format!("创建 IMMDeviceEnumerator 失败：{e}"))?;

        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eMultimedia)
            .map_err(|e| format!("获取默认播放设备失败（系统可能没有音频输出设备）：{e}"))?;

        let manager: IAudioSessionManager2 = device
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| format!("激活 IAudioSessionManager2 失败：{e}"))?;

        let sessions = manager
            .GetSessionEnumerator()
            .map_err(|e| format!("获取音频会话枚举器失败：{e}"))?;
        let count = sessions
            .GetCount()
            .map_err(|e| format!("读取音频会话数量失败：{e}"))?;

        for index in 0..count {
            let Ok(control) = sessions.GetSession(index) else {
                continue;
            };
            let Ok(control2) = control.cast::<IAudioSessionControl2>() else {
                continue;
            };
            let Ok(pid) = control2.GetProcessId() else {
                continue;
            };
            if pid == 0 {
                continue;
            }

            let state = control2
                .GetState()
                .unwrap_or(AudioSessionStateExpired);

            // IAudioMeterInformation 可以直接从会话控制接口 QueryInterface 得到
            let peak = control
                .cast::<IAudioMeterInformation>()
                .and_then(|meter| meter.GetPeakValue())
                .unwrap_or(0.0);

            // 同一进程可能有多个会话，取"最活跃 + 峰值最大"的那一个
            map.entry(pid)
                .and_modify(|existing| {
                    if state == AudioSessionStateActive {
                        existing.state = state;
                    }
                    existing.peak = existing.peak.max(peak);
                })
                .or_insert(SessionInfo { state, peak });
        }
    }

    drop(guard);
    Ok(map)
}

#[cfg(not(windows))]
fn collect_audio_sessions() -> Result<HashMap<u32, SessionInfo>, String> {
    Err("音频会话枚举仅在 Windows 上可用".to_string())
}

/// 枚举可见顶层窗口，把基础窗口信息与音频会话信息合并。
#[cfg(windows)]
fn collect_windows(session_map: &HashMap<u32, SessionInfo>) -> Vec<AudioWindowInfo> {
    let mut raw: Vec<(HWND, u32, String)> = Vec::new();
    let self_pid = std::process::id();

    unsafe {
        let _ = EnumWindows(Some(enum_window_proc), LPARAM(&mut raw as *mut _ as isize));
    }

    let mut path_cache: HashMap<u32, (String, String)> = HashMap::new();
    let mut out: Vec<AudioWindowInfo> = Vec::new();
    let mut seen_pid: HashMap<u32, usize> = HashMap::new();

    for (hwnd, pid, title) in raw {
        if pid == 0 || pid == self_pid {
            continue;
        }

        // 同一个进程可能有多个窗口，只保留标题最长（信息量最大）的那个
        if let Some(&slot) = seen_pid.get(&pid) {
            if out[slot].title.len() >= title.len() {
                continue;
            }
            // 新标题更长，覆盖旧条目
            let (process_name, process_path) = path_cache
                .get(&pid)
                .cloned()
                .unwrap_or_else(|| (String::new(), String::new()));
            out[slot] = build_entry(hwnd, pid, title, process_name, process_path, session_map);
            continue;
        }

        let (process_name, process_path) = path_cache
            .entry(pid)
            .or_insert_with(|| query_process_path(pid))
            .clone();

        seen_pid.insert(pid, out.len());
        out.push(build_entry(
            hwnd,
            pid,
            title,
            process_name,
            process_path,
            session_map,
        ));
    }

    // 排序：正在播放音频的排前面，其次按进程名 / 标题
    out.sort_by(|a, b| {
        b.session_peak
            .partial_cmp(&a.session_peak)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| (a.session_state != "active").cmp(&(b.session_state != "active")))
            .then_with(|| a.process_name.to_lowercase().cmp(&b.process_name.to_lowercase()))
            .then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
    });

    out
}

#[cfg(not(windows))]
fn collect_windows(_session_map: &HashMap<u32, SessionInfo>) -> Vec<AudioWindowInfo> {
    Vec::new()
}

#[cfg(windows)]
fn build_entry(
    hwnd: HWND,
    pid: u32,
    title: String,
    process_name: String,
    process_path: String,
    session_map: &HashMap<u32, SessionInfo>,
) -> AudioWindowInfo {
    let session = session_map.get(&pid);
    AudioWindowInfo {
        hwnd: hwnd.0 as i64,
        pid,
        title,
        process_name,
        process_path,
        has_session: session.is_some(),
        session_state: session.map(|s| state_name(s.state)).unwrap_or("none").to_string(),
        session_peak: session.map(|s| s.peak).unwrap_or(0.0),
    }
}

#[cfg(windows)]
fn state_name(state: AudioSessionState) -> &'static str {
    if state == AudioSessionStateActive {
        "active"
    } else if state == AudioSessionStateExpired {
        "expired"
    } else {
        "inactive"
    }
}

/// `EnumWindows` 回调：只保留"可见 + 有标题 + 非工具窗口 + 非子窗口"的顶层窗口。
#[cfg(windows)]
unsafe extern "system" fn enum_window_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let list = &mut *(lparam.0 as *mut Vec<(HWND, u32, String)>);

    if !IsWindowVisible(hwnd).as_bool() {
        return BOOL(1);
    }

    // 过滤掉拥有者窗口（如浮动工具栏）与 WS_EX_TOOLWINDOW 窗口，接近 Alt-Tab 的语义
    if !GetWindow(hwnd, GW_OWNER).unwrap_or_default().0.is_null() {
        return BOOL(1);
    }
    let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE);
    if (ex_style & WS_EX_TOOLWINDOW.0 as i32) != 0 {
        return BOOL(1);
    }

    let len = GetWindowTextLengthW(hwnd);
    if len <= 0 {
        return BOOL(1);
    }

    let mut buffer = vec![0u16; (len + 1) as usize];
    let copied = GetWindowTextW(hwnd, &mut buffer);
    if copied <= 0 {
        return BOOL(1);
    }
    let title = String::from_utf16_lossy(&buffer[..copied as usize])
        .trim()
        .to_string();
    if title.is_empty() {
        return BOOL(1);
    }

    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == 0 {
        return BOOL(1);
    }

    list.push((hwnd, pid, title));
    BOOL(1)
}

/// 查询进程的可执行文件名与完整路径。
#[cfg(windows)]
fn query_process_path(pid: u32) -> (String, String) {
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return (format!("pid:{pid}"), String::new());
        };

        let mut buffer = vec![0u16; MAX_PATH as usize];
        let mut size = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut size,
        );
        let _ = CloseHandle(handle);

        if result.is_err() {
            return (format!("pid:{pid}"), String::new());
        }

        let full = String::from_utf16_lossy(&buffer[..size as usize]);
        let name = full
            .rsplit(['\\', '/'])
            .next()
            .filter(|s| !s.is_empty())
            .unwrap_or(&full)
            .to_string();
        (name, full)
    }
}

/// 保证当前线程初始化过 COM；离开作用域时成对 `CoUninitialize`。
struct ComGuard {
    #[cfg(windows)]
    _private: (),
}

impl ComGuard {
    #[cfg(windows)]
    fn new() -> Result<Self, String> {
        unsafe {
            // 已经是其他模型（STA）时返回 RPC_E_CHANGED_MODE，此时仍可继续使用已初始化的 COM
            let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
            if hr.is_err() {
                // 0x80010106 = RPC_E_CHANGED_MODE
                if hr.0 as u32 != 0x8001_0106 {
                    return Err(format!("COM 初始化失败：{hr:?}"));
                }
            }
        }
        Ok(Self {
            #[cfg(windows)]
            _private: (),
        })
    }

    #[cfg(not(windows))]
    fn new() -> Result<Self, String> {
        Err("COM 仅在 Windows 上可用".to_string())
    }
}

#[cfg(windows)]
impl Drop for ComGuard {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enumerates_windows_and_audio_sessions() {
        let result = list_audio_windows();
        println!("可见窗口数：{}", result.windows.len());
        for warning in &result.warnings {
            println!("警告：{warning}");
        }
        for win in result.windows.iter().take(15) {
            println!(
                "pid={:<7} state={:<9} peak={:.3}  {:<24} {}",
                win.pid, win.session_state, win.session_peak, win.process_name, win.title
            );
        }
        assert!(
            !result.windows.is_empty(),
            "一个可见窗口都没枚举到，Win32 调用可能有问题"
        );
        // 没有默认播放设备时允许有 warning，但只要系统正常就应该能读到会话信息
        assert!(
            result.windows.iter().any(|w| w.has_session) || !result.warnings.is_empty(),
            "既没有音频会话也没有给出警告，说明 WASAPI 枚举静默失败了"
        );
    }
}
