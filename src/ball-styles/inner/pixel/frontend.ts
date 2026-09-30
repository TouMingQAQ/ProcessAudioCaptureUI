import { slotColor } from "../../../theme";
import { energy } from "../../helpers";
import type { LayerCtx } from "../../types";

export function draw(ctx: CanvasRenderingContext2D, d: LayerCtx): void {
  ctx.translate(d.center, d.center);
  ctx.scale(d.unit, d.unit);
  for (let col = 0; col < 9; col++) {
    const value = energy(d, col, 9);
    for (let row = 0; row < 9; row++) {
      const x = (col - 4) * 4.3, y = (row - 4) * 4.3;
      if (Math.hypot(Math.abs(x) + 1.55, Math.abs(y) + 1.55) > 22) continue;
      const threshold = Math.abs(row - 4) / 5;
      ctx.globalAlpha = threshold <= value ? 0.95 : 0.12;
      if (!d.live) ctx.globalAlpha *= 0.65 + 0.35 * Math.sin(d.time / 1000 + col * 0.5 + row * 0.3) ** 2;
      else if (threshold <= value) ctx.globalAlpha *= 0.85 + 0.15 * Math.sin(d.time / 700 + col * 0.5 + row * 0.3) ** 2;
      ctx.fillStyle = slotColor(d.colors, Math.min(2, Math.floor(Math.abs(row - 4) / 1.5)));
      ctx.fillRect(x - 1.55, y - 1.55, 3.1, 3.1);
    }
  }
}
