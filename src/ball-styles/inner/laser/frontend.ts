import { slotColor } from "../../../theme";
import { TAU, clamp01, lighten } from "../../helpers";
import type { LayerCtx } from "../../types";



export function draw(ctx: CanvasRenderingContext2D, d: LayerCtx) {
  const { center, unit, bands, colors, level, live, time } = d;

  let spread = 0;
  for (let i = 0; i < bands.length; i++) spread += live ? (bands[i] ?? 0) : 0;
  spread = bands.length > 0 ? clamp01(spread / bands.length) : 0;

  const speed = 0.0022 + level * 0.006 + spread * 0.004;
  const angle = -Math.PI / 2 + time * speed;
  // 内圈必须收在球芯范围内，避免沿用外圈版本的半径后被画布或其它层裁掉。
  const half = (15 + level * 8) * unit;
  const beamColor = slotColor(colors, 1);

  ctx.save();
  ctx.translate(center, center);
  for (let i = 0; i < 2; i++) {
    const a = angle + i * Math.PI;
    const dx = Math.cos(a) * half;
    const dy = Math.sin(a) * half;
    const beam = ctx.createLinearGradient(-dx, -dy, dx, dy);
    beam.addColorStop(0, "rgba(255, 255, 255, 0)");
    beam.addColorStop(0.5, lighten(beamColor, 0.25));
    beam.addColorStop(1, "rgba(255, 255, 255, 0)");
    // 细长的光束很容易"糊掉"，所以给足不透明度与线宽
    ctx.globalAlpha = 0.92;
    ctx.strokeStyle = beam;
    ctx.lineWidth = Math.max(1.2, (1.4 + level * 2.2) * unit);
    ctx.beginPath();
    ctx.moveTo(-dx, -dy);
    ctx.lineTo(dx, dy);
    ctx.stroke();

    // 顶端的光点，扫到哪亮到哪
    ctx.globalAlpha = 1;
    ctx.fillStyle = lighten(beamColor, 0.35);
    ctx.beginPath();
    ctx.arc(dx, dy, (1.1 + level * 2.1) * unit, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}
