import { invoke } from "@tauri-apps/api/core";

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

export const EVT_AUDIO = "pac://audio-frame";
export const EVT_STOPPED = "pac://stopped";
export const EVT_ERROR = "pac://error";

export const WAVE_BUCKETS = 256;
export const SPECTRUM_BINS = 128;

export const api = {
  dllStatus: () => invoke<DllStatus>("dll_status"),
  reloadDll: () => invoke<DllStatus>("reload_dll"),
  listWindows: () => invoke<WindowListResult>("list_audio_windows"),
  startCapture: (pid: number, processName: string, recordWav: boolean) =>
    invoke<StartReport>("start_capture", { pid, processName, recordWav }),
  stopCapture: () => invoke<StopReport | null>("stop_capture"),
};
