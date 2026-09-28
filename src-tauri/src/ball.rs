//! 悬浮球的悬停检测。
//!
//! 小球窗口的尺寸与位置是**恒定**的：展开只是把面板显示出来，窗口本身不缩放也不
//! 移动。这是为了绕开 WebView 的一个行为 —— 它的布局视口就是窗口客户区，窗口一
//! resize，视口会**晚一帧**才跟上，那一帧里内容仍按旧视口排版、却已经画在新窗口的
//! 左上角；表现出来就是「鼠标一碰小球，小球先闪到窗口左上角再弹回来」。
//! 尺寸和位置全程不变，这一帧就不存在，也不需要任何"藏一帧"之类的遮掩。
//!
//! 代价是：收起时窗口比小球大得多，那片透明区域会挡住底下的东西。所以收起状态下
//! 整窗设为**鼠标穿透**，悬停改由这里轮询光标位置判断 —— 光标一进入小球（或展开后
//! 的面板）就把窗口恢复成可交互。

use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

/// 悬停状态变化事件，发给悬浮球窗口。
pub const BALL_HOVER_EVENT: &str = "pac://ball-hover";

/// 小球相对窗口**右下角**的偏移与尺寸（逻辑像素），与 `ball.css` 里的 `.orb` 一致。
const ORB_INSET: f64 = 24.0;
const ORB_SIZE: f64 = 96.0;

/// 面板区域（逻辑像素），与 `ball.css` 里的 `.panel` 一致。
/// 高度取上界即可 —— 能把真实面板整个盖住就行，多出来的部分是透明区。
const PANEL_INSET: f64 = 24.0;
const PANEL_BOTTOM: f64 = 132.0;
const PANEL_WIDTH: f64 = 300.0;
const PANEL_MAX_HEIGHT: f64 = 320.0;

/// 光标轮询间隔：一次 `GetCursorPos` 而已，25ms 既跟手又几乎不耗电。
const POLL_INTERVAL: Duration = Duration::from_millis(25);
/// 光标离开后的宽限期：从小球挪到面板要跨过一条缝隙，立刻收起会闪。
const LEAVE_GRACE: Duration = Duration::from_millis(260);

#[derive(Clone, Copy)]
struct Rect {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

impl Rect {
    fn contains(self, x: f64, y: f64) -> bool {
        x >= self.left && x < self.right && y >= self.top && y < self.bottom
    }
}

#[derive(Clone, Copy, Serialize)]
struct HoverPayload {
    hovered: bool,
}

/// 起一个后台线程盯光标。
pub fn spawn(app: AppHandle) {
    std::thread::Builder::new()
        .name("ball-hover".to_string())
        .spawn(move || run(app))
        .expect("无法创建悬浮球悬停检测线程");
}

fn run(app: AppHandle) {
    let mut expanded = false;
    let mut inside_since: Option<Instant> = None;

    loop {
        std::thread::sleep(POLL_INTERVAL);

        let Some(window) = app.get_webview_window("ball") else {
            continue;
        };

        // 隐藏时状态清零，下次显示从收起开始
        if !window.is_visible().unwrap_or(false) {
            inside_since = None;
            if expanded {
                set_state(&app, &window, &mut expanded, false);
            }
            continue;
        }

        if cursor_inside(&app, &window, expanded) {
            inside_since = Some(Instant::now());
            if !expanded {
                set_state(&app, &window, &mut expanded, true);
            }
        } else if expanded && inside_since.map_or(true, |at| at.elapsed() >= LEAVE_GRACE) {
            set_state(&app, &window, &mut expanded, false);
        }
    }
}

/// 切换悬停状态：先改窗口的可交互性，再通知前端切样式。
fn set_state(app: &AppHandle, window: &WebviewWindow, expanded: &mut bool, hovered: bool) {
    *expanded = hovered;
    // 收起时整窗穿透，不挡桌面；展开时得能点面板按钮、也能拖动小球
    let _ = window.set_ignore_cursor_events(!hovered);
    let _ = app.emit_to("ball", BALL_HOVER_EVENT, HoverPayload { hovered });
}

/// 光标是否落在小球（或展开后的面板）上。
fn cursor_inside(app: &AppHandle, window: &WebviewWindow, expanded: bool) -> bool {
    let (Ok(cursor), Ok(position), Ok(size)) = (
        app.cursor_position(),
        window.outer_position(),
        window.outer_size(),
    ) else {
        return false;
    };

    let scale = window.scale_factor().unwrap_or(1.0);
    let right = position.x as f64 + size.width as f64;
    let bottom = position.y as f64 + size.height as f64;

    let orb = Rect {
        left: right - (ORB_INSET + ORB_SIZE) * scale,
        top: bottom - (ORB_INSET + ORB_SIZE) * scale,
        right: right - ORB_INSET * scale,
        bottom: bottom - ORB_INSET * scale,
    };
    if orb.contains(cursor.x, cursor.y) {
        return true;
    }

    if !expanded {
        return false;
    }

    let panel = Rect {
        left: right - (PANEL_INSET + PANEL_WIDTH) * scale,
        top: bottom - (PANEL_BOTTOM + PANEL_MAX_HEIGHT) * scale,
        right: right - PANEL_INSET * scale,
        bottom: bottom - PANEL_BOTTOM * scale,
    };
    panel.contains(cursor.x, cursor.y)
}
