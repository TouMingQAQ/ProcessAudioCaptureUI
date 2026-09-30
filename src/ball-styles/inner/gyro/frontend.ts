import { slotColor } from "../../../theme";
import { TAU } from "../../helpers";
import type { LayerCtx } from "../../types";

export function draw(ctx: CanvasRenderingContext2D, d: LayerCtx): void {
  ctx.translate(d.center, d.center);
  ctx.scale(d.unit, d.unit);
  ctx.rotate(d.time / 4200);
  for (let i = 0; i < 3; i++) {
    const tilt = i * TAU / 3 + Math.sin(d.time / 1700 + i) * (0.12 + d.level * 0.3);
    const minor = 6 + d.level * 7 + Math.sin(d.time / 1300 + i) * 0.8;
    ctx.strokeStyle = slotColor(d.colors, i);
    ctx.lineWidth = 1.3;
    ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.ellipse(0, 0, 21, minor, tilt, 0, TAU); ctx.stroke();
    const phase = d.time / 1500 + i * 2;
    const x = Math.cos(phase) * 21, y = Math.sin(phase) * minor;
    ctx.fillStyle = slotColor(d.colors, i);
    ctx.beginPath(); ctx.arc(x * Math.cos(tilt) - y * Math.sin(tilt), x * Math.sin(tilt) + y * Math.cos(tilt), 1.2, 0, TAU); ctx.fill();
  }
  ctx.fillStyle = slotColor(d.colors, 1);
  ctx.beginPath(); ctx.arc(0, 0, 2 + d.level * 2, 0, TAU); ctx.fill();
}
