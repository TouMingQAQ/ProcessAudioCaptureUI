import { slotColor, slotRamp } from "../../../theme";
import { TAU, clamp01, idleBand } from "../../helpers";
import type { LayerCtx } from "../../types";



export function draw(ctx: CanvasRenderingContext2D, d: LayerCtx) {
  const { center, unit, bands, colors, breathe, live, time, useWave } = d;
  const count = bands.length;
  const base = 24 * unit * breathe;

  ctx.globalAlpha = 1;
  ctx.lineWidth = Math.max(1.4, 1.9 * unit);
  ctx.strokeStyle = slotRamp(colors, 0.5);

  // 波形（单极性包络）在基准线外侧画；整帧数据（音量）则是一圈缓慢起伏的曲线
  ctx.beginPath();
  for (let i = 0; i <= count; i++) {
    const idx = i % count;
    const angle = -Math.PI / 2 + (idx / count) * TAU;
    const value = clamp01(live ? (bands[idx] ?? 0) : idleBand(idx, time));
    const radius = base + value * 16 * unit;
    const x = center + Math.cos(angle) * radius;
    const y = center + Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.stroke();

  ctx.globalAlpha = 0.28;
  ctx.lineWidth = Math.max(1, unit);
  ctx.strokeStyle = slotColor(colors, 1);
  ctx.stroke();

  // 有波形数据时补一条镜像线：正负半周都在，才像示波器
  if (live && useWave) {
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = Math.max(1, 1.2 * unit);
    ctx.beginPath();
    for (let i = 0; i <= count; i++) {
      const idx = i % count;
      const angle = -Math.PI / 2 + (idx / count) * TAU;
      const radius = base - clamp01(bands[idx] ?? 0) * 9 * unit;
      const x = center + Math.cos(angle) * radius;
      const y = center + Math.sin(angle) * radius;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
  }
}
