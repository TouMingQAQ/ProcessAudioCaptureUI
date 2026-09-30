import { slotRamp } from "../../../theme";
import { TAU, clamp01, idleBand, lighten } from "../../helpers";
import type { LayerCtx } from "../../types";



export function draw(ctx: CanvasRenderingContext2D, d: LayerCtx) {
  const { center, unit, bands, colors, breathe, live, time } = d;
  const count = bands.length;

  for (let i = 0; i < count; i++) {
    const angle = -Math.PI / 2 + (i / count) * TAU;
    const value = clamp01(live ? (bands[i] ?? 0) : idleBand(i, time));
    const length = (1.5 + value * 15) * unit;
    const inner = 27.5 * unit * breathe;
    const outer = inner + length;

    // 三色按角度插值；超过一半音量再往白里提一点，颜色浅时才不至于糊在背景里
    const base = slotRamp(colors, i / count);
    ctx.globalAlpha = value > 0.55 ? 1 : 0.85;
    ctx.strokeStyle = value > 0.55 ? lighten(base, (value - 0.55) * 0.35) : base;
    ctx.lineWidth = Math.max(1.6, 2.4 * unit);
    ctx.beginPath();
    ctx.moveTo(center + Math.cos(angle) * inner, center + Math.sin(angle) * inner);
    ctx.lineTo(center + Math.cos(angle) * outer, center + Math.sin(angle) * outer);
    ctx.stroke();
  }
}
