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

import { bandsForFrame, type BallStyle } from "./ball-style";
import { slotColor, type OrbColors } from "./theme";
import { TAU, clamp01 } from "./ball-styles/helpers";
import type { LayerCtx } from "./ball-styles/types";

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

type DrawCtx = Omit<LayerCtx, "bands" | "useWave">;

const MAX_RENDER_DPR = 1.5;

interface CanvasCache {
  ctx: CanvasRenderingContext2D;
  halo: CanvasGradient | null;
  haloKey: string;
}

const canvasCaches = new WeakMap<HTMLCanvasElement, CanvasCache>();

export function renderOrb(canvas: HTMLCanvasElement, innerStyle: BallStyle, outerStyle: BallStyle, colors: OrbColors, frame: BallFrame, size: number, dpr = 1): void {
  const css = Math.max(1, Math.floor(size));
  const ratio = Math.max(1, Math.min(dpr, MAX_RENDER_DPR));
  const px = Math.floor(css * ratio);
  if (canvas.width !== px || canvas.height !== px) {
    canvas.width = px;
    canvas.height = px;
    canvasCaches.delete(canvas);
  }
  const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
  if (!ctx) return;
  let cache = canvasCaches.get(canvas);
  if (!cache || cache.ctx !== ctx) {
    cache = { ctx, halo: null, haloKey: "" };
    canvasCaches.set(canvas, cache);
  }
  canvas.style.width = `${css}px`;
  canvas.style.height = `${css}px`;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, css, css);
  ctx.save();
  try {
    ctx.lineCap = "round";
    const center = css / 2;
    const unit = css / 96;
    const level = frame.live ? clamp01(frame.level) : 0;
    const shared: DrawCtx = {
      center, unit, size: css, level, live: frame.live, colors, time: frame.time,
      peak: clamp01(frame.peak),
      breathe: 1 + Math.sin(frame.time / 950) * 0.045 * (1 - Math.min(level * 4, 1)),
    };
    const key = `${css}|${colors.halo}|${colors.haloMid}`;
    if (!cache.halo || cache.haloKey !== key) {
      const halo = ctx.createRadialGradient(center, center, css * 0.16, center, center, center);
      halo.addColorStop(0, colors.halo);
      halo.addColorStop(0.62, colors.haloMid);
      halo.addColorStop(1, "rgba(255,255,255,0)");
      cache.halo = halo;
      cache.haloKey = key;
    }
    ctx.fillStyle = cache.halo;
    ctx.beginPath();
    ctx.arc(center, center, center, 0, TAU);
    ctx.fill();
    for (const [style, layer] of [[innerStyle, frame.inner], [outerStyle, frame.outer]] as const) {
      ctx.save();
      try { style.draw(ctx, { ...shared, ...layer }); }
      finally { ctx.restore(); }
    }
    if (frame.peak > 0.985) {
      ctx.strokeStyle = slotColor(colors, 2);
      ctx.lineWidth = Math.max(1.5, 2 * unit);
      ctx.beginPath();
      ctx.arc(center, center, center * 0.94, 0, TAU);
      ctx.stroke();
    }
  } finally { ctx.restore(); }
}

export function renderStylePreview(canvas: HTMLCanvasElement, innerStyle: BallStyle, outerStyle: BallStyle, colors: OrbColors, size: number, dpr = 1): void {
  const spectrum = Array.from({ length: 48 }, (_, i) => (0.9 - i / 47 * 0.55) * (0.72 + 0.28 * Math.sin(i * 0.7)));
  const wave = Array.from({ length: 48 }, (_, i) => Math.abs(Math.sin(i / 47 * Math.PI * 2.4)) * (0.35 + 0.65 * Math.sin(i / 47 * Math.PI)));
  const audio = { spectrum, wave, rms: 0.66, peak: 0.8 };
  renderOrb(canvas, innerStyle, outerStyle, colors, {
    inner: bandsForFrame(audio, innerStyle.mode, 48),
    outer: bandsForFrame(audio, outerStyle.mode, 48),
    level: 0.66, peak: 0, live: true, time: 0,
  }, size, dpr);
}

