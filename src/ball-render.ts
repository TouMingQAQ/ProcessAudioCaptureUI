/**
 * 悬浮球的绘制。
 *
 * 这里是**纯函数**：给一块画布、内圈 / 外圈两个样式、一份配色和一帧音频数据，就画出
 * 一张静态图。两处地方共用它 ——
 * * `orb.ts` 的实时循环（悬浮球窗口），每帧算好各层的数据后调 [`renderOrb`]；
 * * 设置面板里的样式卡片预览（`settings-panel.ts`），拿一份假数据画一次。
 *
 * 所以预览和真实小球永远是同一份代码，不会出现"卡片上好看、放上去不是那样"。
 * 时间由调用方以 `time`（毫秒）传进来，静态预览给 0，实时渲染给 `performance.now()`。
 *
 * 颜色不写死、也不按"第几个字段"取，而是从 [`OrbColors.slots`] 这串用户色槽里拿
 * （[`slotColor`] / [`slotRamp`]）：样式按自己的需要往下取，用户给的颜色不够就复用
 * 最后一槽 —— 所以只配一个颜色也画得出来，只是整套变成单色。
 */

import type { BallStyle } from "./ball-style";
import { mix, slotColor, slotRamp, type OrbColors } from "./theme";

/** 某一层这一帧要吃的数据。 */
export interface LayerFrame {
  /** 各位置的能量（0..1），已经按这一层的数据源整理好。 */
  bands: Float32Array;
  /** 这次的数据是不是波形包络（示波样式要据此决定画折线还是镜像线）。 */
  useWave: boolean;
}

/** 一帧要画的东西。 */
export interface BallFrame {
  /** 内圈的数据。 */
  inner: LayerFrame;
  /** 外圈的数据。 */
  outer: LayerFrame;
  /** 整帧响度（0..1），空闲时是 0。 */
  level: number;
  /** 峰值电平（0..1），削顶时加一圈警示描边。 */
  peak: number;
  /** 采集是否在跑（`false` 时各样式退回呼吸待机）。 */
  live: boolean;
  /** 动画时间（毫秒）。 */
  time: number;
}

/** 绘制共享的入参。 */
interface DrawCtx {
  center: number;
  unit: number;
  size: number;
  breathe: number;
  level: number;
  peak: number;
  live: boolean;
  colors: OrbColors;
  time: number;
}

/** 单个样式绘制时的入参：共享部分 + 它自己那一层的数据。 */
interface LayerCtx extends DrawCtx {
  bands: Float32Array;
  useWave: boolean;
}

const TAU = Math.PI * 2;

/** 空闲时柱子的轻微呼吸幅度 —— 没在采集也不是一块死掉的贴图。 */
const IDLE_BREATH = 0.1;

/** 十六进制色才做提亮，半透明色就直接用原色。 */
function lighten(color: string, amount: number): string {
  return color.startsWith("#") ? mix(color, "#ffffff", amount) : color;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 待机柱高：靠序号排一点高低，看起来像"轻轻呼吸"而不是一圈等长的刻度。 */
function idleBand(i: number, time: number): number {
  return (0.5 + 0.5 * Math.sin(time / 760 + i * 0.4)) * IDLE_BREATH;
}

/**
 * 把一帧数据画到画布上。
 *
 * `size` 是逻辑边长（CSS 像素），函数自己按 `dpr` 放大画布分辨率，调用方只需要保证
 * 画布元素本身的 CSS 尺寸就是 `size`。
 *
 * 这里**不管**"随音频律动缩放"那件事：那是对整颗球的缩放（外发光也算），交给 CSS 的
 * `--orb-pulse` 去做（见 `orb.ts` 与 `ball.css`）。要是塞进绘制基准里，外发光用的是
 * 画布半径、不跟着缩，看起来就成了"只有中间那团在动"；放大后还会被画布裁掉。
 */
export function renderOrb(
  canvas: HTMLCanvasElement,
  innerStyle: BallStyle,
  outerStyle: BallStyle,
  colors: OrbColors,
  frame: BallFrame,
  size: number,
  dpr = 1,
): void {
  const css = Math.max(1, Math.floor(size));
  const ratio = Math.max(1, Math.min(dpr, 2));
  const px = Math.floor(css * ratio);
  if (canvas.width !== px || canvas.height !== px) {
    canvas.width = px;
    canvas.height = px;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  canvas.style.width = `${css}px`;
  canvas.style.height = `${css}px`;

  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, css, css);
  ctx.save();
  ctx.lineCap = "round";

  const center = css / 2;
  const unit = css / 96;
  const live = frame.live;
  const level = live ? clamp01(frame.level) : 0;
  // 待机时缓慢呼吸；有声时呼吸让位给音量，避免"又跳又晃"
  const breathe = 1 + Math.sin(frame.time / 950) * 0.045 * (1 - Math.min(level * 4, 1));

  const shared: DrawCtx = {
    center,
    unit,
    size: css,
    breathe,
    level,
    peak: clamp01(frame.peak),
    live,
    colors,
    time: frame.time,
  };

  // 外发光是所有样式共用的底子，先铺上
  drawHalo(ctx, shared);

  innerStyleDraw[innerStyle.id]?.(ctx, { ...shared, ...frame.inner });
  outerStyleDraw[outerStyle.id]?.(ctx, { ...shared, ...frame.outer });

  // 削顶：加一圈外描边，防止"输出爆了却看不出来"
  if (frame.peak > 0.985) {
    ctx.strokeStyle = slotColor(colors, 2);
    ctx.globalAlpha = 1;
    ctx.lineWidth = Math.max(1.5, 2 * unit);
    ctx.beginPath();
    ctx.arc(center, center, center * 0.94, 0, TAU);
    ctx.stroke();
  }

  ctx.restore();
}

/* -------------------------------------------------------------- 公用零件 */

/** 环形渐变外发光。 */
function drawHalo(ctx: CanvasRenderingContext2D, d: DrawCtx) {
  const { center, size, colors } = d;
  const halo = ctx.createRadialGradient(center, center, size * 0.16, center, center, center);
  halo.addColorStop(0, colors.halo);
  halo.addColorStop(0.62, colors.haloMid);
  halo.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.globalAlpha = 1;
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(center, center, center, 0, TAU);
  ctx.fill();
}

/** 球芯：一颗带高光的渐变球。 */
function drawCoreDisc(ctx: CanvasRenderingContext2D, d: DrawCtx) {
  const { center, unit, colors, breathe } = d;
  const radius = 20.5 * unit * breathe;
  const disc = ctx.createRadialGradient(
    center - radius * 0.3,
    center - radius * 0.35,
    radius * 0.1,
    center,
    center,
    radius,
  );
  disc.addColorStop(0, colors.core);
  disc.addColorStop(1, colors.coreEdge);
  ctx.fillStyle = disc;
  ctx.beginPath();
  ctx.arc(center, center, radius, 0, TAU);
  ctx.fill();
}

/** 中心随音量跳动的小圆点。 */
function drawPulseDot(ctx: CanvasRenderingContext2D, d: DrawCtx, radiusUnits: number, alpha = 1) {
  const { center, unit, colors, level } = d;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = colors.pulse;
  ctx.beginPath();
  ctx.arc(center, center, radiusUnits * unit, 0, TAU);
  ctx.fill();
  if (level > 0.5) {
    ctx.globalAlpha = (level - 0.5) * 0.8;
    ctx.strokeStyle = colors.pulse;
    ctx.lineWidth = Math.max(0.8, 1.2 * unit);
    ctx.beginPath();
    ctx.arc(center, center, (radiusUnits + 4 + level * 6) * unit, 0, TAU);
    ctx.stroke();
  }
}

/* ---------------------------------------------------------------- 内圈 */

/** 球芯：一颗渐变球 + 一个随响度轻轻起伏的中心点。 */
function drawCore(ctx: CanvasRenderingContext2D, d: LayerCtx) {
  drawCoreDisc(ctx, d);
  drawPulseDot(ctx, d, 1.8 + d.level * 3.4);
}

/** 脉冲：球芯之外再放两圈随音量涨落的同心圈。 */
function drawPulse(ctx: CanvasRenderingContext2D, d: LayerCtx) {
  drawCoreDisc(ctx, d);
  const { center, unit, colors, level, breathe } = d;

  for (let i = 0; i < 2; i++) {
    const radius = (24 + i * 5 + level * 9) * unit * breathe;
    ctx.globalAlpha = (i === 0 ? 0.55 : 0.3) * (0.35 + level * 0.65);
    ctx.strokeStyle = slotColor(colors, i + 1);
    ctx.lineWidth = Math.max(1.1, (1.2 + level * 1.8) * unit);
    ctx.beginPath();
    ctx.arc(center, center, radius, 0, TAU);
    ctx.stroke();
  }

  drawPulseDot(ctx, d, 2.4 + level * 8);
}

/** 粒子：一圈细小光点被音乐推开，安静时轻轻呼吸。 */
function drawParticles(ctx: CanvasRenderingContext2D, d: LayerCtx) {
  drawCoreDisc(ctx, d);
  const { center, unit, bands, colors, live, time } = d;
  const count = bands.length;
  const link = slotColor(colors, 1);

  for (let i = 0; i < count; i++) {
    const angle = -Math.PI / 2 + (i / count) * TAU;
    const value = clamp01(live ? (bands[i] ?? 0) : idleBand(i, time));
    // 每个点有自己的相位，整圈才不会像齿轮一样整齐地一起动
    const wobble = 0.8 + 0.2 * Math.sin(time / 520 + i * 1.7);
    const spread = (25 + value * 15) * unit * wobble;
    const dot = (0.9 + value * 2.1) * unit;
    const x = center + Math.cos(angle) * spread;
    const y = center + Math.sin(angle) * spread;

    ctx.globalAlpha = 0.35 + value * 0.65;
    ctx.fillStyle = slotRamp(colors, i / count);
    ctx.beginPath();
    ctx.arc(x, y, dot, 0, TAU);
    ctx.fill();
    if (value > 0.6) {
      ctx.globalAlpha = (value - 0.6) * 1.6;
      ctx.strokeStyle = link;
      ctx.lineWidth = Math.max(0.6, 0.9 * unit);
      ctx.beginPath();
      ctx.moveTo(center + Math.cos(angle) * 22 * unit, center + Math.sin(angle) * 22 * unit);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
  }
}

/** 涟漪：声压一圈圈荡开，响度越大涟漪越密越亮。 */
function drawRipple(ctx: CanvasRenderingContext2D, d: LayerCtx) {
  const { center, unit, colors, level, breathe, time, live } = d;

  const rings = 5;
  for (let i = 0; i < rings; i++) {
    // 每圈错开一段时间往外走，响的时候走得更快、圈更亮
    const phase = (((time / (2400 - level * 1300) + i / rings) % 1) + 1) % 1;
    const radius = (10 + phase * 34) * unit * breathe;
    const alpha = (1 - phase) * (live ? 0.25 + level * 0.7 : 0.25);
    ctx.globalAlpha = clamp01(alpha);
    ctx.strokeStyle = slotRamp(colors, phase);
    ctx.lineWidth = Math.max(1.1, (1.5 + level * 2.4) * unit);
    ctx.beginPath();
    ctx.arc(center, center, radius, 0, TAU);
    ctx.stroke();
  }
}

/** 空样式：这一圈什么都不画。 */
function drawNothing() {
  /* 故意留空 */
}

/* ---------------------------------------------------------------- 外圈 */

/** 环柱：一圈柱子，长度就是各位置的多少（频谱位就是各频段的能量）。 */
function drawRing(ctx: CanvasRenderingContext2D, d: LayerCtx) {
  const { center, unit, bands, colors, breathe, live, time } = d;
  const count = bands.length;

  for (let i = 0; i < count; i++) {
    const angle = -Math.PI / 2 + (i / count) * TAU;
    const value = clamp01(live ? (bands[i] ?? 0) : idleBand(i, time));
    const length = (1.5 + value * 15) * unit;
    const inner = 27.5 * unit * breathe;
    const outer = inner + length;

    // 三色按角度插值；超过一半音量再往白里提一点，颜色浅时才不至于糊在背景里
    const base = slotRamp(colors, i / count);
    ctx.globalAlpha = value > 0.55 ? 1 : 0.85;
    ctx.strokeStyle = value > 0.55 ? lighten(base, (value - 0.55) * 0.35) : base;
    ctx.lineWidth = Math.max(1.6, 2.4 * unit);
    ctx.beginPath();
    ctx.moveTo(center + Math.cos(angle) * inner, center + Math.sin(angle) * inner);
    ctx.lineTo(center + Math.cos(angle) * outer, center + Math.sin(angle) * outer);
    ctx.stroke();
  }
}

/** 柱阵：球体正面一列柱子，低音在左、高音在右。 */
function drawBars(ctx: CanvasRenderingContext2D, d: LayerCtx) {
  const { center, unit, bands, colors, live, time } = d;
  const count = bands.length;
  const span = 32 * unit;
  const width = Math.max(1, (span / count) * 0.62);

  for (let i = 0; i < count; i++) {
    const value = clamp01(live ? (bands[i] ?? 0) : idleBand(i, time) * 0.8);
    const x = center - span / 2 + ((i + 0.5) / count) * span;
    const height = (1.2 + value * 20) * unit;
    ctx.globalAlpha = 0.55 + value * 0.45;
    ctx.fillStyle = slotRamp(colors, i / count);
    ctx.beginPath();
    ctx.roundRect(x - width / 2, center - height / 2, width, height, width / 2);
    ctx.fill();
  }

  // 中间一条细横线，柱子不会看起来"浮在空中"
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = slotColor(colors, 1);
  ctx.lineWidth = Math.max(1, unit);
  ctx.beginPath();
  ctx.moveTo(center - span / 2, center);
  ctx.lineTo(center + span / 2, center);
  ctx.stroke();
}

/** 示波：把这一层的数据卷成一圈描出来。 */
function drawWave(ctx: CanvasRenderingContext2D, d: LayerCtx) {
  const { center, unit, bands, colors, breathe, live, time, useWave } = d;
  const count = bands.length;
  const base = 24 * unit * breathe;

  ctx.globalAlpha = 1;
  ctx.lineWidth = Math.max(1.4, 1.9 * unit);
  ctx.strokeStyle = slotRamp(colors, 0.5);

  // 波形（单极性包络）在基准线外侧画；整帧数据（音量）则是一圈缓慢起伏的曲线
  ctx.beginPath();
  for (let i = 0; i <= count; i++) {
    const idx = i % count;
    const angle = -Math.PI / 2 + (idx / count) * TAU;
    const value = clamp01(live ? (bands[idx] ?? 0) : idleBand(idx, time));
    const radius = base + value * 16 * unit;
    const x = center + Math.cos(angle) * radius;
    const y = center + Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.stroke();

  ctx.globalAlpha = 0.28;
  ctx.lineWidth = Math.max(1, unit);
  ctx.strokeStyle = slotColor(colors, 1);
  ctx.stroke();

  // 有波形数据时补一条镜像线：正负半周都在，才像示波器
  if (live && useWave) {
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = Math.max(1, 1.2 * unit);
    ctx.beginPath();
    for (let i = 0; i <= count; i++) {
      const idx = i % count;
      const angle = -Math.PI / 2 + (idx / count) * TAU;
      const radius = base - clamp01(bands[idx] ?? 0) * 9 * unit;
      const x = center + Math.cos(angle) * radius;
      const y = center + Math.sin(angle) * radius;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
  }
}

/** 激光：两道细长的光束扫过球体，声越大转得越快、越长。 */
function drawLaser(ctx: CanvasRenderingContext2D, d: LayerCtx) {
  const { center, unit, bands, colors, level, live, time } = d;

  let spread = 0;
  for (let i = 0; i < bands.length; i++) spread += live ? (bands[i] ?? 0) : 0;
  spread = bands.length > 0 ? clamp01(spread / bands.length) : 0;

  const speed = 0.0022 + level * 0.006 + spread * 0.004;
  const angle = -Math.PI / 2 + time * speed;
  const half = (26 + level * 12) * unit;
  const beamColor = slotColor(colors, 1);

  ctx.save();
  ctx.translate(center, center);
  for (let i = 0; i < 2; i++) {
    const a = angle + i * Math.PI;
    const dx = Math.cos(a) * half;
    const dy = Math.sin(a) * half;
    const beam = ctx.createLinearGradient(-dx, -dy, dx, dy);
    beam.addColorStop(0, "rgba(255, 255, 255, 0)");
    beam.addColorStop(0.5, lighten(beamColor, 0.25));
    beam.addColorStop(1, "rgba(255, 255, 255, 0)");
    // 细长的光束很容易"糊掉"，所以给足不透明度与线宽
    ctx.globalAlpha = 0.92;
    ctx.strokeStyle = beam;
    ctx.lineWidth = Math.max(1.8, (1.8 + level * 2.6) * unit);
    ctx.beginPath();
    ctx.moveTo(-dx, -dy);
    ctx.lineTo(dx, dy);
    ctx.stroke();

    // 顶端的光点，扫到哪亮到哪
    ctx.globalAlpha = 1;
    ctx.fillStyle = lighten(beamColor, 0.35);
    ctx.beginPath();
    ctx.arc(dx, dy, (1.5 + level * 2.6) * unit, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

/* ------------------------------------------------------------ 样式分发表 */

const innerStyleDraw: Record<string, (ctx: CanvasRenderingContext2D, d: LayerCtx) => void> = {
  core: drawCore,
  pulse: drawPulse,
  particles: drawParticles,
  ripple: drawRipple,
  none: drawNothing,
};

const outerStyleDraw: Record<string, (ctx: CanvasRenderingContext2D, d: LayerCtx) => void> = {
  ring: drawRing,
  bars: drawBars,
  wave: drawWave,
  laser: drawLaser,
  none: drawNothing,
};

/* ------------------------------------------------------------------ 预览 */

/**
 * 画一张样式缩略图，供设置里的卡片用。
 *
 * 两张卡片（内圈、外圈）都传**当前的那一对样式**，只是把主角换成被预览的那一个 ——
 * 这样看到的就是换成它以后整颗球的样子，而不是"孤零零一层"。
 */
export function renderStylePreview(
  canvas: HTMLCanvasElement,
  innerStyle: BallStyle,
  outerStyle: BallStyle,
  colors: OrbColors,
  size: number,
  dpr = 1,
): void {
  renderOrb(canvas, innerStyle, outerStyle, colors, previewFrame(), size, dpr);
}

/** 固定的一帧假数据：预览每次重绘都长一样，不会闪。 */
function previewFrame(): BallFrame {
  const count = 48;
  const spectrum = new Array<number>(count);
  const wave = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    const x = i / (count - 1);
    // 频谱：低频高、往高频衰减，带一点起伏
    spectrum[i] = Math.min(1, (0.9 - x * 0.55) * (0.72 + 0.28 * Math.sin(i * 0.7)));
    // 波形：中间是明显的峰，两边收敛
    wave[i] = Math.min(
      1,
      Math.abs(Math.sin(x * Math.PI * 2.4)) * (0.35 + 0.65 * Math.sin(x * Math.PI)),
    );
  }

  // 预览一律用频谱那份数据：它起伏最丰富，一眼能看出画法差别
  return {
    inner: { bands: Float32Array.from(spectrum), useWave: false },
    outer: { bands: Float32Array.from(spectrum), useWave: false },
    level: 0.66,
    peak: 0,
    live: true,
    time: 0,
  };
}


