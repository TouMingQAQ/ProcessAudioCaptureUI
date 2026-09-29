//! 悬浮球的悬停检测。
//!
//! 球窗口现在是**铺满整个屏幕**的一层透明窗口，小球本身由前端按百分比摆在里面。
//! 这么做是为了让球能停在屏幕的任何地方 —— 窗口只有一小块时球锚在窗口角上，窗口又被
//! 限制在屏幕内，球就永远够不到屏幕上沿。
//!
//! 代价是这层窗口会盖住整个桌面，所以收起状态下整窗设为**鼠标穿透**，悬停改由这里轮询
//! 光标位置判断：光标一进入小球（或展开后的面板）就把窗口恢复成可交互。
//!
//! 可交互区域的形状由前端上报（见 [`BallHit`]）—— 球多大、面板落在哪一边，只有前端
//! 知道；这里的轮询只要拿它跟光标位置比一下就行。
//!
//! 拖动期间窗口**固定保持可交互**：那时前端正收着 pointer 事件，一旦切成穿透，拖动就断了。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use crate::AppState;

/// 悬停状态变化事件，发给悬浮球窗口。
pub const BALL_HOVER_EVENT: &str = "pac://ball-hover";

/// 光标轮询间隔：一次 `GetCursorPos` 而已，25ms 既跟手又几乎不耗电。
const POLL_INTERVAL: Duration = Duration::from_millis(25);
/// 光标离开后的宽限期：从小球挪到面板要跨过一条缝隙，立刻收起会闪。
const LEAVE_GRACE: Duration = Duration::from_millis(260);

/// 前端上报的可交互区域，坐标是**窗口逻辑像素**（即 CSS 像素）。
///
/// 默认值全零（半径为 0），也就是"什么都点不到"—— 前端还没上报时窗口保持穿透，
/// 正好是启动时要的状态。
#[derive(Clone, Copy, Default)]
pub struct BallHit {
    /// 球心与半径。
    pub orb_x: f64,
    pub orb_y: f64,
    pub orb_r: f64,
    /// 面板矩形 `[left, top, right, bottom]`；没展开时是 `None`。
    pub panel: Option<[f64; 4]>,
}

/// 悬浮球的交互状态：命中区域 + 是否正在拖动。
#[derive(Default)]
pub struct BallInteraction {
    hit: Mutex<BallHit>,
    dragging: AtomicBool,
}

impl BallInteraction {
    /// 记下新的可交互区域。
    ///
    /// 返回"这是不是第一次拿到有效区域" —— 调用方拿它打一行启动日志，好把
    /// "前端没上报"和"上报了但命中判定不对"这两种毛病分开。
    pub fn set_hit(&self, hit: BallHit) -> bool {
        let Ok(mut slot) = self.hit.lock() else {
            return false;
        };
        let first = slot.orb_r <= 0.0 && hit.orb_r > 0.0;
        *slot = hit;
        first
    }

    pub fn set_dragging(&self, dragging: bool) {
        self.dragging.store(dragging, Ordering::Relaxed);
    }

    fn hit(&self) -> BallHit {
        self.hit.lock().map(|slot| *slot).unwrap_or_default()
    }

    fn is_dragging(&self) -> bool {
        self.dragging.load(Ordering::Relaxed)
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
        // `BallInteraction` 是 `AppState` 的字段，不是单独注册的托管状态；
        // 取不到就跳过这一轮，别让线程 panic —— 那会让窗口一直卡在穿透上。
        let Some(state) = app.try_state::<AppState>() else {
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

        // 拖动中固定保持可交互，不去看光标在不在球上
        if state.ball.is_dragging() {
            inside_since = Some(Instant::now());
            if !expanded {
                set_state(&app, &window, &mut expanded, true);
            }
            continue;
        }

        if cursor_inside(&app, &window, &state.ball, expanded) {
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
///
/// 光标与窗口位置都是**物理**像素，而上报的命中区域是逻辑像素，所以先把光标换算到
/// 窗口坐标系里再比。
fn cursor_inside(
    app: &AppHandle,
    window: &WebviewWindow,
    interaction: &BallInteraction,
    expanded: bool,
) -> bool {
    let hit = interaction.hit();
    if hit.orb_r <= 0.0 {
        return false;
    }

    let (Ok(cursor), Ok(position)) = (app.cursor_position(), window.outer_position()) else {
        return false;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let x = (cursor.x - position.x as f64) / scale;
    let y = (cursor.y - position.y as f64) / scale;

    let dx = x - hit.orb_x;
    let dy = y - hit.orb_y;
    if dx * dx + dy * dy <= hit.orb_r * hit.orb_r {
        return true;
    }

    if !expanded {
        return false;
    }

    hit.panel
        .is_some_and(|[left, top, right, bottom]| x >= left && x < right && y >= top && y < bottom)
}
