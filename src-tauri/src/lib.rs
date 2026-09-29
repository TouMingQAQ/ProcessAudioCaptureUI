//! 进程音频监听 —— Tauri 后端。
//!
//! 命令一览：
//! * `dll_status`          —— DLL 是否加载成功、版本号、搜索到的候选路径
//! * `reload_dll`          —— 重新尝试加载 DLL
//! * `list_audio_windows`  —— 可捕获音频的窗口列表（宿主侧补齐 DLL 缺失的能力）
//! * `start_capture`       —— 按 PID 启动捕获
//! * `start_capture_best`  —— 自动挑选当前最"响"的窗口并启动捕获
//! * `stop_capture`        —— 停止捕获并返回本次会话汇总
//! * `capture_status`      —— 当前采集状态（供悬浮球同步 UI）
//! * `set_auto_follow`     —— 自动跟随开关
//! * `set_ball_visible`    —— 显示 / 隐藏悬浮球（展开收起见 [`ball`]）
//! * `show_main_window`    —— 唤起主窗口
//! * `get_settings`        —— 读取界面偏好（主题 / 语言 / 默认开关）
//! * `save_settings`       —— 保存界面偏好并广播给所有窗口
//!
//! 另外还有一个系统托盘图标（见 [`tray`]），提供和悬浮球同款的功能菜单。

mod ball;
mod capture;
mod dsp;
mod monitor;
mod pac;
mod prefs;
mod sessions;
mod tray;
mod wav;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow};

use capture::{ActiveCapture, StartReport, StopReport};
use pac::PacLibrary;
use prefs::Settings;
use sessions::WindowListResult;

#[derive(Default)]
pub struct AppState {
    library: Mutex<Option<Arc<PacLibrary>>>,
    active: Mutex<Option<ActiveCapture>>,
    load_error: Mutex<Option<String>>,
    /// 自动跟随：当前采集源静音、且出现了新的发声窗口时自动切过去。
    auto_follow: AtomicBool,
    /// 最近一次使用的"顺便录 WAV"设置，自动跟随切换时会沿用。
    record_wav: AtomicBool,
    /// 悬浮球的可交互区域与拖动状态（悬停检测线程要用，见 [`ball`]）。
    ball: ball::BallInteraction,
}

/// 中毒的锁也要能拿到，否则一次 panic 会让整个应用卡死。
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 当前采集会话的只读快照。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    pub active: bool,
    pub pid: Option<u32>,
    pub process_name: Option<String>,
    pub total_frames: u64,
    pub sample_rate: u32,
    pub channels: u32,
}

impl AppState {
    /// 正在采集的 PID（没有会话时为 `None`）。
    pub(crate) fn captured_pid(&self) -> Option<u32> {
        lock(&self.active).as_ref().map(|active| active.pid)
    }

    /// 采集线程是否已经自己结束了（不是用户停的）。
    ///
    /// 返回结束时的错误码；仍在正常采集时返回 `None`。
    pub(crate) fn failed_session(&self) -> Option<i32> {
        let guard = lock(&self.active);
        let active = guard.as_ref()?;
        if active.is_alive() {
            return None;
        }
        Some(active.terminal_error())
    }

    pub(crate) fn capture_status(&self) -> CaptureStatus {
        match lock(&self.active).as_ref() {
            Some(active) => CaptureStatus {
                active: true,
                pid: Some(active.pid),
                process_name: Some(active.process_name.clone()),
                total_frames: active.counters.total_frames.load(Ordering::Relaxed),
                sample_rate: active.counters.sample_rate.load(Ordering::Relaxed),
                channels: active.counters.channels.load(Ordering::Relaxed),
            },
            None => CaptureStatus {
                active: false,
                pid: None,
                process_name: None,
                total_frames: 0,
                sample_rate: 0,
                channels: 0,
            },
        }
    }

    pub(crate) fn auto_follow(&self) -> bool {
        self.auto_follow.load(Ordering::Relaxed)
    }

    pub(crate) fn record_wav(&self) -> bool {
        self.record_wav.load(Ordering::Relaxed)
    }
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
pub(crate) fn ensure_library(app: &AppHandle, state: &AppState) -> Result<Arc<PacLibrary>, String> {
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
                if !lib.has_extras() {
                    eprintln!(
                        "[ProcessAudioCapture] 采集内核为 v{}，缺少目标枚举 / DSP 能力（需要 v3 及以上）",
                        lib.version()
                    );
                }
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
        .unwrap_or_else(|| std::path::PathBuf::from("."))
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

/* ------------------------------------------------------------------ 会话控制 */
/* 下面两个函数都是阻塞的（pac_start_capture 最长阻塞 10 秒），
   调用方必须自己放到阻塞线程池里。 */

pub(crate) fn stop_active(app: &AppHandle, state: &AppState, notify: bool) -> Option<StopReport> {
    let active = { lock(&state.active).take() };
    active.map(|active| active.stop(app, notify))
}

pub(crate) fn start_active(
    app: &AppHandle,
    state: &AppState,
    pid: u32,
    process_name: String,
    record_wav: bool,
) -> Result<StartReport, String> {
    if pid == 0 {
        return Err("PID 无效".to_string());
    }

    state.record_wav.store(record_wav, Ordering::Relaxed);

    // 先停掉上一个会话（静默停：这是切换，不是用户点停止）
    stop_active(app, state, false);

    let library = ensure_library(app, state)?;
    let wav_path = record_wav.then(|| recording_path(app, &process_name, pid));

    let active = capture::start_capture(
        app.clone(),
        Arc::clone(&library),
        pid,
        process_name,
        wav_path.clone(),
    )?;

    // 采集格式由内核在起流时就如实报出（capture.rs 已写进 counters），
    // 不用再等首帧回调，界面可以立刻显示真实采样率。
    let report = StartReport {
        pid: active.pid,
        process_name: active.process_name.clone(),
        sample_rate: active.counters.sample_rate.load(Ordering::Relaxed),
        channels: active.counters.channels.load(Ordering::Relaxed),
        dll_version: library.version(),
        wav_path,
        warnings: Vec::new(),
    };

    *lock(&state.active) = Some(active);
    Ok(report)
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
/// 窗口枚举 / 音频会话探测 / 媒体信息合并全在采集内核里完成（`pac_enum_targets`），
/// 这里只是把内核的结果转成前端结构。
#[tauri::command]
async fn list_audio_windows(app: AppHandle) -> Result<WindowListResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let library = ensure_library(&app, &state)?;
        sessions::list_audio_windows(&library)
    })
    .await
    .map_err(|e| format!("枚举窗口失败：{e}"))?
}

#[tauri::command]
fn capture_status(state: State<'_, AppState>) -> CaptureStatus {
    state.capture_status()
}

#[tauri::command]
async fn start_capture(
    app: AppHandle,
    pid: u32,
    process_name: String,
    record_wav: bool,
) -> Result<StartReport, String> {
    if pid == 0 {
        return Err("PID 无效".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        start_active(&app, &state, pid, process_name, record_wav)
    })
    .await
    .map_err(|e| format!("启动任务异常：{e}"))?
}

/// 自动挑一个当前正在出声的窗口开始采集（悬浮球上的"开始采集"用它）。
#[tauri::command]
async fn start_capture_best(
    app: AppHandle,
    record_wav: bool,
) -> Result<StartReport, String> {
    let app_for_pick = app.clone();
    let target = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        let state = app_for_pick.state::<AppState>();
        let library = ensure_library(&app_for_pick, &state)?;
        let result = sessions::list_audio_windows(&library)?;
        Ok(monitor::pick_candidate(&result.windows, None, std::process::id()))
    })
    .await
    .map_err(|e| format!("枚举窗口异常：{e}"))??;

    let target = target.ok_or_else(|| {
        "现在没有任何窗口在出声，先让音乐 / 视频播起来再试".to_string()
    })?;

    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        start_active(
            &app,
            &state,
            target.pid,
            target.process_name.clone(),
            record_wav,
        )
    })
    .await
    .map_err(|e| format!("启动任务异常：{e}"))?
}

/// 停止捕获，返回本次会话汇总（帧数 / 时长 / WAV 路径）。
#[tauri::command]
async fn stop_capture(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<StopReport>, String> {
    if state.captured_pid().is_none() {
        return Ok(None);
    }

    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        stop_active(&app, &state, true)
    })
    .await
    .map_err(|e| format!("停止任务异常：{e}"))
}

#[tauri::command]
fn set_auto_follow(app: AppHandle, state: State<'_, AppState>, enabled: bool) -> bool {
    state.auto_follow.store(enabled, Ordering::Relaxed);
    persist_auto_follow(&app, enabled);
    enabled
}

/* -------------------------------------------------------------- 界面偏好 */

/// 自动跟随是个"到处都能改"的开关（主界面、悬浮球、托盘菜单），
/// 改完都往设置文件里回写一份，重启后才记得住。
pub(crate) fn persist_auto_follow(app: &AppHandle, enabled: bool) {
    let mut settings = prefs::load(app);
    if settings.auto_follow != enabled {
        settings.auto_follow = enabled;
        if let Err(err) = prefs::store(app, &settings) {
            eprintln!("[ProcessAudioCapture] {err}");
        }
    }
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Settings {
    prefs::load(&app)
}

/// 保存设置：先落盘，再广播。落盘失败就直接返回错误，界面不会误以为已经存住。
#[tauri::command]
fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: Settings,
) -> Result<Settings, String> {
    prefs::store(&app, &settings)?;

    // 这两个开关的真身在 AppState 上（采集线程 / 自动跟随都要读），顺手同步过去
    state.auto_follow.store(settings.auto_follow, Ordering::Relaxed);
    state.record_wav.store(settings.record_wav, Ordering::Relaxed);

    prefs::broadcast(&app, &settings);
    Ok(settings)
}

/* -------------------------------------------------------------- 悬浮球窗口 */

fn ball_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window("ball")
        .ok_or_else(|| "悬浮球窗口不存在".to_string())
}

#[tauri::command]
fn set_ball_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    let window = ball_window(&app)?;
    if visible {
        window.show().map_err(|e| e.to_string())
    } else {
        // 隐藏前先恢复穿透，免得再显示出来时挡住桌面
        let _ = window.set_ignore_cursor_events(true);
        window.hide().map_err(|e| e.to_string())
    }
}

/// 前端上报可交互区域（球心 / 半径 / 面板矩形，窗口逻辑像素）。
///
/// 球多大、面板摆在哪一边都是前端算的（球的大小可变、面板还要避开屏幕边缘），
/// 悬停检测只要拿这块区域跟光标比一下就行，不必在这里重复一遍布局规则。
#[tauri::command]
fn set_ball_geometry(
    state: State<'_, AppState>,
    orb_x: f64,
    orb_y: f64,
    orb_r: f64,
    panel: Option<Vec<f64>>,
) {
    let panel = panel.and_then(|values| match values.as_slice() {
        [left, top, right, bottom] => Some([*left, *top, *right, *bottom]),
        _ => None,
    });
    let first = state.ball.set_hit(ball::BallHit {
        orb_x,
        orb_y,
        orb_r,
        panel,
    });
    if first {
        eprintln!(
            "[ProcessAudioCapture] 悬浮球可交互区域已上报：球心 ({orb_x:.0}, {orb_y:.0})，半径 {orb_r:.0}"
        );
    }
}

/// 拖动开始 / 结束。
///
/// 拖动期间窗口必须**保持可交互** —— 前端正收着 pointer 事件，一旦切成鼠标穿透，
/// 事件就断了，球会卡在半路。
#[tauri::command]
fn set_ball_dragging(state: State<'_, AppState>, dragging: bool) {
    state.ball.set_dragging(dragging);
}

#[tauri::command]
fn show_main_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?;
    // 可能刚才是最小化 / 被收进托盘的状态，先还原再显示
    let _ = window.unminimize();
    window.show().map_err(|e| e.to_string())?;
    let _ = window.set_focus();
    // 主界面一露脸，托盘菜单上的"隐藏主界面"就得跟上
    tray::sync(&app);
    Ok(())
}

/// 把悬浮球窗口铺满主显示器，并切成"收起"状态。
///
/// 铺满整屏而不是围着小球开一小块，是为了让球能停在屏幕的**任何**地方：窗口只有
/// 348×468 时球锚在窗口右下角、窗口又被限制在屏幕内，球就永远够不到屏幕上沿。
/// 铺满之后窗口自己不再移动，球的位置由前端按百分比定位决定（`ballPosX` / `ballPosY`）。
///
/// 顺带也避开了"改窗口尺寸会让 WebView 视口晚一帧"的老问题：尺寸只在启动时设一次。
fn place_ball(window: &WebviewWindow) {
    let Ok(Some(monitor)) = window.primary_monitor() else {
        return;
    };
    let origin = monitor.position();
    let bounds = monitor.size();
    let _ = window.set_position(PhysicalPosition::new(origin.x, origin.y));
    let _ = window.set_size(PhysicalSize::new(bounds.width, bounds.height));

    // 收起状态：整窗鼠标穿透，悬停交给 `ball` 模块轮询判断
    let _ = window.set_ignore_cursor_events(true);
}

fn recording_path(app: &AppHandle, process_name: &str, pid: u32) -> std::path::PathBuf {
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
        // 点 × 只是把主界面收进托盘：采集与悬浮球继续在后台跑，
        // 想彻底退出用托盘菜单里的"退出"。
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                    tray::sync(window.app_handle());
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();

            // 启动时就尝试加载一次 DLL，方便 UI 立刻显示状态
            {
                let state = app.state::<AppState>();
                if let Err(err) = ensure_library(&handle, &state) {
                    eprintln!("[ProcessAudioCapture] {err}");
                }
            }

            // 上次的偏好：自动跟随 / 默认录 WAV 要先进状态机，界面还没起来就得生效
            {
                let settings = prefs::load(&handle);
                let state = app.state::<AppState>();
                state.auto_follow.store(settings.auto_follow, Ordering::Relaxed);
                state.record_wav.store(settings.record_wav, Ordering::Relaxed);
            }

            // 悬浮球定位后显示，避免先出现在左上角再跳过去
            if let Some(ball) = app.get_webview_window("ball") {
                place_ball(&ball);
                let _ = ball.show();
            }

            // 系统托盘：程序常驻后台时的总控入口
            tray::setup(&handle)?;

            // 悬浮球的悬停检测：窗口尺寸恒定，靠轮询光标决定展开 / 收起
            ball::spawn(handle.clone());

            monitor::spawn(handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            dll_status,
            reload_dll,
            list_audio_windows,
            capture_status,
            start_capture,
            start_capture_best,
            stop_capture,
            set_auto_follow,
            set_ball_visible,
            set_ball_geometry,
            set_ball_dragging,
            show_main_window,
            get_settings,
            save_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
