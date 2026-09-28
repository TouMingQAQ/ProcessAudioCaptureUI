import { SPECTRUM_BINS, WAVE_BUCKETS, type AudioFrameEvent } from "./api";

/** 处理 canvas 高分屏缩放，对外暴露 CSS 逻辑尺寸。 */
class Surface {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  width = 0;
  height = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法获取 2D 绘图上下文");
    this.ctx = ctx;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  private resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    if (width === this.width && height === this.height) return;

    this.width = width;
    this.height = height;
    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  get context() {
    return this.ctx;
  }

  clear() {
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.ctx.shadowBlur = 0;
  }
}

/** 频谱柱的峰值保持（超过则立即抬升，随后匀速回落）。 */
class PeakHold {
  private readonly values = new Float32Array(SPECTRUM_BINS);
  private readonly velocities = new Float32Array(SPECTRUM_BINS);

  update(spectrum: ArrayLike<number>, decay: number) {
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const target = spectrum[i] ?? 0;
      this.velocities[i] = Math.max(this.velocities[i] - decay, 0);
      if (target >= this.values[i]) {
        this.values[i] = target;
        this.velocities[i] = 0.014;
      } else {
        this.values[i] = Math.max(this.values[i] - this.velocities[i], target);
      }
    }
  }

  reset() {
    this.values.fill(0);
    this.velocities.fill(0);
  }

  at(index: number) {
    return this.values[index] ?? 0;
  }
}

/**
 * 音频可视化器。内部用 requestAnimationFrame 渲染，与事件推送频率解耦，
 * 所以后端以 50fps 推数据时界面依然保持平滑动效。
 */
export class Visualizer {
  private readonly wave: Surface;
  private readonly spectrum: Surface;
  private readonly peaks = new PeakHold();

  /** 后端最新一帧。 */
  private frame: AudioFrameEvent | null = null;
  /** 渲染用插值副本。 */
  private readonly waveSmooth = new Float32Array(WAVE_BUCKETS * 2);
  private readonly specSmooth = new Float32Array(SPECTRUM_BINS);
  private rmsSmooth = 0;
  private peakSmooth = 0;
  private lastFrameAt = 0;
  private rafId = 0;

  /** 每帧回调：用于驱动电平表等 DOM 元素。 */
  onRender: (rms: number, peak: number, stale: boolean) => void = () => {};

  constructor(waveCanvas: HTMLCanvasElement, spectrumCanvas: HTMLCanvasElement) {
    this.wave = new Surface(waveCanvas);
    this.spectrum = new Surface(spectrumCanvas);
    this.loop = this.loop.bind(this);
    this.rafId = requestAnimationFrame(this.loop);
  }

  push(frame: AudioFrameEvent) {
    this.frame = frame;
    this.lastFrameAt = performance.now();
  }

  reset() {
    this.frame = null;
    this.waveSmooth.fill(0);
    this.specSmooth.fill(0);
    this.rmsSmooth = 0;
    this.peakSmooth = 0;
    this.peaks.reset();
  }

  dispose() {
    cancelAnimationFrame(this.rafId);
  }

  private loop() {
    this.rafId = requestAnimationFrame(this.loop);

    const stale = performance.now() - this.lastFrameAt > 400;
    const target = this.frame && !stale ? this.frame : null;

    // 起音快、释放慢，观感更像硬件电平表
    const attack = 0.6;
    const release = 0.18;
    const mix = (current: number, next: number) =>
      next > current ? current + (next - current) * attack : current + (next - current) * release;

    for (let i = 0; i < this.waveSmooth.length; i++) {
      this.waveSmooth[i] = mix(this.waveSmooth[i], target?.waveform[i] ?? 0);
    }
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      this.specSmooth[i] = mix(this.specSmooth[i], target?.spectrum[i] ?? 0);
    }
    this.rmsSmooth = mix(this.rmsSmooth, target?.rms ?? 0);
    this.peakSmooth = mix(this.peakSmooth, target?.peak ?? 0);
    this.peaks.update(this.specSmooth, 0.0035);

    this.drawWave();
    this.drawSpectrum();
    this.onRender(this.rmsSmooth, this.peakSmooth, stale);
  }

  private drawWave() {
    const { context: ctx, width, height } = this.wave;
    this.wave.clear();

    const mid = height / 2;
    const amp = height * 0.46;

    // 中轴线 + 上下参考线
    ctx.strokeStyle = "rgba(148, 163, 184, 0.16)";
    ctx.lineWidth = 1;
    for (const y of [mid * 0.5, mid, mid * 1.5]) {
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(width, Math.round(y) + 0.5);
      ctx.stroke();
    }

    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, "rgba(34, 211, 238, 0.95)");
    gradient.addColorStop(1, "rgba(167, 139, 250, 0.95)");

    const step = width / WAVE_BUCKETS;
    const barWidth = Math.max(step * 0.8, 1);

    ctx.fillStyle = gradient;
    ctx.shadowColor = "rgba(103, 232, 249, 0.5)";
    ctx.shadowBlur = 6;
    ctx.beginPath();
    for (let i = 0; i < WAVE_BUCKETS; i++) {
      const min = this.waveSmooth[i * 2];
      const max = this.waveSmooth[i * 2 + 1];
      const top = mid - max * amp;
      const bottom = mid - min * amp;
      ctx.rect(i * step, top, barWidth, Math.max(bottom - top, 1));
    }
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  private drawSpectrum() {
    const { context: ctx, width, height } = this.spectrum;
    this.spectrum.clear();

    const gap = 2;
    const slot = width / SPECTRUM_BINS;
    const barWidth = Math.max(slot - gap, 1);

    // 横向 dB 参考线
    ctx.strokeStyle = "rgba(148, 163, 184, 0.12)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = Math.round((height / 4) * i) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    const gradient = ctx.createLinearGradient(0, height, 0, 0);
    gradient.addColorStop(0, "rgba(34, 211, 238, 0.85)");
    gradient.addColorStop(0.55, "rgba(56, 189, 248, 0.95)");
    gradient.addColorStop(1, "rgba(167, 139, 250, 1)");

    ctx.fillStyle = gradient;
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const value = Math.pow(this.specSmooth[i], 1.35);
      const barHeight = Math.max(value * (height - 6), 1.5);
      ctx.fillRect(i * slot, height - barHeight, barWidth, barHeight);
    }

    // 峰值保持帽
    ctx.fillStyle = "rgba(226, 232, 240, 0.85)";
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const y = height - this.peaks.at(i) * (height - 6) - 2;
      if (y < -2) continue;
      ctx.fillRect(i * slot, Math.max(y, 0), barWidth, 2);
    }
  }
}

/** 线性幅度 → dB 文本。 */
export function formatDb(value: number): string {
  if (value <= 1e-5) return "-∞ dB";
  const db = 20 * Math.log10(value);
  return `${db >= 0 ? "+" : ""}${db.toFixed(1)} dB`;
}
