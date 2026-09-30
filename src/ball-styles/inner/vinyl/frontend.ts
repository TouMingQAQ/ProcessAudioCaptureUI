import { slotColor } from "../../../theme";
import { TAU } from "../../helpers";
import type { LayerCtx } from "../../types";

export function draw(ctx: CanvasRenderingContext2D, d: LayerCtx): void {
  ctx.translate(d.center, d.center);
  ctx.scale(d.unit, d.unit);
  ctx.lineWidth = 0.7;
  ctx.fillStyle = slotColor(d.colors, 0);
  ctx.globalAlpha = 0.22;
  ctx.beginPath(); ctx.arc(0, 0, 21.5, 0, TAU); ctx.fill();
  ctx.globalAlpha = 0.65;
  ctx.strokeStyle = slotColor(d.colors, 0);
  for (let r = 10; r <= 21; r += 2.2) {
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.stroke();
  }
  ctx.save();
  ctx.rotate(d.time / 2400);
  ctx.strokeStyle = slotColor(d.colors, 1);
  ctx.globalAlpha = 0.8;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath(); ctx.arc(0, 0, 13 + i * 3, 0.2, 1.2); ctx.stroke();
  }
  ctx.fillStyle = slotColor(d.colors, 1);
  ctx.beginPath(); ctx.arc(0, 0, 6 + d.level * 2 + Math.sin(d.time / 1000) * 0.25, 0, TAU); ctx.fill();
  ctx.fillStyle = slotColor(d.colors, 2);
  ctx.beginPath(); ctx.arc(3, 0, 1.3, 0, TAU); ctx.fill();
  ctx.restore();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = slotColor(d.colors, 2);
  ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.moveTo(15, -15); ctx.lineTo(13, -3); ctx.lineTo(9, 1); ctx.stroke();
  ctx.fillStyle = slotColor(d.colors, 2);
  ctx.beginPath(); ctx.arc(0, 0, 1.2, 0, TAU); ctx.fill();
}
