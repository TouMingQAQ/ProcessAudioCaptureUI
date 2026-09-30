import { slotColor } from "../../../theme";
import { TAU, energy } from "../../helpers";
import type { LayerCtx } from "../../types";

export function draw(ctx: CanvasRenderingContext2D, d: LayerCtx): void {
  ctx.translate(d.center, d.center);
  ctx.scale(d.unit, d.unit);
  ctx.rotate(Math.sin(d.time / 3000) * 0.12);
  ctx.lineWidth = 1;
  for (let i = 0; i < 6; i++) {
    ctx.save(); ctx.rotate(i * TAU / 6);
    const length = 15 + energy(d, i, 6) * 6 + Math.sin(d.time / 1400 + i) * 0.4;
    ctx.beginPath(); ctx.moveTo(0, 2);
    ctx.bezierCurveTo(-9, 8, -7, length, 0, length);
    ctx.bezierCurveTo(7, length, 9, 8, 0, 2);
    ctx.fillStyle = slotColor(d.colors, i % 3); ctx.globalAlpha = 0.22; ctx.fill();
    ctx.strokeStyle = slotColor(d.colors, i % 3); ctx.globalAlpha = 0.9; ctx.stroke();
    ctx.restore();
  }
  ctx.fillStyle = slotColor(d.colors, 2);
  ctx.beginPath(); ctx.arc(0, 0, 2, 0, TAU); ctx.fill();
}
