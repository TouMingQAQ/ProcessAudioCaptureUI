/**
 * 悬浮球的绘制。
 *
 * 这里是**纯函数**：给一块画布、一份配色、一个样式和一帧音频数据，就画出一张静态图。
 * 两处地方共用它 ——
 * * `orb.ts` 的实时循环（悬浮球窗口），每帧算好 `bands` / `wave` 后调 [`renderOrb`]；
 * * 设置面板里的样式卡片预览（`settings-panel.ts`），拿一份假数据画一次。
 *
 * 所以预览和真实小球永远是同一份代码，不会出现"卡片上好看、放上去不是那样"。
 * 时间由调用方以 `time`（毫秒）传进来，静态预览给 0，实时渲染给 `performance.now()`。
 */

import type { BallDataSource, BallStyle } from "./ball-style";
import { bandsForFrame } from "./ball-style";
import type { OrbPalette } from "./theme";
import { mix } from "./theme";

/** 绘制要用的两种颜色（明暗主题各给一份）。 */
export interface OrbColors {
  /** 外发光（做成径向渐变：中心亮、边缘透明）。 */
  halo: string;
  /** 发光中段。 */
  haloMid: string;
  /** 内层球体的渐变起止色。 */
  core: string;
  coreEdge: string;
  /** 三色渐变（按角度 / 位置 / 圈层插值）。 */
  barA: string;
  barB: string;
  barC: string;
  /** 中心随音量跳动的圆点。 */
  pulse: string;
}

/** 一帧要画的东西。`bands` 已经按当前数据源整理好，绘制代码不必再管是频谱还是波形。 */
export interface BallFrame {
  /** 当前各位置的能量（0..1），按数据源来自频谱或波形包络。 */
  bands: Float32Array;
  /** 这次的数据是不是波形包络（示波器样式要按它决定画折线还是画柱）。 */
  useWave: boolean;
  /** 整帧响度（0..1），空闲时是 0。 */
  level: number;
  /** 峰值电平（0..1），削顶时样式会加一圈警示描边。 */
  peak: number;
  /** 采集是否在跑（`false` 时各样式退回呼吸待机）。 */
  live: boolean;
  /** 动画时间（毫秒）。 */
  time: number;
}

/** 三色按 `t`（0..1）插值。 */
export function paletteAt(t: number, a: string, b: string, c: string): string {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? mix(a, b, x * 2) : mix(b, c, (x - 0.5) * 2);
}

/** 十六进制色才做提亮，主题里写了 rgba 就直接用原色。 */
function lighten(color: string, amount: number): string {
  return color.startsWith("#") ? mix(color, "#ffffff", amount) : color;
}

/** 主题色板 → 绘制用的一组颜色。 */
export function colorsFromPalette(palette: OrbPalette): OrbColors {
  return {
    halo: palette.halo,
    haloMid: palette.haloMid,
    core: palette.core,
    coreEdge: palette.coreEdge,
    barA: palette.barA,
    barB: palette.barB,
    barC: palette.barC,
    pulse: palette.pulse,
  };
}

/** 空闲时柱子的轻微呼吸幅度 —— 没在采集也不是一块死掉的贴图。 */
const IDLE_BREATH = 0.1;

/**
 * 把一帧数据画到画布上。
 *
 * `size` 是逻辑边长（CSS 像素），函数自己按 `dpr` 放大画布分辨率，
 * 调用方只需要保证画布元素本身的 CSS 尺寸就是 `size`。
 */
export function renderOrb(
  canvas: HTMLCanvasElement,
  style: BallStyle,
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
  const level = live ? Math.min(1, Math.max(0, frame.level)) : 0;
  // 待机时缓慢呼吸；有声时呼吸让位给音量，避免"又跳又晃"
  const breathe = 1 + Math.sin(frame.time / 950) * 0.045 * (1 - Math.min(level * 4, 1));

  const c = styleDraw[style.id] ?? styleDraw.ring;
  c(ctx, {
    center,
    unit,
    size: css,
    breathe,
    level,
    peak: Math.min(1, Math.max(0, frame.peak)),
    live,
    useWave: frame.useWave,
    bands: frame.bands,
    colors,
    time: frame.time,
  });

  // 削顶：所有样式都加一圈外描边，防止"输出爆了却看不出来"
  if (frame.peak > 0.985) {
    ctx.strokeStyle = colors.barC;
    ctx.globalAlpha = 1;
    ctx.lineWidth = Math.max(1.5, 2 * unit);
    ctx.beginPath();
    ctx.arc(center, center, center * 0.94, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
}

/** 样式绘制函数的入参，省得每个样式都解构一遍 `BallFrame`。 */
interface DrawCtx {
  center: number;
  unit: number;
  size: number;
  breathe: number;
  level: number;
  peak: number;
  live: boolean;
  useWave: boolean;
  bands: Float32Array;
  colors: OrbColors;
  time: number;
}

/** 环形渐变发光 + 内层球体，前四种样式都以它打底。 */
function drawGlowAndCore(ctx: CanvasRenderingContext2D, d: DrawCtx, withCore = true) {
  const { center, size, colors, unit, breathe } = d;

  const halo = ctx.createRadialGradient(center, center, size * 0.16, center, center, center);
  halo.addColorStop(0, colors.halo);
  halo.addColorStop(0.62, colors.haloMid);
  halo.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.globalAlpha = 1;
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(center, center, center, 0, Math.PI * 2);
  ctx.fill();

  if (!withCore) return;

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
  ctx.arc(center, center, radius, 0, Math.PI * 2);
  ctx.fill();
}

/** 待机柱高：靠序号排一点高低，看起来像"轻轻呼吸"而不是一圈等长的刻度。 */
function idleBand(i: number, time: number): number {
  return (0.5 + 0.5 * Math.sin(time / 760 + i * 0.4)) * IDLE_BREATH;
}

const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ 环柱 */

function drawRing(ctx: CanvasRenderingContext2D, d: DrawCtx) {
  drawGlowAndCore(ctx, d);
  const { center, unit, bands, colors, breathe, live, time } = d;
  const count = bands.length;

  for (let i = 0; i < count; i++) {
    const angle = -Math.PI / 2 + (i / count) * TAU;
    const value = Math.min(1, live ? bands[i] : idleBand(i, time));
    const length = (1.5 + value * 15) * unit;
    const inner = 27.5 * unit * breathe;
    const outer = inner + length;

    // 三色按角度插值；超过一半音量再往白里提一点，暗色主题下才不至于糊在背景里
    const base = paletteAt(i / count, colors.barA, colors.barB, colors.barC);
    ctx.globalAlpha = value > 0.55 ? 1 : 0.85;
    ctx.strokeStyle = value > 0.55 ? lighten(base, (value - 0.55) * 0.35) : base;
    ctx.lineWidth = Math.max(1.6, 2.4 * unit);
    ctx.beginPath();
    ctx.moveTo(center + Math.cos(angle) * inner, center + Math.sin(angle) * inner);
    ctx.lineTo(center + Math.cos(angle) * outer, center + Math.sin(angle) * outer);
    ctx.stroke();
  }

  drawPulseDot(ctx, d, 2.6 + d.level * 9);
}

/* ------------------------------------------------------------------ 柱阵 */

function drawBars(ctx: CanvasRenderingContext2D, d: DrawCtx) {
  drawGlowAndCore(ctx, d);
  const { center, unit, bands, colors, live, time } = d;
  const count = bands.length;
  const span = 32 * unit;
  const width = Math.max(1, (span / count) * 0.62);

  for (let i = 0; i < count; i++) {
    const value = Math.min(1, live ? bands[i] : idleBand(i, time) * 0.8);
    const x = center - span / 2 + ((i + 0.5) / count) * span;
    const height = (1.2 + value * 20) * unit;
    ctx.globalAlpha = 0.55 + value * 0.45;
    ctx.fillStyle = paletteAt(i / count, colors.barA, colors.barB, colors.barC);
    ctx.beginPath();
    ctx.roundRect(x - width / 2, center - height / 2, width, height, width / 2);
    ctx.fill();
  }

  // 中间一条细横线，柱子不会看起来"浮在空中"
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = colors.barB;
  ctx.lineWidth = Math.max(1, unit);
  ctx.beginPath();
  ctx.moveTo(center - span / 2, center);
  ctx.lineTo(center + span / 2, center);
  ctx.stroke();
}

/* ---------------------------------------------------------------- 示波器 */

function drawWave(ctx: CanvasRenderingContext2D, d: DrawCtx) {
  drawGlowAndCore(ctx, d, false);
  const { center, unit, bands, colors, breathe, live, time, useWave } = d;
  const count = bands.length;
  const base = 24 * unit * breathe;

  ctx.globalAlpha = 1;
  ctx.lineWidth = Math.max(1.4, 1.9 * unit);
  ctx.strokeStyle = paletteAt(0.5, colors.barA, colors.barB, colors.barC);

  // 波形（它是单极性的包络）在中心线两侧对称画；频谱则是一圈柱
  ctx.beginPath();
  for (let i = 0; i <= count; i++) {
    const idx = i % count;
    const angle = -Math.PI / 2 + (idx / count) * TAU;
    const value = Math.min(1, live ? bands[idx] : idleBand(idx, time));
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
  ctx.strokeStyle = colors.barC;
  ctx.stroke();

  // 有波形数据时补一条镜像线：正负半周都在，才像示波器
  if (live && useWave) {
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = Math.max(1, 1.2 * unit);
    ctx.strokeStyle = colors.barC;
    ctx.beginPath();
    for (let i = 0; i <= count; i++) {
      const idx = i % count;
      const angle = -Math.PI / 2 + (idx / count) * TAU;
      const radius = base - Math.min(1, bands[idx]) * 9 * unit;
      const x = center + Math.cos(angle) * radius;
      const y = center + Math.sin(angle) * radius;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
  }

  drawPulseDot(ctx, d, 2.2 + d.level * 7);
}

/* ------------------------------------------------------------------ 粒子 */

function drawParticles(ctx: CanvasRenderingContext2D, d: DrawCtx) {
  drawGlowAndCore(ctx, d);
  const { center, unit, bands, colors, live, time } = d;
  const count = bands.length;
  const radius = colors.barB;

  for (let i = 0; i < count; i++) {
    const angle = -Math.PI / 2 + (i / count) * TAU;
    const value = Math.min(1, live ? bands[i] : idleBand(i, time));
    // 每个点有一点自己的相位，整圈才不会像齿轮一样整齐地一起动
    const wobble = 0.8 + 0.2 * Math.sin(time / 520 + i * 1.7);
    const spread = (25 + value * 15) * unit * wobble;
    const dot = (0.9 + value * 2.1) * unit;
    const x = center + Math.cos(angle) * spread;
    const y = center + Math.sin(angle) * spread;

    ctx.globalAlpha = 0.35 + value * 0.65;
    ctx.fillStyle = paletteAt(i / count, colors.barA, colors.barB, colors.barC);
    ctx.beginPath();
    ctx.arc(x, y, dot, 0, TAU);
    ctx.fill();
    if (value > 0.6) {
      ctx.globalAlpha = (value - 0.6) * 1.6;
      ctx.strokeStyle = radius;
      ctx.lineWidth = Math.max(0.6, 0.9 * unit);
      ctx.beginPath();
      ctx.moveTo(center + Math.cos(angle) * 22 * unit, center + Math.sin(angle) * 22 * unit);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
  }
}

/* ------------------------------------------------------------------ 涟漪 */

function drawRipple(ctx: CanvasRenderingContext2D, d: DrawCtx) {
  drawGlowAndCore(ctx, d, false);
  const { center, unit, colors, level, breathe, time, live } = d;

  const rings = 5;
  for (let i = 0; i < rings; i++) {
    // 每圈错开一段时间往外走，响的时候走得更快、圈更亮
    const phase = ((time / (2400 - level * 1300) + i / rings) % 1 + 1) % 1;
    const radius = (10 + phase * 34) * unit * breathe;
    const alpha = (1 - phase) * (live ? 0.25 + level * 0.7 : 0.25);
    ctx.globalAlpha = Math.min(1, Math.max(0, alpha));
    ctx.strokeStyle = paletteAt(phase, colors.barA, colors.barB, colors.barC);
    ctx.lineWidth = Math.max(1.1, (1.5 + level * 2.4) * unit);
    ctx.beginPath();
    ctx.arc(center, center, radius, 0, TAU);
    ctx.stroke();
  }

  drawPulseDot(ctx, d, 2.4 + level * 11);
}

/* ------------------------------------------------------------------ 激光 */

function drawLaser(ctx: CanvasRenderingContext2D, d: DrawCtx) {
  drawGlowAndCore(ctx, d);
  const { center, unit, bands, colors, level, live, time } = d;

  let spread = 0;
  for (let i = 0; i < bands.length; i++) spread += live ? bands[i] : 0;
  spread = bands.length > 0 ? Math.min(1, spread / bands.length) : 0;

  const speed = 0.0022 + level * 0.006 + spread * 0.004;
  const angle = -Math.PI / 2 + time * speed;
  const half = (26 + level * 12) * unit;

  ctx.save();
  ctx.translate(center, center);
  for (let i = 0; i < 2; i++) {
    const a = angle + i * Math.PI;
    const dx = Math.cos(a) * half;
    const dy = Math.sin(a) * half;
    const beam = ctx.createLinearGradient(-dx, -dy, dx, dy);
    beam.addColorStop(0, "rgba(255, 255, 255, 0)");
    beam.addColorStop(0.5, lighten(colors.barC, 0.25));
    beam.addColorStop(1, "rgba(255, 255, 255, 0)");
    // 细长的光束在暗色球体上很容易"糊掉"，所以给足不透明度与线宽
    ctx.globalAlpha = 0.92;
    ctx.strokeStyle = beam;
    ctx.lineWidth = Math.max(1.8, (1.8 + level * 2.6) * unit);
    ctx.beginPath();
    ctx.moveTo(-dx, -dy);
    ctx.lineTo(dx, dy);
    ctx.stroke();

    // 顶端的光点，扫到哪亮到哪
    ctx.globalAlpha = 1;
    ctx.fillStyle = lighten(colors.barC, 0.35);
    ctx.beginPath();
    ctx.arc(dx, dy, (1.5 + level * 2.6) * unit, 0, TAU);
    ctx.fill();
  }
  ctx.restore();

  drawPulseDot(ctx, d, 2.2 + level * 6, 0.9);
}

/* -------------------------------------------------------------- 公用零件 */

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

const styleDraw: Record<string, (ctx: CanvasRenderingContext2D, d: DrawCtx) => void> = {
  ring: drawRing,
  bars: drawBars,
  wave: drawWave,
  particles: drawParticles,
  ripple: drawRipple,
  laser: drawLaser,
};

/* ------------------------------------------------------------------ 预览 */

/** 画一个 `radius` 效果的样式缩略图，供设置里的样式卡片用。 */
export function renderStylePreview(
  canvas: HTMLCanvasElement,
  style: BallStyle,
  colors: OrbColors,
  size: number,
  dpr = 1,
): void {
  const frame = previewFrame(style.mode);
  renderOrb(canvas, style, colors, frame, size, dpr);
}

/** 固定的一帧假数据：预览每次重绘都长一样，不会闪。 */
function previewFrame(source: BallDataSource): BallFrame {
  const count = 48;
  const spectrum = new Array<number>(count);
  const wave = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    const x = i / (count - 1);
    // 频谱：低频高、往高频衰减，带一点起伏
    spectrum[i] = Math.min(1, (0.9 - x * 0.55) * (0.72 + 0.28 * Math.sin(i * 0.7)));
    // 波形：中间是明显的峰，两边收敛
    wave[i] = Math.min(1, Math.abs(Math.sin(x * Math.PI * 2.4)) * (0.35 + 0.65 * Math.sin(x * Math.PI)));
  }

  const useWave = source === "wave";
  const { bands, level } = bandsForFrame({ spectrum, wave }, source === "adaptive" ? "spectrum" : source, count);
  return { bands, useWave, level, peak: 0, live: true, time: 0 };
}
