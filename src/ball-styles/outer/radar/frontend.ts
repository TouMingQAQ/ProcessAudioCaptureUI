import { alpha, slotColor, slotRamp } from "../../../theme";
import { createEasing, vuDeflection } from "../../helpers";
import type { LayerCtx } from "../../types";

/**
 * 亮弧的缓动：跟内圈 VU 表的针一样，亮区是荡上去 / 落回来的，而不是瞬间跳到位。
 * 状态按画布记，且跟内圈那份各记各的（见 `createEasing`）。
 */
const easeLevel = createEasing();

export function draw(ctx: CanvasRenderingContext2D, d: LayerCtx): void {
  ctx.translate(d.center, d.center);
  ctx.scale(d.unit, d.unit);

  // Match the inner VU meter: same dB scale, upward facing, shallow arc with a warm high zone.
  const start = -Math.PI / 2 - (65 * Math.PI) / 180;
  const end = -Math.PI / 2 + (65 * Math.PI) / 180;
  const innerR = 34;
  const outerR = 42;
  /**
   * 亮弧**跟上去**的快慢（每秒趋近比例，越大越快）。
   *
   * 1 / 这个数 ≈ 时间常数：10 ≈ 0.1 秒。调小 → 亮区追得更慢、更"甩"。
   */
  const LEVEL_ATTACK = 10;
  /** 亮弧**落回来**的快慢（每秒趋近比例）。调小 → 回落更慢，余韵更长。 */
  const LEVEL_RELEASE = 10;
  // 这一帧想让亮区停在哪儿：跟内圈表针走同一份 dB 刻度（`vuDeflection`），两圈才逐点对齐；
  // 待机时在起点附近轻轻游走，别看着像断电了
  const target = d.live ? vuDeflection(d.level) : 0.04 + 0.025 * (0.5 + 0.5 * Math.sin(d.time / 1400));
  // 跟针一样带惯性：按真实帧间隔朝目标缓动（静态预览 time = 0，直接到位）
  const value = easeLevel(ctx.canvas, target, d.time, LEVEL_ATTACK, LEVEL_RELEASE);

  ctx.lineCap = "round";
  ctx.strokeStyle = alpha(slotColor(d.colors, 0), 0.22);
  ctx.lineWidth = 1.1;
  ctx.beginPath(); ctx.arc(0, 0, innerR, start, end); ctx.stroke();

  // 红区起点跟内圈表针用同一个刻度位置：两圈的红线落在同一个响度上
  const hotAt = 0.75;
  ctx.strokeStyle = alpha(slotColor(d.colors, 2), 0.35);
  ctx.lineWidth = 2.1;
  ctx.beginPath(); ctx.arc(0, 0, outerR, start + (end - start) * hotAt, end); ctx.stroke();

  const steps = d.unit < 1.4 ? 18 : 26;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = start + (end - start) * t;
    const major = i % 5 === 0;
    const r0 = outerR - (major ? 4.2 : 2.3);
    ctx.strokeStyle = t >= hotAt ? slotColor(d.colors, 2) : slotRamp(d.colors, t * 0.72);
    ctx.globalAlpha = t >= hotAt ? 0.92 : 0.34 + value * 0.22;
    ctx.lineWidth = major ? 1.05 : 0.7;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    ctx.lineTo(Math.cos(a) * outerR, Math.sin(a) * outerR);
    ctx.stroke();
  }

  // A segmented level arc leaves the inner needle readable while tying both layers together.
  const litEnd = start + (end - start) * value;
  const segments = 18;
  for (let i = 0; i < segments; i++) {
    const a0 = start + (end - start) * (i / segments) + 0.012;
    const a1 = start + (end - start) * ((i + 1) / segments) - 0.012;
    if (a0 >= litEnd) continue;
    ctx.strokeStyle = i / segments >= hotAt ? slotColor(d.colors, 2) : slotColor(d.colors, 1);
    ctx.globalAlpha = 0.28 + 0.62 * Math.min(1, (litEnd - a0) / (end - start) * segments);
    ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.arc(0, 0, innerR, a0, Math.min(a1, litEnd)); ctx.stroke();
  }

  ctx.globalAlpha = 1;
  ctx.lineCap = "butt";
}
