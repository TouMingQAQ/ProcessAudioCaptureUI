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
mod filter;
mod monitor;
mod pac;
mod prefs;
mod sessions;
mod tray;

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow};

#[cfg(windows)]
use windows::core::{w, PCWSTR};
#[cfg(windows)]
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    FindWindowExW, FindWindowW, SendMessageTimeoutW, SetWindowLongPtrW, SetWindowPos,
    GWLP_HWNDPARENT, HWND_BOTTOM, HWND_TOP, SMTO_NORMAL, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
};

use capture::{ActiveCapture, StartReport, StopReport};
use pac::PacLibrary;
use prefs::Settings;
use sessions::WindowListResult;

/// 窗口"藏起来 / 露出来"事件名的前缀。完整名字还带窗口标签：
/// `pac://window-visibility:main` / `pac://window-visibility:ball`。
pub const VISIBILITY_EVENT: &str = "pac://window-visibility";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisibilityPayload {
    pub visible: bool,
}

/// 告诉某个窗口"你现在可见 / 不可见"，前端据此开关特效渲染（见前端 `render-gate.ts`）。
///
/// 两道锁，缺一不可：
///
/// 1. **事件名带窗口标签**。Tauri 的定向投递只按"监听者声明的 target"过滤，而前端
///    `listen()` 不带 target 时注册的是 `EventTarget::Any` —— 过滤里 Any 一律放行
///    （`tauri::event::listener::match_any_or_filter`）。两边听同一个名字的话，藏起主界面
///    会把悬浮球那份一起送到，小球跟着不动了。
/// 2. 投递本身也是定向的（`emit_to`，不是 `emit`）。
pub(crate) fn emit_visibility(app: &AppHandle, label: &str, visible: bool) {
    let event = format!("{VISIBILITY_EVENT}:{label}");
    let _ = app.emit_to(label, &event, VisibilityPayload { visible });
}

#[derive(Default)]
pub struct AppState {
    library: Mutex<Option<Arc<PacLibrary>>>,
    active: Mutex<Option<ActiveCapture>>,
    load_error: Mutex<Option<String>>,
    /// 自动跟随：当前采集源静音、且出现了新的发声窗口时自动切过去。
    auto_follow: AtomicBool,
    /// 窗口检测名单（白 / 黑）。扫描线程每 1.2 秒就要用一次，每次都读文件撑不住，
    /// 所以跟 `auto_follow` 一样在状态里存一份，改设置时同步过来。
    window_allowlist: Mutex<Vec<String>>,
    window_blocklist: Mutex<Vec<String>>,
    /// 特效渲染的帧率上限（0 = 不限）。开新会话时换算成推帧间隔交给发射线程。
    frame_rate: AtomicU32,
    /// 持续监听的目标进程名（小写）。空 = 没有目标。
    monitor_target: Mutex<String>,
    /// 是否允许"目标一出现就自动起流"。用户点过停止就落回 false —— 不然他刚停下来，
    /// 下一轮扫描又把它拉起来了。
    monitor_armed: AtomicBool,
    /// 目标当前不在线、正在等它出现（界面据此显示"等待中"）。
    monitor_waiting: AtomicBool,
    /// 悬浮球的可交互区域与拖动状态（悬停检测线程要用，见 [`ball`]）。
    ball: ball::BallInteraction,
}

/// 中毒的锁也要能拿到，否则一次 panic 会让整个应用卡死。
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
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

    /// 窗口名单快照（`(白名单, 黑名单)`）。克隆一份出去，别拿着锁去跑枚举。
    pub(crate) fn window_lists(&self) -> (Vec<String>, Vec<String>) {
        (
            lock(&self.window_allowlist).clone(),
            lock(&self.window_blocklist).clone(),
        )
    }

    pub(crate) fn set_window_lists(&self, allow: &[String], block: &[String]) {
        *lock(&self.window_allowlist) = allow.to_vec();
        *lock(&self.window_blocklist) = block.to_vec();
    }

    /// 当前帧率上限（0 = 不限）。
    pub(crate) fn frame_rate(&self) -> u32 {
        self.frame_rate.load(Ordering::Relaxed)
    }

    /// 现在该用的推帧间隔（毫秒）。
    pub(crate) fn emit_interval_ms(&self) -> u32 {
        capture::frame_interval_ms(self.frame_rate())
    }

    /// 改帧率。正在跑的会话也一起跟上 —— 不用停流重开。
    pub(crate) fn set_frame_rate(&self, fps: u32) {
        self.frame_rate.store(fps, Ordering::Relaxed);
        let interval = capture::frame_interval_ms(fps);
        if let Some(active) = lock(&self.active).as_ref() {
            active
                .counters
                .emit_interval_ms
                .store(interval, Ordering::Relaxed);
        }
    }

    /// 持续监听的目标进程名（小写）。空串 = 没有目标。
    pub(crate) fn monitor_target(&self) -> String {
        lock(&self.monitor_target).clone()
    }

    pub(crate) fn set_monitor_target(&self, name: &str, armed: bool) {
        *lock(&self.monitor_target) = name.trim().to_lowercase();
        self.monitor_armed.store(armed, Ordering::Relaxed);
    }

    /// 目标一出现就自动起流吗（用户点过停止之后就不再自动起）。
    pub(crate) fn monitor_armed(&self) -> bool {
        self.monitor_armed.load(Ordering::Relaxed)
    }

    pub(crate) fn set_monitor_armed(&self, armed: bool) {
        self.monitor_armed.store(armed, Ordering::Relaxed);
    }

    /// 是否正在等目标出现。返回改之前的值，调用方拿它判断"要不要打一行日志"。
    pub(crate) fn set_monitor_waiting(&self, waiting: bool) -> bool {
        self.monitor_waiting.swap(waiting, Ordering::Relaxed)
    }

    pub(crate) fn monitor_waiting(&self) -> bool {
        self.monitor_waiting.load(Ordering::Relaxed)
    }
}

/// 记住这次监听的对象：下次启动凭它自动接着听（见 [`monitor`]）。
///
/// 主界面、悬浮球、托盘三个入口都会走到这里，所以"上一次监听的进程"永远是最后一次
/// 真正开始采集的那个，不区分是谁点的。
pub(crate) fn remember_monitor_target(app: &AppHandle, state: &AppState, process_name: &str) {
    let name = process_name.trim().to_lowercase();
    if name.is_empty() {
        return;
    }
    state.set_monitor_waiting(false);
    if state.monitor_target() == name {
        state.set_monitor_armed(true);
        return;
    }
    state.set_monitor_target(&name, true);
    persist_monitor_target(app, &name);
}

/// 把监听目标写回设置文件并广播（界面上的「监听对象」跟着变）。空串 = 清除目标。
pub(crate) fn persist_monitor_target(app: &AppHandle, name: &str) {
    let mut settings = prefs::load(app);
    if settings.monitor_target == name {
        return;
    }
    settings.monitor_target = name.to_string();
    match prefs::store(app, &settings) {
        Ok(()) => prefs::broadcast(app, &settings),
        Err(err) => eprintln!("[ProcessAudioCapture] {err}"),
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
        Some(lib) => (
            true,
            Some(lib.path.display().to_string()),
            lib.version(),
            None,
        ),
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
) -> Result<StartReport, String> {
    if pid == 0 {
        return Err("PID 无效".to_string());
    }

    // 先停掉上一个会话（静默停：这是切换，不是用户点停止）
    stop_active(app, state, false);

    let library = ensure_library(app, state)?;

    let active = capture::start_capture(
        app.clone(),
        Arc::clone(&library),
        pid,
        process_name,
        state.emit_interval_ms(),
    )?;

    // 采集格式由内核在起流时就如实报出（capture.rs 已写进 counters），
    // 不用再等首帧回调，界面可以立刻显示真实采样率。
    let report = StartReport {
        pid: active.pid,
        process_name: active.process_name.clone(),
        sample_rate: active.counters.sample_rate.load(Ordering::Relaxed),
        channels: active.counters.channels.load(Ordering::Relaxed),
        dll_version: library.version(),
        warnings: Vec::new(),
    };

    // 起流成功 = 用户选定了监听对象：缓存下来，下次启动接着听
    remember_monitor_target(app, state, &report.process_name);

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
) -> Result<StartReport, String> {
    if pid == 0 {
        return Err("PID 无效".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        start_active(&app, &state, pid, process_name)
    })
    .await
    .map_err(|e| format!("启动任务异常：{e}"))?
}

/// 自动挑一个当前正在出声的窗口开始采集（悬浮球上的"开始采集"用它）。
#[tauri::command]
async fn start_capture_best(app: AppHandle) -> Result<StartReport, String> {
    let app_for_pick = app.clone();
    let target = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        let state = app_for_pick.state::<AppState>();
        let library = ensure_library(&app_for_pick, &state)?;
        let result = sessions::list_audio_windows(&library)?;
        // 名单外的窗口不参与"自动挑一个"，不然刚屏蔽掉的进程会被悬浮球又捡回来
        let (allow, block) = state.window_lists();
        let selectable = filter::allowed_windows(&result.windows, &allow, &block);
        Ok(monitor::pick_candidate(
            &selectable,
            None,
            std::process::id(),
        ))
    })
    .await
    .map_err(|e| format!("枚举窗口异常：{e}"))??;

    let target =
        target.ok_or_else(|| "现在没有任何窗口在出声，先让音乐 / 视频播起来再试".to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        start_active(&app, &state, target.pid, target.process_name.clone())
    })
    .await
    .map_err(|e| format!("启动任务异常：{e}"))?
}

/// 停止捕获，返回本次会话汇总（帧数 / 时长）。
#[tauri::command]
async fn stop_capture(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<StopReport>, String> {
    if state.captured_pid().is_none() {
        return Ok(None);
    }

    // 用户显式停止：把"持续监听"一起解除，否则下一轮扫描会立刻把目标又拉起来。
    // 目标本身留着（下次启动仍会自动接着听），只是不再自动起流。
    state.set_monitor_armed(false);
    state.set_monitor_waiting(false);

    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        stop_active(&app, &state, true)
    })
    .await
    .map_err(|e| format!("停止任务异常：{e}"))
}

/// 手动设置持续监听对象（传空串 = 清除）。
///
/// 这是"立刻生效"的：目标在跑就直接切过去采，不在跑就记下来一直等它出现
/// （见 [`monitor::run`]）。手上的会话不管是不是同一个进程，都先停掉 —— 用户换了
/// 监听对象，旧的那条就不再是他要的了。
#[tauri::command]
async fn set_monitor_target(app: AppHandle, process_name: String) -> Result<(), String> {
    let name = process_name.trim().to_lowercase();

    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();

        if name.is_empty() {
            state.set_monitor_target("", false);
            state.set_monitor_waiting(false);
            persist_monitor_target(&app, "");
            notify_capture_changed(&app, None, false, "已清除持续监听对象".to_string());
            return Ok(());
        }

        state.set_monitor_target(&name, true);
        persist_monitor_target(&app, &name);

        let library = ensure_library(&app, &state)?;
        let result = sessions::list_audio_windows(&library)?;
        let (allow, block) = state.window_lists();
        let target = filter::allowed_windows(&result.windows, &allow, &block)
            .into_iter()
            .find(|window| window.process_name.eq_ignore_ascii_case(&name));

        match target {
            Some(window) => {
                if state.captured_pid() == Some(window.pid) {
                    state.set_monitor_waiting(false);
                    return Ok(());
                }
                stop_active(&app, &state, false);
                match start_active(&app, &state, window.pid, window.process_name.clone()) {
                    Ok(report) => {
                        state.set_monitor_waiting(false);
                        notify_capture_changed(
                            &app,
                            Some(report.pid),
                            true,
                            format!("已开始持续监听 {}", report.process_name),
                        );
                    }
                    Err(err) => {
                        return Err(format!("设置持续监听对象失败：{err}"));
                    }
                }
            }
            None => {
                // 目标现在不在：先把手上那条静默停掉，进入"等待目标出现"
                stop_active(&app, &state, false);
                state.set_monitor_waiting(true);
                notify_capture_changed(
                    &app,
                    None,
                    false,
                    format!("正在等待 {name} 启动，它一出现就会自动开始采集"),
                );
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("设置监听对象异常：{e}"))?
}

/// 发一条 `pac://capture-changed`：两个窗口据此弹提示 / 记日志（与托盘的 [`tray`] 同款）。
pub(crate) fn notify_capture_changed(
    app: &AppHandle,
    pid: Option<u32>,
    switched: bool,
    message: String,
) {
    println!("[ProcessAudioCapture] {message}");
    let _ = app.emit(
        monitor::CAPTURE_CHANGED_EVENT,
        monitor::CaptureChanged {
            pid: pid.unwrap_or(0),
            process_name: String::new(),
            switched,
            message,
        },
    );
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
fn get_settings(app: AppHandle, state: State<'_, AppState>) -> Settings {
    let mut settings = prefs::load(&app);
    // 本应用自己在黑名单里是锁定项：界面照着这份显示就行，不用自己再查一遍
    filter::ensure_self_blocked(&mut settings);
    // 监听目标由状态机管（改它要起流 / 停流），以状态里的为准
    settings.monitor_target = state.monitor_target();
    settings
}

/// 保存设置：先落盘，再广播。落盘失败就直接返回错误，界面不会误以为已经存住。
#[tauri::command]
fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: Settings,
) -> Result<Settings, String> {
    // 名单在这里统一收拾（去空白、转小写、去重、补上锁定的自己），广播出去的就是最终形态，
    // 四个窗口不必各算各的
    let mut settings = settings;
    filter::normalize(&mut settings);
    // 监听目标不走这条路径：它有副作用（会起流 / 停流），只能由 `set_monitor_target` 改。
    // 这里原样带回去，免得界面上那份旧值把状态机里的新目标盖掉。
    settings.monitor_target = state.monitor_target();

    prefs::store(&app, &settings)?;

    // 这几个开关的真身在 AppState 上（采集线程 / 自动跟随 / 扫描线程都要读），顺手同步过去
    state
        .auto_follow
        .store(settings.auto_follow, Ordering::Relaxed);
    state.set_window_lists(&settings.window_allowlist, &settings.window_blocklist);
    // 帧率：正在跑的会话也一起换成新的推帧节奏
    state.set_frame_rate(settings.frame_rate);
    // 锁定状态由悬停检测线程读，改完下一轮（≤25ms）就生效
    state.ball.set_locked(settings.ball_locked);
    apply_ball_window_level(&app, &settings.ball_window_level)?;

    prefs::broadcast(&app, &settings);
    Ok(settings)
}

/// 本应用自己的进程名（小写，带扩展名）。
///
/// 界面拿它把黑名单里那一条标成「本程序」并锁住删除按钮 —— 它是固定项，后端保证一直在
/// 名单里，不需要用户配，也删不掉。
#[tauri::command]
fn self_process_name() -> String {
    filter::self_process_name().to_string()
}

/* -------------------------------------------------------------- 悬浮球窗口 */

fn ball_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window("ball")
        .ok_or_else(|| "悬浮球窗口不存在".to_string())
}

/// 将悬浮球放到用户选择的窗口层级。壁纸模式把桌面 WorkerW 设为拥有窗口，
/// 悬浮球仍是顶层窗体，因此保留 WebView 的输入能力。
fn apply_ball_window_level(app: &AppHandle, level: &str) -> Result<(), String> {
    let window = ball_window(app)?;
    let level = match level {
        "wallpaper" | "topmost" => level,
        _ => "topmost",
    };

    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        unsafe {
            if level == "wallpaper" {
                let worker =
                    desktop_worker_window().ok_or_else(|| "找不到桌面壁纸窗口".to_string())?;
                window.set_always_on_top(false).map_err(|e| e.to_string())?;
                SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, worker.0 as isize);
                SetWindowPos(
                    hwnd,
                    Some(HWND_BOTTOM),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                )
                .map_err(|e| e.to_string())?;
            } else {
                SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, 0);
                window
                    .set_always_on_top(level == "topmost")
                    .map_err(|e| e.to_string())?;
                SetWindowPos(
                    hwnd,
                    Some(HWND_TOP),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                )
                .map_err(|e| e.to_string())?;
            }
        }
        return Ok(());
    }

    #[cfg(not(windows))]
    {
        if level == "wallpaper" {
            return Err("桌面壁纸层仅支持 Windows".to_string());
        }
        window
            .set_always_on_top(level == "topmost")
            .map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn set_ball_window_level(app: AppHandle, level: String) -> Result<(), String> {
    apply_ball_window_level(&app, &level)
}

#[cfg(windows)]
unsafe fn desktop_worker_window() -> Option<HWND> {
    let progman = FindWindowW(w!("Progman"), PCWSTR::null()).ok()?;
    // 通知资源管理器创建承载桌面壁纸的 WorkerW。
    let _ = SendMessageTimeoutW(
        progman,
        0x052C,
        WPARAM(0),
        LPARAM(0),
        SMTO_NORMAL,
        1000,
        None,
    );

    let mut worker = FindWindowExW(None, None, w!("WorkerW"), PCWSTR::null()).ok()?;
    while !worker.0.is_null() {
        let shell_view =
            FindWindowExW(Some(worker), None, w!("SHELLDLL_DefView"), PCWSTR::null()).ok();
        if shell_view.is_some_and(|hwnd| !hwnd.0.is_null()) {
            let background =
                FindWindowExW(None, Some(worker), w!("WorkerW"), PCWSTR::null()).ok()?;
            return (!background.0.is_null()).then_some(background);
        }
        worker = FindWindowExW(None, Some(worker), w!("WorkerW"), PCWSTR::null()).ok()?;
    }
    None
}

#[tauri::command]
fn set_ball_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    let window = ball_window(&app)?;
    if visible {
        window.show().map_err(|e| e.to_string())?;
    } else {
        // 隐藏前先恢复穿透，免得再显示出来时挡住桌面
        let _ = window.set_ignore_cursor_events(true);
        window.hide().map_err(|e| e.to_string())?;
    }
    // 只发给悬浮球自己：主界面的绘制循环不受影响
    emit_visibility(&app, "ball", visible);
    Ok(())
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

/// 把主窗口叫到前台。
///
/// 它可能被最小化了，也可能被收进了托盘（点 × 只是隐藏），所以先还原、再显示、最后抢焦点。
/// 两处共用这一段：悬浮球上的「打开主界面」，以及第二个实例启动时（见 [`run`]）。
fn reveal_main_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?;
    // 可能刚才是最小化 / 被收进托盘的状态，先还原再显示
    let _ = window.unminimize();
    window.show().map_err(|e| e.to_string())?;
    let _ = window.set_focus();
    // 主界面重新露脸：让它把特效渲染开回来（定向事件，悬浮球那份不受影响）
    emit_visibility(app, "main", true);
    // 主界面一露脸，托盘菜单上的"隐藏主界面"就得跟上
    tray::sync(app);
    Ok(())
}

#[tauri::command]
fn show_main_window(app: AppHandle) -> Result<(), String> {
    reveal_main_window(&app)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例得是注册的第一个插件：第二个进程应当在开线程、建窗口之前就退出去。
        // 退出前顺手把已经在跑的主界面叫到前台 —— 用户双击图标就该看见界面
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Err(err) = reveal_main_window(app) {
                eprintln!("[ProcessAudioCapture] 第二个实例唤起主窗口失败：{err}");
            }
        }))
        .manage(AppState::default())
        // 点 × 只是把主界面收进托盘：采集与悬浮球继续在后台跑，
        // 想彻底退出用托盘菜单里的"退出"。
        .on_window_event(|window, event| {
            match event {
                // 只有主界面走这条：点 × 只是收进托盘，采集与悬浮球继续在后台跑
                tauri::WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                    api.prevent_close();
                    let _ = window.hide();
                    // 藏起来之后前端没必要再画了 —— 定向通知，悬浮球那份照跑
                    emit_visibility(window.app_handle(), "main", false);
                    tray::sync(window.app_handle());
                }
                // 托盘退出或窗口被系统销毁时，页面可能来不及收到 pagehide；
                // 尽早通知前端停掉自己的渲染循环。
                tauri::WindowEvent::Destroyed => {
                    emit_visibility(window.app_handle(), window.label(), false);
                }
                _ => {}
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

            // 上次的偏好：自动跟随 / 帧率 / 监听缓存都要先进状态机，
            // 界面还没起来就得生效
            {
                let settings = prefs::load(&handle);
                let state = app.state::<AppState>();
                state
                    .auto_follow
                    .store(settings.auto_follow, Ordering::Relaxed);
                state.set_window_lists(&settings.window_allowlist, &settings.window_blocklist);
                state.ball.set_locked(settings.ball_locked);
                state.set_frame_rate(settings.frame_rate);
                if let Err(err) = apply_ball_window_level(&handle, &settings.ball_window_level) {
                    eprintln!("[ProcessAudioCapture] 设置悬浮球窗口层级失败：{err}");
                }

                // 监听缓存：上次听的是谁，这次接着听（不在线就一直等，见 [`monitor`]）
                let cached = settings.monitor_target.trim().to_lowercase();
                if cached.is_empty() {
                    state.set_monitor_target("", false);
                } else {
                    println!("[ProcessAudioCapture] 上次监听的是 {cached}，正在恢复…");
                    state.set_monitor_target(&cached, true);
                    state.set_monitor_waiting(true);
                }
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
            set_monitor_target,
            self_process_name,
            set_ball_visible,
            set_ball_geometry,
            set_ball_dragging,
            set_ball_window_level,
            show_main_window,
            get_settings,
            save_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
