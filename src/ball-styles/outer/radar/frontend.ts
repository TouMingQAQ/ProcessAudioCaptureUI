import { alpha, slotColor, slotRamp } from "../../../theme";
import { clamp01 } from "../../helpers";
import type { LayerCtx } from "../../types";

export function draw(ctx: CanvasRenderingContext2D, d: LayerCtx): void {
  ctx.translate(d.center, d.center);
  ctx.scale(d.unit, d.unit);

  // Match the inner VU meter: an upward facing, shallow arc with a warm high zone.
  const start = -Math.PI / 2 - (65 * Math.PI) / 180;
  const end = -Math.PI / 2 + (65 * Math.PI) / 180;
  const innerR = 34;
  const outerR = 42;
  const value = d.live ? clamp01(d.level) : 0.04 + 0.025 * (0.5 + 0.5 * Math.sin(d.time / 1400));

  ctx.lineCap = "round";
  ctx.strokeStyle = alpha(slotColor(d.colors, 0), 0.22);
  ctx.lineWidth = 1.1;
  ctx.beginPath(); ctx.arc(0, 0, innerR, start, end); ctx.stroke();

  const hotAt = 0.76;
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
