import { slotColor } from "../../../theme";
import { TAU, energy } from "../../helpers";
import type { LayerCtx } from "../../types";

export function draw(ctx: CanvasRenderingContext2D, d: LayerCtx): void {
  ctx.translate(d.center, d.center); ctx.scale(d.unit, d.unit);
  const count = 72;
  for (let i = 0; i < count; i++) {
    const a = i / count * TAU + d.time / 18000;
    const v = energy(d, i, count);
    const flicker = (Math.sin(d.time / 450 + i * 2.3) + 1) * 0.6;
    const r = 33 + v * 9 + flicker;
    ctx.strokeStyle = slotColor(d.colors, i % 3); ctx.globalAlpha = 0.45 + v * 0.5;
    ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * 28, Math.sin(a) * 28);
    ctx.quadraticCurveTo(Math.cos(a + 0.025) * (r - 3), Math.sin(a + 0.025) * (r - 3), Math.cos(a) * r, Math.sin(a) * r); ctx.stroke();
  }
  ctx.strokeStyle = slotColor(d.colors, 1); ctx.globalAlpha = 0.65; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= 144; i++) {
    const a = i / 144 * TAU + d.time / 18000;
    const r = 30 + energy(d, i % 144, 144) * 6 + Math.sin(a * 12 - d.time / 850) * 1.4;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath(); ctx.stroke();
}
