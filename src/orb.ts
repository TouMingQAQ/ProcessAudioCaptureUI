/**
 * 悬浮球窗口里的实时渲染循环。
 *
 * 这里只负责"把一帧音频交给当前样式"：真正的画法在 `ball-render.ts`（纯函数，
 * 设置面板的样式卡片预览用的是同一份）。两者分工明确 —— 这个文件管平滑、空闲衰减、
 * 数据源选择与画布尺寸；那个文件管长什么样。
 */

import { SPECTRUM_BINS, WAVE_PAIRS, type AudioFrameEvent } from "./api";
import {
  currentBallDataSource,
  currentBallStyle,
  type BallDataSource,
  type BallStyle,
} from "./ball-style";
import { colorsFromPalette, renderOrb, type BallFrame, type OrbColors } from "./ball-render";
import { ballOrbColors } from "./theme";

/** 小球里最多参与绘制的"位置"数：频谱柱与波形采样都重采样到这个长度。 */
const BANDS = 84;

export class OrbVisualizer {
  private readonly canvas: HTMLCanvasElement;
  /** 已经平滑过的柱值；长度固定为 [`BANDS`]。 */
  private readonly columns = new Float32Array(BANDS);
  private raf = 0;
  private size = 0;
  private rms = 0;
  private peak = 0;
  private active = false;
  private lastFrameAt = 0;
  private lastPushAt = 0;
  /** 这一帧是不是波形包络驱动的（示波器样式要靠它决定画不画镜像线）。 */
  private waveDriven = false;

  /** 当前样式 / 数据源 / 配色，换主题或改设置时调 [`refreshLook`] 重新读一次。 */
  private style: BallStyle = currentBallStyle();
  private source: BallDataSource = currentBallDataSource();
  private colors: OrbColors = colorsFromPalette(ballOrbColors(""));

  /** 每帧回调：用来驱动面板上的 DOM 电平条。 */
  onRender: (rms: number, peak: number) => void = () => {};

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  /**
   * 主题 / 明暗 / 律动样式变了以后重新读一遍。
   *
   * 样式与数据源都是从 `<html data-ball-style>` 这类属性上读的，配色则按当前明暗
   * 从悬浮球主题里取；都不缓存到别处，免得两边说法不一致。
   */
  refreshLook(themeId: string) {
    this.colors = colorsFromPalette(ballOrbColors(themeId));
    this.style = currentBallStyle();
    this.source = currentBallDataSource();
  }

  /** 是否有正在进行的采集（决定小球是"活"的还是待机的）。 */
  setActive(active: boolean) {
    this.active = active;
  }

  push(frame: AudioFrameEvent) {
    const now = performance.now();
    // 第一帧直接吃满，避免从小球"涨"起来太慢
    const first = this.lastPushAt === 0;
    this.lastPushAt = now;
    this.lastFrameAt = now;
    this.active = true;

    const smooth = first ? 1 : 0.55;
    const { values, useWave } = collapse(frame, this.source);
    this.waveDriven = useWave;
    for (let i = 0; i < BANDS; i++) {
      this.columns[i] += (values[i] - this.columns[i]) * smooth;
    }
    this.rms += (frame.rms - this.rms) * smooth;
    this.peak += (frame.peak - this.peak) * smooth;
  }

  /** 采集停止后让小球慢慢回到待机。 */
  relax() {
    this.active = false;
    this.rms = 0;
    this.peak = 0;
    this.waveDriven = false;
    this.columns.fill(0);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
  }

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.size = Math.max(1, Math.floor(Math.min(rect.width, rect.height)));
  }

  private loop() {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const stale = now - this.lastFrameAt > 420;
    this.draw(now, stale);
    this.onRender(stale ? 0 : this.rms, stale ? 0 : this.peak);
  }

  private draw(now: number, stale: boolean) {
    if (this.size <= 0) return;
    const live = this.active && !stale;

    const frame: BallFrame = {
      bands: this.columns,
      useWave: this.waveDriven,
      level: live ? this.rms : 0,
      peak: live ? this.peak : 0,
      live,
      time: now,
    };

    renderOrb(
      this.canvas,
      this.style,
      this.colors,
      frame,
      this.size,
      Math.min(window.devicePixelRatio || 1, 2),
    );
  }
}

/**
 * 把一帧数据摊成 [`BANDS`] 个位置上的能量。
 *
 * * `spectrum` —— 128 柱对数频谱直接重采样，低音在左、高音在右；
 * * `wave` —— 内核给的 256 组 `(min, max)` 峰谷包络先取绝对值，得到"波形振幅"；
 * * `adaptive` —— 每帧比一下两者谁更活跃，谁活跃用谁（安静的歌用频谱看细节，
 *   鼓点密集时换成波形，冲击力更直接）。
 *
 * 顺带把"这次用的是波形"回报出去：包络是单极性的，示波器样式要据此换一种画法。
 */
function collapse(
  frame: AudioFrameEvent,
  source: BallDataSource,
): { values: Float32Array; useWave: boolean } {
  const values = new Float32Array(BANDS);

  const waveLen = Math.min(WAVE_PAIRS, Math.floor(frame.waveform.length / 2));
  const waveMean = mean(frame.waveform, waveLen * 2) * 1.6;
  const specMean = mean(frame.spectrum, frame.spectrum.length) * 1.6;
  const useWave = source === "wave" || (source === "adaptive" && waveMean > specMean);

  const length = useWave ? waveLen : frame.spectrum.length;
  if (length <= 0) return { values, useWave };

  for (let i = 0; i < BANDS; i++) {
    const at = Math.round((i / (BANDS - 1 || 1)) * (length - 1));
    const raw = useWave
      ? Math.abs(frame.waveform[at * 2] ?? 0) + Math.abs(frame.waveform[at * 2 + 1] ?? 0)
      : (frame.spectrum[Math.min(at, SPECTRUM_BINS - 1)] ?? 0);
    values[i] = Math.min(1, Math.max(0, useWave ? raw * 0.5 : raw));
  }
  return { values, useWave };
}

function mean(values: ArrayLike<number>, count: number): number {
  const n = Math.min(count, values.length);
  if (n <= 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(values[i] ?? 0);
  return sum / n;
}

/** 线性幅度 → dB 文本。 */
export function formatDb(value: number): string {
  if (value <= 1e-5) return "-∞ dB";
  const db = 20 * Math.log10(value);
  return `${db >= 0 ? "+" : ""}${db.toFixed(1)} dB`;
}
