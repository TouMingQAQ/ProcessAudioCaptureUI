//! ProcessAudioCapture DLL 测试台 —— Tauri 后端。
//!
//! 对外暴露 5 个命令：
//! * `dll_status`         —— DLL 是否加载成功、版本号、搜索到的候选路径
//! * `reload_dll`         —— 重新尝试加载 DLL
//! * `list_audio_windows` —— 可捕获音频的窗口列表（宿主侧补齐 DLL 缺失的能力）
//! * `start_capture`      —— 按 PID 启动捕获
//! * `stop_capture`       —— 停止捕获并返回本次会话汇总

mod capture;
mod dsp;
mod pac;
mod sessions;
mod wav;

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use capture::{ActiveCapture, StartReport, StopReport};
use pac::PacLibrary;
use sessions::WindowListResult;

#[derive(Default)]
pub struct AppState {
    library: Mutex<Option<Arc<PacLibrary>>>,
    active: Mutex<Option<ActiveCapture>>,
    load_error: Mutex<Option<String>>,
}

/// 中毒的锁也要能拿到，否则一次 panic 会让整个应用卡死。
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DllStatus {
    pub loaded: bool,
    pub path: Option<String>,
    pub version: u32,
    /// 已找到的 DLL 文件候选路径（按优先级）。
    pub found: Vec<String>,
    /// 期望放置 DLL 的推荐目录。
    pub expected_dir: String,
    pub error: Option<String>,
}

/// 加载（或复用已加载的）DLL。
fn ensure_library(app: &AppHandle, state: &AppState) -> Result<Arc<PacLibrary>, String> {
    if let Some(lib) = lock(&state.library).as_ref() {
        return Ok(Arc::clone(lib));
    }

    let resource_dir = app.path().resource_dir().ok();
    let candidates = pac::candidate_paths(resource_dir.as_deref());

    let mut last_error = String::from("未找到 ProcessAudioCapture.dll");
    for path in &candidates {
        match PacLibrary::load(path) {
            Ok(lib) => {
                let lib = Arc::new(lib);
                *lock(&state.library) = Some(Arc::clone(&lib));
                *lock(&state.load_error) = None;
                return Ok(lib);
            }
            Err(err) => last_error = err,
        }
    }

    *lock(&state.load_error) = Some(last_error.clone());
    Err(format!(
        "{last_error}\n请把 ProcessAudioCapture.dll 放到：{}",
        expected_dir(app)
    ))
}

fn expected_dir(app: &AppHandle) -> String {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .or_else(|| app.path().resource_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
        .display()
        .to_string()
}

fn build_dll_status(app: &AppHandle, state: &AppState) -> DllStatus {
    let loaded = lock(&state.library).clone();

    let (is_loaded, path, version, error) = match loaded {
        Some(lib) => (true, Some(lib.path.display().to_string()), lib.version(), None),
        None => (false, None, 0, lock(&state.load_error).clone()),
    };

    let resource_dir = app.path().resource_dir().ok();
    let found = pac::candidate_paths(resource_dir.as_deref())
        .into_iter()
        .map(|p| p.display().to_string())
        .collect();

    DllStatus {
        loaded: is_loaded,
        path,
        version,
        found,
        expected_dir: expected_dir(app),
        error,
    }
}

#[tauri::command]
fn dll_status(app: AppHandle, state: State<'_, AppState>) -> DllStatus {
    build_dll_status(&app, &state)
}

/// 主动重试加载 DLL（用户手动放入文件后可以点"重新加载"）。
#[tauri::command]
fn reload_dll(app: AppHandle, state: State<'_, AppState>) -> DllStatus {
    *lock(&state.library) = None;
    if let Err(err) = ensure_library(&app, &state) {
        eprintln!("[ProcessAudioCapture] {err}");
    }
    build_dll_status(&app, &state)
}

/// 枚举"可捕获音频的窗口"。
///
/// 这是 DLL **没有提供**的能力：DLL 只认 PID，所以窗口枚举与音频会话探测都在宿主侧完成。
#[tauri::command]
async fn list_audio_windows() -> Result<WindowListResult, String> {
    tauri::async_runtime::spawn_blocking(sessions::list_audio_windows)
        .await
        .map_err(|e| format!("枚举窗口失败：{e}"))
}

/// 启动捕获。`pac_start_capture` 最多阻塞 10 秒，因此放在阻塞线程池执行。
#[tauri::command]
async fn start_capture(
    app: AppHandle,
    state: State<'_, AppState>,
    pid: u32,
    process_name: String,
    record_wav: bool,
) -> Result<StartReport, String> {
    if pid == 0 {
        return Err("PID 无效".to_string());
    }

    // 1. 停掉上一个会话（若有）。注意别把 MutexGuard 带过 await，否则 future 不是 Send。
    let previous = { lock(&state.active).take() };
    if let Some(previous) = previous {
        let app_for_stop = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || previous.stop(&app_for_stop)).await;
    }

    // 2. 确保 DLL 可用
    let library = ensure_library(&app, &state)?;

    // 3. 录制路径
    let wav_path = if record_wav {
        Some(recording_path(&app, &process_name, pid))
    } else {
        None
    };

    // 4. 在阻塞线程里真正启动采集
    let app_for_start = app.clone();
    let lib_for_start = Arc::clone(&library);
    let name_for_start = process_name.clone();
    let wav_for_start = wav_path.clone();

    let active = tauri::async_runtime::spawn_blocking(move || {
        let active = capture::start_capture(
            app_for_start,
            lib_for_start,
            pid,
            name_for_start,
            wav_for_start,
        )?;

        // 稍等首帧回调，好把真实采样格式回报给前端
        let deadline = Instant::now() + Duration::from_millis(1200);
        while active.counters.sample_rate.load(Ordering::Relaxed) == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        Ok::<_, String>(active)
    })
    .await
    .map_err(|e| format!("启动任务异常：{e}"))??;

    let report = StartReport {
        pid: active.pid,
        process_name: active.process_name.clone(),
        sample_rate: active.counters.sample_rate.load(Ordering::Relaxed),
        channels: active.counters.channels.load(Ordering::Relaxed),
        dll_version: library.version(),
        wav_path: if record_wav { wav_path } else { None },
        warnings: Vec::new(),
    };

    *lock(&state.active) = Some(active);
    Ok(report)
}

/// 停止捕获，返回本次会话汇总（帧数 / 时长 / WAV 路径）。
#[tauri::command]
async fn stop_capture(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<StopReport>, String> {
    let active = { lock(&state.active).take() };
    let Some(active) = active else {
        return Ok(None);
    };

    let report = tauri::async_runtime::spawn_blocking(move || active.stop(&app))
        .await
        .map_err(|e| format!("停止任务异常：{e}"))?;

    Ok(Some(report))
}

fn recording_path(app: &AppHandle, process_name: &str, pid: u32) -> PathBuf {
    let stem = std::path::Path::new(process_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("capture")
        .to_string();

    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().app_data_dir())
        .unwrap_or_else(|_| std::env::temp_dir());

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    dir.join(format!("pac_{stem}_{pid}_{stamp}.wav"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .setup(|app| {
            // 启动时就尝试加载一次 DLL，方便 UI 立刻显示状态
            let handle = app.handle().clone();
            let state = app.state::<AppState>();
            if let Err(err) = ensure_library(&handle, &state) {
                eprintln!("[ProcessAudioCapture] {err}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            dll_status,
            reload_dll,
            list_audio_windows,
            start_capture,
            stop_capture
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
