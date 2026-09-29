/**
 * 悬浮球窗口里的实时渲染循环。
 *
 * 这里只负责"把一帧音频交给当前样式"：真正的画法在 `ball-render.ts`（纯函数，
 * 设置面板的样式卡片预览用的是同一份）。两者分工明确 —— 这个文件管平滑、空闲衰减、
 * 两圈各自的数据源、显示倍率、尺寸与律动缩放；那个文件管长什么样。
 *
 * 内圈与外圈各有一份平滑后的数据：它们可以跟不同的数据源（比如外面跟频谱、里面跟
 * 音量），所以不能共用一份缓冲。
 */

import { SPECTRUM_BINS, WAVE_PAIRS, type AudioFrameEvent } from "./api";
import {
  ballStyleById,
  currentBallInnerSource,
  currentBallInnerStyle,
  currentBallOuterSource,
  currentBallOuterStyle,
  resolveDataSource,
  type BallDataSource,
  type BallStyle,
} from "./ball-style";
import { renderOrb, type BallFrame } from "./ball-render";
import {
  DEFAULT_BALL_PULSE_ALGORITHM,
  DEFAULT_BALL_PULSE_AMOUNT,
  createPulseState,
  pulseAlgorithmById,
  pulseScale,
  type PulseAlgorithm,
  type PulseState,
} from "./ball-pulse";
import { DEFAULT_BALL_COLOR, orbColorsFrom, type OrbColors } from "./theme";

/** 小球里最多参与绘制的"位置"数：频谱柱与波形采样都重采样到这个长度。 */
const BANDS = 84;

/** 基准尺寸（CSS 像素）：`ballSize` 是相对它的倍率。 */
const BASE_SIZE = 96;

/** 低频能量的取样柱数：对数频谱最前面几柱，鼓点主要落在这里。 */
const LOW_BINS = 8;

/** 小球当前该长什么样 —— 设置一变就整个换掉。 */
export interface OrbLook {
  /** 用户自定义色槽。 */
  colors: string[];
  /** 内圈 / 外圈样式 id。 */
  innerStyle: string;
  outerStyle: string;
  /** 两圈各自的数据源（空串 = 用样式的默认值）。 */
  innerSource: string;
  outerSource: string;
  /** 尺寸倍率（0~3，1 = 基准大小）。 */
  size: number;
  /** 收到数据后的显示倍率（0~5）。 */
  gain: number;
  /** 是否随音频律动缩放。 */
  pulse: boolean;
  /** 缩放算法 id。 */
  algorithm: string;
  /** 缩放幅度倍率（1~3）。 */
  pulseAmount: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export class OrbVisualizer {
  private readonly canvas: HTMLCanvasElement;
  /** 已经平滑过的柱值，内外各一份。 */
  private readonly innerColumns = new Float32Array(BANDS);
  private readonly outerColumns = new Float32Array(BANDS);
  /** 本帧原始柱值的复用缓冲，免得每帧都新建数组。 */
  private readonly scratch = new Float32Array(BANDS);
  private raf = 0;
  private size = BASE_SIZE;
  private rms = 0;
  private peak = 0;
  private low = 0;
  private active = false;
  private lastFrameAt = 0;
  private lastPushAt = 0;
  private lastDrawAt = 0;
  /** 这一层是不是波形包络驱动的（示波样式要靠它决定画不画镜像线）。 */
  private innerWaveDriven = false;
  private outerWaveDriven = false;

  /** 当前外观，改设置时调 [`refreshLook`] 整个换一次。 */
  private innerStyle: BallStyle = currentBallInnerStyle();
  private outerStyle: BallStyle = currentBallOuterStyle();
  private innerSource: BallDataSource = currentBallInnerSource();
  private outerSource: BallDataSource = currentBallOuterSource();
  private colors: OrbColors = orbColorsFrom([DEFAULT_BALL_COLOR]);
  private gain = 1;
  private pulseOn = false;
  private algorithm: PulseAlgorithm = pulseAlgorithmById(DEFAULT_BALL_PULSE_ALGORITHM);
  private pulseAmount = DEFAULT_BALL_PULSE_AMOUNT;
  private pulseState: PulseState = createPulseState();
  /** 上一次写进 `--orb-pulse` 的值，用于跳过无变化的重算。 */
  private pulseValue = 1;

  /** 每帧回调：用来驱动面板上的 DOM 电平条。 */
  onRender: (rms: number, peak: number) => void = () => {};

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  /**
   * 外观变了以后重新读一遍。
   *
   * 全部来自设置（而不是缓存到别处），免得两个 WebView 的说法不一致。尺寸顺手写进
   * `--orb-size`：`.orb` 元素与画布按它一起长大，小球才能在窗口里"变大"而不是只把
   * 内容放大后被裁掉。
   */
  refreshLook(look: OrbLook): void {
    this.colors = orbColorsFrom(look.colors);
    this.innerStyle = ballStyleById(look.innerStyle, "inner");
    this.outerStyle = ballStyleById(look.outerStyle, "outer");
    this.innerSource = resolveDataSource(look.innerSource, this.innerStyle.mode);
    this.outerSource = resolveDataSource(look.outerSource, this.outerStyle.mode);
    this.gain = clamp(look.gain, 0, 5);
    this.algorithm = pulseAlgorithmById(look.algorithm);
    this.pulseAmount = clamp(look.pulseAmount, 1, 3);
    this.pulseOn = look.pulse && this.algorithm.id !== "none";

    // 0 倍不是"消失"，是缩到一个小点：还能看见、还拖得动
    this.size = Math.max(12, Math.round(BASE_SIZE * clamp(look.size, 0, 3)));
    document.documentElement.style.setProperty("--orb-size", `${this.size}px`);
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
    this.innerWaveDriven = fillBands(this.scratch, frame, this.innerSource, this.gain);
    smoothInto(this.innerColumns, this.scratch, smooth);
    this.outerWaveDriven = fillBands(this.scratch, frame, this.outerSource, this.gain);
    smoothInto(this.outerColumns, this.scratch, smooth);

    this.rms += (clamp01(frame.rms * this.gain) - this.rms) * smooth;
    // 峰值不吃显示倍率：它只负责回答"音频是不是真的爆了"，用户把倍率调大不该亮起削顶圈
    this.peak += (clamp01(frame.peak) - this.peak) * smooth;
    this.low += (lowEnergy(frame.spectrum, this.gain) - this.low) * smooth;
  }

  /** 采集停止后让小球慢慢回到待机。 */
  relax() {
    this.active = false;
    this.rms = 0;
    this.peak = 0;
    this.low = 0;
    this.innerWaveDriven = false;
    this.outerWaveDriven = false;
    this.innerColumns.fill(0);
    this.outerColumns.fill(0);
    this.pulseState = createPulseState();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
  }

  private loop() {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const stale = now - this.lastFrameAt > 420;
    this.draw(now, stale);
    this.onRender(stale ? 0 : this.rms, stale ? 0 : this.peak);
  }

  private draw(now: number, stale: boolean) {
    const dt = this.lastDrawAt === 0 ? 16 : now - this.lastDrawAt;
    this.lastDrawAt = now;
    const live = this.active && !stale;

    // 律动缩放交给 CSS：整个球（连外发光一起）在窗口里胀缩。
    // 放在绘制里做的话，外发光用的是画布半径、不会跟着缩，看起来就成了"只有中间那团在动"，
    // 放大之后还会被画布裁掉一圈。
    this.applyPulse(this.nextScale(live, dt));

    const frame: BallFrame = {
      inner: { bands: this.innerColumns, useWave: this.innerWaveDriven },
      outer: { bands: this.outerColumns, useWave: this.outerWaveDriven },
      level: live ? this.rms : 0,
      peak: live ? this.peak : 0,
      live,
      time: now,
    };

    renderOrb(
      this.canvas,
      this.innerStyle,
      this.outerStyle,
      this.colors,
      frame,
      this.size,
      Math.min(window.devicePixelRatio || 1, 2),
    );
  }

  /** 把缩放系数写进 CSS 变量；值没怎么变就不写，省掉一次样式重算。 */
  private applyPulse(scale: number) {
    if (Math.abs(scale - this.pulseValue) < 0.001) return;
    this.pulseValue = scale;
    document.documentElement.style.setProperty("--orb-pulse", scale.toFixed(4));
  }

  /** 推进律动缩放算法，拿到这一帧的缩放系数。 */
  private nextScale(live: boolean, dt: number): number {
    if (!this.pulseOn) {
      // 关掉时把状态清干净：下次打开不会从上次的余振里弹出来
      this.pulseState = createPulseState();
      return 1;
    }
    this.algorithm.step(this.pulseState, {
      rms: live ? this.rms : 0,
      peak: live ? this.peak : 0,
      low: live ? this.low : 0,
      live,
      dt,
    });
    return pulseScale(this.algorithm, this.pulseState, this.pulseAmount);
  }
}

/** 把一批原始值平滑进目标缓冲（起音快、释放慢，观感更像硬件电平表）。 */
function smoothInto(target: Float32Array, raw: Float32Array, smooth: number): void {
  for (let i = 0; i < target.length; i++) {
    target[i] += ((raw[i] ?? 0) - target[i]) * smooth;
  }
}

/**
 * 按数据源把一帧摊成 [`BANDS`] 个位置上的能量，顺带回报"这次用的是不是波形"。
 *
 * * `spectrum` —— 128 柱对数频谱直接重采样，低音在左、高音在右；
 * * `wave` —— 内核给的 256 组 `(min, max)` 峰谷包络先取绝对值，得到"波形振幅"；
 * * `adaptive` —— 每帧比一下两者谁更活跃，谁活跃用谁；
 * * `level` / `peak` —— 整帧一个数，所有位置填同一个值（环柱会变成一圈等高的音量环）。
 *
 * `gain` 是"收到数据后的显示倍率"，乘完之后仍然夹在 0..1 —— 调大只是更快顶到满格。
 */
function fillBands(
  target: Float32Array,
  frame: AudioFrameEvent,
  source: BallDataSource,
  gain: number,
): boolean {
  const n = target.length;

  if (source === "level" || source === "peak") {
    const value = clamp01((source === "level" ? frame.rms : frame.peak) * gain);
    target.fill(value);
    return false;
  }

  const waveLen = Math.min(WAVE_PAIRS, Math.floor(frame.waveform.length / 2));
  const waveMean = mean(frame.waveform, waveLen * 2) * 1.6;
  const specMean = mean(frame.spectrum, frame.spectrum.length) * 1.6;
  const useWave = source === "wave" || (source === "adaptive" && waveMean > specMean);

  const length = useWave ? waveLen : frame.spectrum.length;
  if (length <= 0) {
    target.fill(0);
    return useWave;
  }

  for (let i = 0; i < n; i++) {
    const at = Math.round((i / (n - 1 || 1)) * (length - 1));
    const raw = useWave
      ? Math.abs(frame.waveform[at * 2] ?? 0) + Math.abs(frame.waveform[at * 2 + 1] ?? 0)
      : (frame.spectrum[Math.min(at, SPECTRUM_BINS - 1)] ?? 0);
    target[i] = clamp01((useWave ? raw * 0.5 : raw) * gain);
  }
  return useWave;
}

/** 低频能量（0..1）：对数频谱最前面几柱的均值。 */
function lowEnergy(spectrum: ArrayLike<number>, gain: number): number {
  const n = Math.min(LOW_BINS, spectrum.length);
  if (n <= 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += spectrum[i] ?? 0;
  return clamp01((sum / n) * 1.6 * gain);
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
