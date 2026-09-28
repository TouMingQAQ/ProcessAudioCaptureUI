import { invoke } from "@tauri-apps/api/core";
import type { BallDataSource } from "./ball-style";
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
  /** `light` / `dark` / `system`，同时作用于主界面与悬浮球。 */
  themeMode: ThemeMode;
  appTheme: string;
  ballTheme: string;
  /** 悬浮球「律动样式」id（见 `ball-style.ts` 的 `BALL_STYLES`）：决定小球长什么样。 */
  ballStyle: string;
  /** 小球跟着哪种数据律动：`spectrum`（频谱）/ `wave`（波形）/ `adaptive`（自适应）。 */
  ballSource: BallDataSource;
  language: Language;
  autoFollow: boolean;
  recordWav: boolean;
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

/** `pac://ball-hover` 事件的负载。 */
export interface BallHover {
  hovered: boolean;
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
  setBallVisible: (visible: boolean) => invoke<void>("set_ball_visible", { visible }),
  showMainWindow: () => invoke<void>("show_main_window"),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<Settings>("save_settings", { settings }),
};
