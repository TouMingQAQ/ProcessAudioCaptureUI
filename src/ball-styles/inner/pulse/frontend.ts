import { slotColor } from "../../../theme";
import { TAU } from "../../helpers";
import type { LayerCtx } from "../../types";

function drawCoreDisc(ctx: CanvasRenderingContext2D, d: LayerCtx) {
  const { center, unit, colors, breathe } = d;
  const radius = 20.5 * unit * breathe;
  const disc = ctx.createRadialGradient(
    center - radius * 0.3,
    center - radius * 0.35,
    radius * 0.1,
    center,
    center,
    radius,
  );
  disc.addColorStop(0, colors.core);
  disc.addColorStop(1, colors.coreEdge);
  ctx.fillStyle = disc;
  ctx.beginPath();
  ctx.arc(center, center, radius, 0, TAU);
  ctx.fill();
}

function drawPulseDot(ctx: CanvasRenderingContext2D, d: LayerCtx, radiusUnits: number, alpha = 1) {
  const { center, unit, colors, level } = d;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = colors.pulse;
  ctx.beginPath();
  ctx.arc(center, center, radiusUnits * unit, 0, TAU);
  ctx.fill();
  if (level > 0.5) {
    ctx.globalAlpha = (level - 0.5) * 0.8;
    ctx.strokeStyle = colors.pulse;
    ctx.lineWidth = Math.max(0.8, 1.2 * unit);
    ctx.beginPath();
    ctx.arc(center, center, (radiusUnits + 4 + level * 6) * unit, 0, TAU);
    ctx.stroke();
  }
}

export function draw(ctx: CanvasRenderingContext2D, d: LayerCtx) {
  drawCoreDisc(ctx, d);
  const { center, unit, colors, level, breathe } = d;

  for (let i = 0; i < 2; i++) {
    const radius = (24 + i * 5 + level * 9) * unit * breathe;
    ctx.globalAlpha = (i === 0 ? 0.55 : 0.3) * (0.35 + level * 0.65);
    ctx.strokeStyle = slotColor(colors, i + 1);
    ctx.lineWidth = Math.max(1.1, (1.2 + level * 1.8) * unit);
    ctx.beginPath();
    ctx.arc(center, center, radius, 0, TAU);
    ctx.stroke();
  }

  drawPulseDot(ctx, d, 2.4 + level * 8);
}
