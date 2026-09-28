import { SPECTRUM_BINS, type AudioFrameEvent } from "./api";

/** 一圈分成多少根频谱柱。前半圈用正向 bin，后半圈镜像，看起来左右对称。 */
const BARS = 84;
/** 频谱柱的起始半径。 */
const RING_RADIUS = 27.5;
/** 空闲时的呼吸动画幅度。 */
const IDLE_BREATH = 0.5;

/**
 * 悬浮球上的环形音频可视化。
 *
 * 用 requestAnimationFrame 独立渲染，与后端 50fps 的事件推送解耦。
 */
export class OrbVisualizer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly bars = new Float32Array(BARS);
  private raf = 0;
  private size = 0;
  private rms = 0;
  private peak = 0;
  private active = false;
  private lastFrameAt = 0;
  private lastPushAt = 0;

  /** 每帧回调：用来驱动面板上的 DOM 电平条。 */
  onRender: (rms: number, peak: number) => void = () => {};

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法获取 2D 绘图上下文");
    this.ctx = ctx;
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
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
    const half = BARS / 2;
    for (let i = 0; i < BARS; i++) {
      const t = i < half ? i / (half - 1) : (BARS - 1 - i) / (half - 1);
      const bin = Math.min(SPECTRUM_BINS - 1, Math.round(t * (SPECTRUM_BINS - 1)));
      const target = frame.spectrum[bin] ?? 0;
      this.bars[i] += (target - this.bars[i]) * smooth;
    }
    this.rms += (frame.rms - this.rms) * smooth;
    this.peak += (frame.peak - this.peak) * smooth;
  }

  /** 采集停止后让小球慢慢回到待机。 */
  relax() {
    this.active = false;
    this.rms = 0;
    this.peak = 0;
    this.bars.fill(0);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
  }

  private resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const size = Math.max(1, Math.floor(Math.min(rect.width, rect.height)));
    if (size === this.size) return;
    this.size = size;
    this.canvas.width = Math.floor(size * dpr);
    this.canvas.height = Math.floor(size * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private loop() {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const stale = now - this.lastFrameAt > 420;
    this.draw(now, stale);
    this.onRender(stale ? 0 : this.rms, stale ? 0 : this.peak);
  }

  private draw(now: number, stale: boolean) {
    const { ctx, size } = this;
    if (size <= 0) return;
    const center = size / 2;
    const unit = size / 96;

    ctx.clearRect(0, 0, size, size);

    const live = this.active && !stale;
    const rms = live ? this.rms : 0;
    const breathe = 1 + Math.sin(now / 950) * 0.045 * (1 - Math.min(rms * 4, 1));

    // 外发光
    const halo = ctx.createRadialGradient(center, center, size * 0.16, center, center, center);
    halo.addColorStop(0, `rgba(255, 176, 208, ${live ? 0.5 : 0.28})`);
    halo.addColorStop(0.62, "rgba(196, 178, 240, 0.22)");
    halo.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(center, center, center, 0, Math.PI * 2);
    ctx.fill();

    // 内层奶白底
    const discRadius = (RING_RADIUS - 6) * unit * breathe;
    const disc = ctx.createRadialGradient(
      center - discRadius * 0.3,
      center - discRadius * 0.35,
      discRadius * 0.1,
      center,
      center,
      discRadius,
    );
    disc.addColorStop(0, "#ffffff");
    disc.addColorStop(1, "#ffeaf4");
    ctx.fillStyle = disc;
    ctx.beginPath();
    ctx.arc(center, center, discRadius, 0, Math.PI * 2);
    ctx.fill();

    // 环形频谱
    const breathBoost = live ? 0 : IDLE_BREATH;
    for (let i = 0; i < BARS; i++) {
      const angle = -Math.PI / 2 + (i / BARS) * Math.PI * 2;
      const value = Math.min(this.bars[i] + breathBoost * 0.1, 1);
      const length = (1.5 + value * 15) * unit;
      const inner = RING_RADIUS * unit * breathe;
      const outer = inner + length;

      ctx.strokeStyle = barColor(i / BARS, value);
      ctx.lineWidth = Math.max(1.6, 2.4 * unit);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(center + Math.cos(angle) * inner, center + Math.sin(angle) * inner);
      ctx.lineTo(center + Math.cos(angle) * outer, center + Math.sin(angle) * outer);
      ctx.stroke();
    }

    // 中心随音量跳动的小圆
    const pulse = (2.6 + rms * 9) * unit;
    ctx.fillStyle = "rgba(255, 143, 184, 0.9)";
    ctx.beginPath();
    ctx.arc(center, center, pulse, 0, Math.PI * 2);
    ctx.fill();

    if (this.peak > 0.985) {
      ctx.strokeStyle = "rgba(255, 99, 132, 0.85)";
      ctx.lineWidth = Math.max(1.5, 2 * unit);
      ctx.beginPath();
      ctx.arc(center, center, (RING_RADIUS - 4) * unit, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

/** 按角度取一个柔和的马卡龙色：粉 → 紫 → 蓝 → 薄荷 → 粉。 */
function barColor(t: number, value: number): string {
  const hue = 336 - 176 * t;
  const saturation = 72 + value * 18;
  const lightness = 70 + value * 10;
  return `hsl(${hue.toFixed(0)} ${saturation.toFixed(0)}% ${lightness.toFixed(0)}%)`;
}

/** 线性幅度 → dB 文本。 */
export function formatDb(value: number): string {
  if (value <= 1e-5) return "-∞ dB";
  const db = 20 * Math.log10(value);
  return `${db >= 0 ? "+" : ""}${db.toFixed(1)} dB`;
}
