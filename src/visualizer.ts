import { SPECTRUM_BINS, WAVE_BUCKETS, type AudioFrameEvent } from "./api";
import { canvasColors } from "./theme";

const MAX_RENDER_DPR = 1.5;

/** 处理 canvas 高分屏缩放，对外暴露 CSS 逻辑尺寸。 */
class Surface {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  width = 0;
  height = 0;
  private dpr = 0;
  private revision = 0;

  constructor(canvas: HTMLCanvasElement, onResize: () => void = () => {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
    if (!ctx) throw new Error("无法获取 2D 绘图上下文");
    this.ctx = ctx;
    new ResizeObserver(() => {
      if (this.resize()) onResize();
    }).observe(canvas);
    this.resize();
  }

  private resize(): boolean {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_RENDER_DPR);
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    if (width === this.width && height === this.height && dpr === this.dpr) return false;

    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.revision++;
    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  get context() {
    return this.ctx;
  }

  get cacheRevision() {
    return this.revision;
  }

  clear() {
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.ctx.shadowBlur = 0;
  }
}

/** 峰值帽刷新后先钉住不动的时长（毫秒）。 */
const PEAK_HOLD_MS = 200;
/** 停留结束后每秒下落的量（≈0.55 秒落满量程）。 */
const PEAK_FALL_PER_SEC = 1.8;

/**
 * 频谱柱的峰值帽：短暂停留 + 匀速滑落。
 *
 * 规则是「抬升 → 钉住 0.2 秒 → 匀速落」：新峰值一出现就立刻顶上去并重新计时，
 * 让最高点停一下看得清；停够时长后稳定下落，一直落到当前柱高为止。
 *
 * 早先是「速度越滑越慢」：刷新时给速度 0.014，每帧再减 0.0035，三四帧后速度归零，
 * 帽子就永久挂在那儿不动了 —— 只有等柱子重新涨过它才会被顶走。所以画面里到处是
 * 悬在半空的旧峰值，像一层散不掉的重影。
 *
 * 时长与速度都按**时间**算（而不是按帧数）：帧率上限是可调的，按帧算的话 15fps 时
 * 帽子会挂上两三倍久。
 */
class PeakHold {
  private readonly values = new Float32Array(SPECTRUM_BINS);
  /** 各柱还剩几毫秒停留；峰值每次刷新都重新计时。 */
  private readonly holds = new Float32Array(SPECTRUM_BINS);

  update(spectrum: ArrayLike<number>, dt: number) {
    const fall = PEAK_FALL_PER_SEC * (dt / 1000);
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const target = spectrum[i] ?? 0;
      const value = this.values[i] ?? 0;

      // 只在真的被顶高时重新计时；落回柱高后就一路跟着走，不再一格一格地停
      if (target > value) {
        this.values[i] = target;
        this.holds[i] = PEAK_HOLD_MS;
      } else if (this.holds[i] > 0) {
        this.holds[i] = Math.max(0, this.holds[i] - dt);
      } else {
        this.values[i] = Math.max(value - fall, target);
      }
    }
  }

  reset() {
    this.values.fill(0);
    this.holds.fill(0);
  }

  at(index: number) {
    return this.values[index] ?? 0;
  }
}

/**
 * 音频可视化器。内部用 requestAnimationFrame 渲染，与事件推送频率解耦，
 * 所以后端推数据的节奏可以比绘制慢或快，界面依然平顺。
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
  /** 帧率上限（0 = 不限）。 */
  private frameLimit = 30;
  /** 上一帧的时刻，限帧用。 */
  private lastDrawAt = 0;
  /** 窗口藏起来时整个循环停掉（省电），露出来再接着跑。 */
  private rendering = true;
  /** 是否正在采集；没有采集时只画一帧静态空闲画面。 */
  private active = false;
  /** 是否需要在下一次唤醒时补画一帧。 */
  private needsFrame = true;
  /** 画布颜色取自主题色板（波形 / 频谱固定用亮色那份）；换主题后调 [`refreshTheme`]。 */
  private colors = canvasColors();
  private themeRevision = 0;
  private waveGradient: CanvasGradient | null = null;
  private waveGradientSurfaceRevision = -1;
  private waveGradientThemeRevision = -1;
  private waveGridPath: Path2D | null = null;
  private waveGridSurfaceRevision = -1;
  private spectrumGradient: CanvasGradient | null = null;
  private spectrumGradientSurfaceRevision = -1;
  private spectrumGradientThemeRevision = -1;
  private spectrumGridPath: Path2D | null = null;
  private spectrumGridSurfaceRevision = -1;

  /** 每帧回调：用于驱动电平表等 DOM 元素。 */
  onRender: (rms: number, peak: number, stale: boolean) => void = () => {};

  constructor(waveCanvas: HTMLCanvasElement, spectrumCanvas: HTMLCanvasElement) {
    const wake = () => {
      this.needsFrame = true;
      this.lastDrawAt = 0;
      this.wake();
    };
    this.wave = new Surface(waveCanvas, wake);
    this.spectrum = new Surface(spectrumCanvas, wake);
    this.loop = this.loop.bind(this);
    this.rafId = requestAnimationFrame(this.loop);
  }

  /** 主题变了以后重新取一遍颜色，下一帧就是新配色。 */
  refreshTheme() {
    this.colors = canvasColors();
    this.themeRevision++;
    this.needsFrame = true;
    this.wake();
  }

  /**
   * 帧率上限（0 = 不限）。
   *
   * 只影响绘制：数据照样全收，只是画得没那么勤 —— 满屏 256 根波形柱 + 128 根频谱柱
   * 加上阴影，一帧的绘制成本比一次事件解析高得多。
   */
  setFrameLimit(fps: number) {
    this.frameLimit = Math.max(0, fps);
    if (this.active) this.wake();
  }

  setActive(active: boolean) {
    if (this.active === active) return;
    this.active = active;
    this.needsFrame = true;
    this.lastDrawAt = 0;
    this.wake();
  }

  /** 窗口可见性变化：藏起来就停掉绘制循环，露出来再跑。 */
  setRendering(enabled: boolean) {
    if (this.rendering === enabled) return;
    this.rendering = enabled;
    if (enabled) {
      // 回来时第一帧立刻画，别等下一个间隔
      this.lastDrawAt = 0;
      this.needsFrame = true;
      this.wake();
    } else {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  push(frame: AudioFrameEvent) {
    this.frame = frame;
    this.lastFrameAt = performance.now();
    this.needsFrame = true;
    this.wake();
  }

  reset() {
    this.frame = null;
    this.waveSmooth.fill(0);
    this.specSmooth.fill(0);
    this.rmsSmooth = 0;
    this.peakSmooth = 0;
    this.peaks.reset();
    this.lastDrawAt = 0;
    this.needsFrame = true;
    this.wake();
  }

  dispose() {
    this.rendering = false;
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private wake() {
    if (this.rendering && this.rafId === 0) this.rafId = requestAnimationFrame(this.loop);
  }

  private loop() {
    if (!this.rendering) {
      this.rafId = 0;
      return;
    }
    if (!this.needsFrame && !this.active && this.lastDrawAt !== 0) {
      this.rafId = 0;
      return;
    }
    const now = performance.now();
    const interval = this.frameLimit > 0 ? 1000 / this.frameLimit : 0;
    // 还没到下一帧：这一次 rAF 空转过去。留 0.5ms 余量，免得 33.34 < 33.33 这种
    // 浮点误差把每两帧画成每三帧。
    if (interval > 0 && this.lastDrawAt !== 0 && now - this.lastDrawAt < interval - 0.5) {
      this.rafId = requestAnimationFrame(this.loop);
      return;
    }
    const dt = this.lastDrawAt === 0 ? 16.7 : Math.min(now - this.lastDrawAt, 200);
    this.lastDrawAt = now;

    const stale = now - this.lastFrameAt > 400;
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
    this.peaks.update(this.specSmooth, dt);

    this.drawWave();
    this.drawSpectrum();
    this.onRender(this.rmsSmooth, this.peakSmooth, stale);
    this.needsFrame = false;

    // Active sessions keep a vsync loop. Idle and stale sessions stop after the
    // current frame and are woken by push(), setActive(), theme or resize changes.
    if (this.active && !stale) {
      this.rafId = requestAnimationFrame(this.loop);
    } else {
      this.rafId = 0;
    }
  }

  private drawWave() {
    const { context: ctx, width, height } = this.wave;
    this.wave.clear();

    const mid = height / 2;
    const amp = height * 0.46;

    // 中轴线 + 上下参考线
    if (!this.waveGridPath || this.waveGridSurfaceRevision !== this.wave.cacheRevision) {
      const path = new Path2D();
      for (const y of [mid * 0.5, mid, mid * 1.5]) {
        path.moveTo(0, Math.round(y) + 0.5);
        path.lineTo(width, Math.round(y) + 0.5);
      }
      this.waveGridPath = path;
      this.waveGridSurfaceRevision = this.wave.cacheRevision;
    }
    ctx.strokeStyle = this.colors.grid;
    ctx.lineWidth = 1;
    ctx.stroke(this.waveGridPath);

    if (
      !this.waveGradient ||
      this.waveGradientSurfaceRevision !== this.wave.cacheRevision ||
      this.waveGradientThemeRevision !== this.themeRevision
    ) {
      const gradient = ctx.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, this.colors.waveA);
      gradient.addColorStop(0.55, this.colors.waveB);
      gradient.addColorStop(1, this.colors.waveC);
      this.waveGradient = gradient;
      this.waveGradientSurfaceRevision = this.wave.cacheRevision;
      this.waveGradientThemeRevision = this.themeRevision;
    }

    const step = width / WAVE_BUCKETS;
    const barWidth = Math.max(step * 0.8, 1);

    ctx.fillStyle = this.waveGradient;
    ctx.shadowColor = this.colors.glow;
    ctx.shadowBlur = this.active && this.rmsSmooth > 0.003 ? 6 : 0;
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
    if (
      !this.spectrumGridPath ||
      this.spectrumGridSurfaceRevision !== this.spectrum.cacheRevision
    ) {
      const path = new Path2D();
      for (let i = 1; i < 4; i++) {
        const y = Math.round((height / 4) * i) + 0.5;
        path.moveTo(0, y);
        path.lineTo(width, y);
      }
      this.spectrumGridPath = path;
      this.spectrumGridSurfaceRevision = this.spectrum.cacheRevision;
    }
    ctx.strokeStyle = this.colors.grid;
    ctx.lineWidth = 1;
    ctx.stroke(this.spectrumGridPath);

    if (
      !this.spectrumGradient ||
      this.spectrumGradientSurfaceRevision !== this.spectrum.cacheRevision ||
      this.spectrumGradientThemeRevision !== this.themeRevision
    ) {
      const gradient = ctx.createLinearGradient(0, height, 0, 0);
      gradient.addColorStop(0, this.colors.specA);
      gradient.addColorStop(0.55, this.colors.specB);
      gradient.addColorStop(1, this.colors.specC);
      this.spectrumGradient = gradient;
      this.spectrumGradientSurfaceRevision = this.spectrum.cacheRevision;
      this.spectrumGradientThemeRevision = this.themeRevision;
    }

    ctx.fillStyle = this.spectrumGradient;
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const value = Math.pow(this.specSmooth[i], 1.35);
      const barHeight = Math.max(value * (height - 6), 1.5);
      ctx.fillRect(i * slot, height - barHeight, barWidth, barHeight);
    }

    // 峰值保持帽
    ctx.fillStyle = this.colors.peak;
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
