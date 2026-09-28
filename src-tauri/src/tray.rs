//! 系统托盘图标 —— 程序常驻后台时的总控入口。
//!
//! * **左键**：显示 / 隐藏主界面（最顺手的一键操作）；
//! * **右键**：和悬浮球同款的功能菜单 —— 开始/停止采集、自动跟随、
//!   显示/隐藏悬浮球、显示/隐藏主界面、退出。
//!
//! 菜单里的文字和勾选状态由 [`sync`] 在每个扫描周期（约 1.2 秒）刷新一次，
//! 所以不管用户是从悬浮球、主界面还是托盘本身改的状态，
//! 托盘上看到的永远是最新的那一份。

use std::sync::atomic::Ordering;
use std::sync::Mutex;

use tauri::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::monitor::{CaptureChanged, CAPTURE_CHANGED_EVENT};
use crate::{ensure_library, monitor, sessions, start_active, stop_active, AppState};

const TRAY_ID: &str = "pac-tray";
const APP_NAME: &str = "进程音频监听";

/// 菜单项句柄：菜单建好之后还要改文字 / 勾选，所以得把它们留着。
pub struct TrayHandles {
    tray: TrayIcon<Wry>,
    /// 「显示主界面 / 隐藏主界面」
    show_main: MenuItem<Wry>,
    /// 「开始采集 / 停止采集」
    toggle_capture: MenuItem<Wry>,
    auto_follow: CheckMenuItem<Wry>,
    toggle_ball: CheckMenuItem<Wry>,
    /// 上一次写进托盘的提示文字，避免每个扫描周期都去戳一次 Shell。
    last_tooltip: Mutex<String>,
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let show_main = MenuItem::with_id(app, "show-main", "隐藏主界面", true, None::<&str>)?;
    let toggle_capture = MenuItem::with_id(app, "toggle-capture", "开始采集", true, None::<&str>)?;
    let auto_follow =
        CheckMenuItem::with_id(app, "auto-follow", "自动跟随出声窗口", true, false, None::<&str>)?;
    let toggle_ball =
        CheckMenuItem::with_id(app, "toggle-ball", "显示悬浮球", true, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &show_main,
            &PredefinedMenuItem::separator(app)?,
            &toggle_capture,
            &auto_follow,
            &PredefinedMenuItem::separator(app)?,
            &toggle_ball,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(APP_NAME)
        .menu(&menu)
        // 左键留给"显示 / 隐藏"，菜单走右键 —— 两个功能互不打扰
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(on_tray_event);

    // 直接用应用自己的图标，和标题栏、安装包保持一致
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    let tray = builder.build(app)?;

    app.manage(TrayHandles {
        tray,
        show_main,
        toggle_capture,
        auto_follow,
        toggle_ball,
        last_tooltip: Mutex::new(APP_NAME.to_string()),
    });

    sync(app);
    Ok(())
}

/// 把最新状态刷到托盘上（文字、勾选、悬浮提示）。
///
/// 由 `monitor` 的扫描线程每 1.2 秒调一次：那个循环本来就在读采集状态，
/// 顺手刷新比在这里另起线程划算。
pub fn sync(app: &AppHandle) {
    let Some(handles) = app.try_state::<TrayHandles>() else {
        return;
    };
    let state = app.state::<AppState>();
    let status = state.capture_status();

    let capturing = status.pid;
    let ball_visible = window_visible(app, "ball").unwrap_or(true);
    let main_visible = window_visible(app, "main").unwrap_or(true);

    let _ = handles
        .toggle_capture
        .set_text(if capturing.is_some() { "停止采集" } else { "开始采集" });
    let _ = handles.auto_follow.set_checked(state.auto_follow());
    let _ = handles.toggle_ball.set_checked(ball_visible);
    let _ = handles
        .show_main
        .set_text(if main_visible { "隐藏主界面" } else { "显示主界面" });

    let tooltip = match (status.process_name.as_deref(), capturing) {
        (Some(name), Some(pid)) => format!("{APP_NAME} · 正在采集 {name}（PID {pid}）"),
        _ => format!("{APP_NAME} · 左键显示 / 隐藏主界面"),
    };

    let mut last = handles.last_tooltip.lock().unwrap_or_else(|e| e.into_inner());
    if *last != tooltip {
        *last = tooltip.clone();
        let _ = handles.tray.set_tooltip(Some(tooltip));
    }
}

fn window_visible(app: &AppHandle, label: &str) -> Option<bool> {
    app.get_webview_window(label)?.is_visible().ok()
}

/* ------------------------------------------------------------------ 交互 */

fn on_tray_event(tray: &TrayIcon<Wry>, event: TrayIconEvent) {
    // Windows 上按下 / 抬起各来一次事件，只认"抬起"，否则会来回切两下
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
    } = event
    {
        toggle_main(tray.app_handle());
    }
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "show-main" => toggle_main(app),
        "toggle-capture" => toggle_capture(app),
        "auto-follow" => toggle_auto_follow(app),
        "toggle-ball" => toggle_ball(app),
        // 主界面点 × 只是收进托盘，真正退出走这里
        "quit" => app.exit(0),
        _ => {}
    }
}

/// 显示 / 隐藏主界面。最小化也算"藏起来了"，再点一下就还原。
fn toggle_main(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let visible = window.is_visible().unwrap_or(true);
    let minimized = window.is_minimized().unwrap_or(false);

    if !visible || minimized {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    } else {
        let _ = window.hide();
    }
    sync(app);
}

fn toggle_ball(app: &AppHandle) {
    let Some(window) = app.get_webview_window("ball") else {
        return;
    };
    let _ = if window.is_visible().unwrap_or(true) {
        window.hide()
    } else {
        window.show()
    };
    sync(app);
}

fn toggle_auto_follow(app: &AppHandle) {
    let next = {
        let state = app.state::<AppState>();
        let next = !state.auto_follow();
        state.auto_follow.store(next, Ordering::Relaxed);
        next
    };

    println!(
        "[ProcessAudioCapture] 托盘：自动跟随{}",
        if next { "已开启" } else { "已关闭" }
    );
    sync(app);
}

/// 开始 / 停止采集 —— 和悬浮球那颗按钮走的是同一套逻辑（挑当前最响的窗口）。
fn toggle_capture(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();

        // 已有会话就先停，再点一次才会重新开始
        if state.captured_pid().is_some() {
            stop_active(&app, &state, true);
            return;
        }

        let library = match ensure_library(&app, &state) {
            Ok(library) => library,
            Err(err) => {
                notify(&app, None, false, format!("托盘：{err}"));
                return;
            }
        };
        let result = match sessions::list_audio_windows(&library) {
            Ok(result) => result,
            Err(err) => {
                notify(&app, None, false, format!("托盘：{err}"));
                return;
            }
        };
        let Some(target) = monitor::pick_candidate(&result.windows, None, std::process::id()) else {
            notify(
                &app,
                None,
                false,
                "托盘：现在没有任何窗口在出声，先让音乐 / 视频播起来再试",
            );
            return;
        };

        // record_wav = false：和悬浮球的"开始采集"保持一致，快捷入口不偷偷往硬盘写文件
        match start_active(&app, &state, target.pid, target.process_name.clone(), false) {
            Ok(report) => notify(
                &app,
                Some(report.pid),
                true,
                format!(
                    "托盘：已开始采集 {} · {} Hz / {} 声道",
                    report.process_name, report.sample_rate, report.channels
                ),
            ),
            Err(err) => notify(
                &app,
                Some(target.pid),
                false,
                format!("托盘：开始采集失败 —— {err}"),
            ),
        }
    });
}

/// 把托盘操作的结果播给两个窗口（悬浮球弹提示、主界面记日志）。
fn notify(app: &AppHandle, pid: Option<u32>, switched: bool, message: impl Into<String>) {
    let message = message.into();
    println!("[ProcessAudioCapture] {message}");
    let _ = app.emit(
        CAPTURE_CHANGED_EVENT,
        CaptureChanged {
            pid: pid.unwrap_or(0),
            process_name: String::new(),
            switched,
            message,
        },
    );
}
