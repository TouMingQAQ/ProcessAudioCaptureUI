//! 界面偏好的读写与广播。
//!
//! 主界面与悬浮球是两个独立的 WebView，各自有自己的一份 DOM；主题、语言这类设置必须
//! 存在一个两边都能读到的地方，改一次两边同时生效。所以：
//!
//! * 落盘：`settings.json` 放在应用配置目录，重启后仍然生效；
//! * 广播：保存后 emit `pac://settings`，主界面与悬浮球各自监听并重新应用。

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// 设置变化广播事件名，与前端 `api.ts` 里的 `EVT_SETTINGS` 一致。
pub const SETTINGS_EVENT: &str = "pac://settings";

/// 界面偏好。字段全部有默认值，配置里缺字段或整个文件坏掉都不会影响启动。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// `light` / `dark` / `system`。
    pub theme_mode: String,
    /// 应用主题 id（见前端 `theme.ts` 的 `APP_THEMES`）。
    pub app_theme: String,
    /// `zh-CN` / `en-US`。
    pub language: String,
    /// 是否自动跟随出声的窗口。
    pub auto_follow: bool,
    /// 采集时是否默认录制 WAV。
    pub record_wav: bool,

    /* --------------------------------------------------------- 窗口名单 */
    /// 窗口检测白名单（进程名，小写）。**空数组 = 不限制**：除黑名单外都能被检测到；
    /// 一旦非空，就只有名单里的进程能被采集。
    pub window_allowlist: Vec<String>,
    /// 窗口检测黑名单（进程名，小写）。这些进程不会出现在窗口列表里，也不会被自动跟随
    /// 或悬浮球的「开始采集」选中。本应用自己的进程名永远在其中（见
    /// `filter::ensure_self_blocked`），落盘前后都由后端保证。
    pub window_blocklist: Vec<String>,

    /* ----------------------------------------------------------- 悬浮球 */
    /// 用户自定义色槽（有序，见 `theme.ts` 的 `BALL_COLOR_PRESETS` 取初始值）。
    /// **空数组表示还没配过**：界面会按 `ball_theme` 或默认色补一份，不写死在这里，
    /// 免得默认值和 `theme.ts` 里的默认色各说各的。
    pub ball_colors: Vec<String>,
    /// 内圈样式 id（见 `ball-style.ts` 的 `BALL_INNER_STYLES`）。空 = 还没配过。
    pub ball_inner_style: String,
    /// 外圈样式 id（见 `BALL_OUTER_STYLES`）。空 = 还没配过。
    pub ball_outer_style: String,
    /// 内圈跟哪种数据律动。空 = 用样式的默认值。
    pub ball_inner_source: String,
    /// 外圈跟哪种数据律动。空 = 用样式的默认值。
    pub ball_outer_source: String,
    /// 悬浮球尺寸倍率（0~3，1 = 基准大小）。
    pub ball_size: f32,
    /// 收到数据后的显示倍率（0~5，1 = 原始幅度）。
    pub ball_gain: f32,
    /// 是否让小球随音频律动缩放。
    pub ball_pulse: bool,
    /// 缩放算法 id（见 `ball-pulse.ts` 的 `BALL_PULSE_ALGORITHMS`）。
    pub ball_pulse_algorithm: String,
    /// 律动缩放的幅度倍率（1~3，1 = 算法原本的幅度）。
    pub ball_pulse_amount: f32,
    /// 悬浮球中心在屏幕里的位置（0~1，相对屏幕宽高的百分比）。
    ///
    /// 窗口铺满整个屏幕、球按百分比摆在里面，所以拖动只要记住这两个数就够了 ——
    /// 换分辨率、换显示器不用换算，也不怕窗口尺寸怎么变。
    pub ball_pos_x: f32,
    pub ball_pos_y: f32,

    /* ------------------------------------------------- 遗留字段（仅用于迁移） */
    /// 旧版「悬浮球配色」id。配色改成自定义色槽后不再读取，
    /// 只在 `ball_colors` 还是空的时候拿来当初始色用。
    pub ball_theme: String,
    /// 旧版单一「律动样式」id，迁移时当作外圈样式。
    pub ball_style: String,
    /// 旧版单一数据源，迁移时当作外圈数据源。
    pub ball_source: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme_mode: "system".to_string(),
            app_theme: "solid".to_string(),
            language: "zh-CN".to_string(),
            auto_follow: false,
            record_wav: false,

            window_allowlist: Vec::new(),
            window_blocklist: Vec::new(),

            ball_colors: Vec::new(),
            ball_inner_style: String::new(),
            ball_outer_style: String::new(),
            ball_inner_source: String::new(),
            ball_outer_source: String::new(),
            ball_size: 1.0,
            ball_gain: 1.0,
            ball_pulse: false,
            ball_pulse_algorithm: "nod".to_string(),
            ball_pulse_amount: 1.0,
            ball_pos_x: 0.92,
            ball_pos_y: 0.88,

            ball_theme: "solid".to_string(),
            ball_style: "ring".to_string(),
            ball_source: "adaptive".to_string(),
        }
    }
}

fn config_file<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("settings.json")
}

/// 读取设置。文件不存在 / 读不动 / 解析失败一律回退到默认值 —— 设置坏了不该拦住启动。
pub fn load<R: Runtime>(app: &AppHandle<R>) -> Settings {
    fs::read_to_string(config_file(app))
        .ok()
        .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
        .unwrap_or_default()
}

/// 写入设置。只在真正落盘成功后才算成功，避免界面以为存住了、重启却回退。
pub fn store<R: Runtime>(app: &AppHandle<R>, settings: &Settings) -> Result<(), String> {
    let file = config_file(app);
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败：{e}"))?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(|e| format!("序列化设置失败：{e}"))?;
    fs::write(&file, text).map_err(|e| format!("写入 {} 失败：{e}", file.display()))
}

/// 把设置广播给所有窗口。
pub fn broadcast<R: Runtime>(app: &AppHandle<R>, settings: &Settings) {
    let _ = app.emit(SETTINGS_EVENT, settings.clone());
}
