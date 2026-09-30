import { slotColor } from "../../../theme";
import { TAU, energy } from "../../helpers";
import type { LayerCtx } from "../../types";

export function draw(ctx: CanvasRenderingContext2D, d: LayerCtx): void {
  ctx.translate(d.center, d.center); ctx.scale(d.unit, d.unit);
  ctx.lineWidth = 1.5;
  for (let strand = 0; strand < 2; strand++) {
    ctx.strokeStyle = slotColor(d.colors, strand);
    ctx.globalAlpha = 0.9; ctx.beginPath();
    for (let i = 0; i <= 192; i++) {
      const a = i / 192 * TAU;
      const amplitude = 2.3 + energy(d, i % 192, 192) * 5;
      const r = 35 + Math.sin(a * 6 - d.time / 1100 + strand * Math.PI) * amplitude;
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath(); ctx.stroke();
  }
  ctx.fillStyle = slotColor(d.colors, 2);
  for (let i = 0; i < 12; i++) {
    const a = (i * Math.PI + d.time / 1100) / 6;
    ctx.beginPath(); ctx.arc(Math.cos(a) * 35, Math.sin(a) * 35, 0.85, 0, TAU); ctx.fill();
  }
}
