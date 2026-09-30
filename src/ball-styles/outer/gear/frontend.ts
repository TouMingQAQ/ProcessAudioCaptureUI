import { slotColor } from "../../../theme";
import { TAU, energy } from "../../helpers";
import type { LayerCtx } from "../../types";

export function draw(ctx: CanvasRenderingContext2D, d: LayerCtx): void {
  ctx.translate(d.center, d.center); ctx.scale(d.unit, d.unit); ctx.rotate(d.time / 7500);
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  for (let i = 0; i < 24; i++) {
    const tip = 36 + energy(d, i, 24) * 7;
    for (const [offset, radius] of [[0, 32], [0.2, 32], [0.2, tip], [0.72, tip], [0.72, 32], [1, 32]]) {
      const a = (i + offset) / 24 * TAU;
      const x = Math.cos(a) * radius, y = Math.sin(a) * radius;
      if (i === 0 && offset === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
  }
  ctx.closePath(); ctx.strokeStyle = slotColor(d.colors, 0); ctx.globalAlpha = 0.95; ctx.stroke();
  ctx.moveTo(28, 0); ctx.arc(0, 0, 28, 0, TAU);
  ctx.fillStyle = slotColor(d.colors, 1); ctx.globalAlpha = 0.15; ctx.fill("evenodd");
  ctx.strokeStyle = slotColor(d.colors, 2); ctx.globalAlpha = 0.85;
  ctx.beginPath(); ctx.arc(0, 0, 28, 0, TAU); ctx.stroke();
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * TAU;
    ctx.beginPath(); ctx.arc(Math.cos(a) * 30, Math.sin(a) * 30, 0.7, 0, TAU); ctx.stroke();
  }
}
