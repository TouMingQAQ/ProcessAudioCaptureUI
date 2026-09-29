import { invoke } from "@tauri-apps/api/core";
import type { Language } from "./i18n";
import type { ThemeMode } from "./theme";

/** 与 Rust 端 `sessions::AudioWindowInfo` 对应。 */
export interface AudioWindowInfo {
  hwnd: number;
  /** 这就是要传给 `pac_start_capture` 的值。 */
  pid: number;
  title: string;
  processName: string;
  processPath: string;
  hasSession: boolean;
  sessionState: "active" | "inactive" | "expired" | "none";
  sessionPeak: number;
  /**
   * 进程是否有可见窗口。`false` 表示它只存在于音频会话里（播放器缩进了托盘），
   * 此时 `hwnd` 为 0、`title` 来自系统媒体信息。
   */
  windowVisible: boolean;
  /** 该进程正在播放的媒体信息（由采集内核从 SMTC 读取）；没有则为 `null`。 */
  media?: MediaInfo | null;
}

export interface WindowListResult {
  windows: AudioWindowInfo[];
  warnings: string[];
}

export interface DllStatus {
  loaded: boolean;
  path: string | null;
  version: number;
  found: string[];
  expectedDir: string;
  error: string | null;
}

export interface StartReport {
  pid: number;
  processName: string;
  sampleRate: number;
  channels: number;
  dllVersion: number;
  wavPath: string | null;
  warnings: string[];
}

export interface StopReport {
  pid: number;
  processName: string;
  totalFrames: number;
  sampleRate: number;
  channels: number;
  durationMs: number;
  wavPath: string | null;
  droppedSamples: number;
  warnings: string[];
}

export interface CaptureStatus {
  active: boolean;
  pid: number | null;
  processName: string | null;
  totalFrames: number;
  sampleRate: number;
  channels: number;
}

/** 与 Rust 端 `smtc::MediaInfo` 对应：系统媒体控件里读到的"正在播放"。 */
export interface MediaInfo {
  /** 会话所属应用的 AUMID。 */
  appId: string;
  title: string;
  artist: string;
  album: string;
  status: "playing" | "paused" | "stopped" | "closed" | "changing" | "opened" | "unknown";
}

/** `pac://monitor` 事件的负载：实时扫描结果。 */
export interface MonitorTick extends CaptureStatus {
  /** 正在采集的窗口的最新信息（标题会跟着切歌变）。 */
  capturing: AudioWindowInfo | null;
  /** 自动跟随会切过去的窗口。 */
  candidate: AudioWindowInfo | null;
  /** SMTC 读到的媒体信息；窗口标题读不到（播放器缩进托盘）时靠它。 */
  media: MediaInfo | null;
  autoFollow: boolean;
  /** 持续监听的目标进程名（小写）；没有目标时为 `null`。 */
  monitorTarget: string | null;
  /** 目标不在线，正在等它出现。 */
  waiting: boolean;
}

/** `pac://capture-changed` 事件的负载。 */
export interface CaptureChanged {
  pid: number;
  processName: string;
  switched: boolean;
  message: string;
}

/** `pac://audio-frame` 事件的负载。 */
export interface AudioFrameEvent {
  pid: number;
  totalFrames: number;
  elapsedMs: number;
  /** `[min0, max0, min1, max1, ...]`，共 512 个值。 */
  waveform: number[];
  /** 归一化到 0..1 的对数频谱，共 128 个柱。 */
  spectrum: number[];
  rms: number;
  peak: number;
  windowMs: number;
}

/** 与 Rust 端 `prefs::Settings` 对应：主界面与悬浮球共用的界面偏好。 */
export interface Settings {
  /** `light` / `dark` / `system`，只作用于主界面；悬浮球不吃明暗，固定用浅色那份。 */
  themeMode: ThemeMode;
  appTheme: string;
  language: Language;
  autoFollow: boolean;
  recordWav: boolean;
  /**
   * 特效渲染的帧率上限（0 = 不限制）。
   *
   * 同一个数管两头：两个窗口的绘制循环按它限帧，采集内核的推帧节奏也按它放慢 ——
   * 只限绘制的话，事件里那 700 多个数字照样每秒被解析几十次。
   */
  frameRate: number;
  /**
   * 持续监听的目标进程名（小写，带扩展名）。空串 = 没有目标。
   *
   * 每次成功起流都会由后端刷新成那一次的进程；下次启动凭它自动接着监听，
   * 目标不在线时一直等它出现。改它要走 `setMonitorTarget`（有起流 / 停流的副作用），
   * 不是普通字段。
   */
  monitorTarget: string;

  /** 窗口检测白名单（进程名，小写）。空数组 = 不限制；非空则只有名单里的进程能被检测到。 */
  windowAllowlist: string[];
  /**
   * 窗口检测黑名单（进程名，小写）。这些进程不进窗口列表，也不会被自动跟随或悬浮球的
   * 「开始采集」选中。本应用自己的进程名永远在其中（后端保证，界面上那一条锁着删不掉）。
   */
  windowBlocklist: string[];

  /** 用户自定义色槽（有序）。空数组 = 还没配过，界面会按 `ballTheme` 或默认色补一份。 */
  ballColors: string[];
  /** 内圈样式 id（见 `ball-style.ts` 的 `BALL_INNER_STYLES`）。空 = 还没配过。 */
  ballInnerStyle: string;
  /** 外圈样式 id（见 `BALL_OUTER_STYLES`）。空 = 还没配过。 */
  ballOuterStyle: string;
  /** 内圈数据源。空 = 用样式的默认值。 */
  ballInnerSource: string;
  /** 外圈数据源。空 = 用样式的默认值。 */
  ballOuterSource: string;
  /** 悬浮球尺寸倍率（0~3，1 = 基准大小）。 */
  ballSize: number;
  /** 收到数据后的显示倍率（0~5，1 = 原始幅度）。 */
  ballGain: number;
  /** 是否让小球随音频律动缩放。 */
  ballPulse: boolean;
  /** 缩放算法 id（见 `ball-pulse.ts`）。 */
  ballPulseAlgorithm: string;
  /** 律动缩放的幅度倍率（1~3，1 = 算法原本的幅度）。 */
  ballPulseAmount: number;
  /** 悬浮球中心在屏幕里的位置（0~1 百分比），拖动后记住。 */
  ballPosX: number;
  ballPosY: number;
  /**
   * 锁定悬浮球：不吃鼠标（悬停不展开面板、不能拖动、点不动），解锁只能回主界面的设置。
   * 球照常显示、照常跟着音频动。
   */
  ballLocked: boolean;

  /** 旧版「悬浮球配色」id：只在 `ballColors` 为空时拿来当初始色。 */
  ballTheme: string;
  /** 旧版单一「律动样式」id，迁移时当作外圈样式。 */
  ballStyle: string;
  /** 旧版单一数据源，迁移时当作外圈数据源。空串 = 没配过。 */
  ballSource: string;
}

export const EVT_AUDIO = "pac://audio-frame";
export const EVT_STOPPED = "pac://stopped";
export const EVT_ERROR = "pac://error";
export const EVT_MONITOR = "pac://monitor";
export const EVT_CAPTURE_CHANGED = "pac://capture-changed";
/** 界面偏好变化（`save_settings` 之后由 Rust 广播给所有窗口）。 */
export const EVT_SETTINGS = "pac://settings";
/** 后端轮询光标后广播的悬浮球悬停状态（见 `src-tauri/src/ball.rs`）。 */
export const EVT_BALL_HOVER = "pac://ball-hover";
/**
 * 窗口"藏起来 / 露出来"事件名的前缀，实际名字还带窗口标签：
 * `pac://window-visibility:main` / `pac://window-visibility:ball`。
 *
 * 为什么连名字都要分开：Tauri 里 `listen()` 不指定 target 时注册的是 `EventTarget::Any`，
 * 而定向投递的过滤是"**Any 监听者一律放行**"（`tauri::event::listener::match_any_or_filter`），
 * 也就是说两个窗口监听同一个名字的话，`emit_to("main", …)` 会连悬浮球那份一起送到 ——
 * 主界面一收进托盘，小球就不动了。名字按窗口分开（并且前端再显式带上 target），
 * 才是真的各管各的（见 `render-gate.ts`）。
 */
export const EVT_VISIBILITY = "pac://window-visibility";

/** `pac://ball-hover` 事件的负载。 */
export interface BallHover {
  hovered: boolean;
}

/** `pac://window-visibility` 事件的负载。 */
export interface VisibilityPayload {
  visible: boolean;
}

/**
 * 悬浮球的可交互区域，坐标是**窗口逻辑像素**。
 *
 * 球窗口铺满整个屏幕，收起时整窗鼠标穿透，只有这块区域要留着接收鼠标 ——
 * 形状由前端算（球的大小可变、面板还要躲着屏幕边），后端的轮询线程照着比一下就行。
 */
export interface BallGeometry {
  /** 球心与半径。 */
  orbX: number;
  orbY: number;
  orbR: number;
  /** 面板矩形 `[left, top, right, bottom]`；没展开时传 null。 */
  panel: [number, number, number, number] | null;
}

export const WAVE_BUCKETS = 256;
export const SPECTRUM_BINS = 128;
/** `waveform` 是 `(min, max)` 成对出现的，这就是对数。 */
export const WAVE_PAIRS = WAVE_BUCKETS;

export const api = {
  dllStatus: () => invoke<DllStatus>("dll_status"),
  reloadDll: () => invoke<DllStatus>("reload_dll"),
  listWindows: () => invoke<WindowListResult>("list_audio_windows"),
  captureStatus: () => invoke<CaptureStatus>("capture_status"),
  startCapture: (pid: number, processName: string, recordWav: boolean) =>
    invoke<StartReport>("start_capture", { pid, processName, recordWav }),
  /** 让后端自己挑一个正在出声的窗口开始采集。 */
  startCaptureBest: (recordWav: boolean) =>
    invoke<StartReport>("start_capture_best", { recordWav }),
  stopCapture: () => invoke<StopReport | null>("stop_capture"),
  setAutoFollow: (enabled: boolean) => invoke<boolean>("set_auto_follow", { enabled }),
  /**
   * 手动设置持续监听对象（空串 = 清除）。
   *
   * 有副作用：目标在跑就直接切过去采，不在跑就记下来一直等它出现。所以它不跟普通设置
   * 一起走 `saveSettings`。
   */
  setMonitorTarget: (processName: string) =>
    invoke<void>("set_monitor_target", { processName }),
  /** 本应用自己的进程名（小写，带扩展名）—— 黑名单里那条锁定项就是它。 */
  selfProcessName: () => invoke<string>("self_process_name"),
  setBallVisible: (visible: boolean) => invoke<void>("set_ball_visible", { visible }),
  setBallGeometry: (geometry: BallGeometry) => invoke<void>("set_ball_geometry", { ...geometry }),
  setBallDragging: (dragging: boolean) => invoke<void>("set_ball_dragging", { dragging }),
  showMainWindow: () => invoke<void>("show_main_window"),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<Settings>("save_settings", { settings }),
};
