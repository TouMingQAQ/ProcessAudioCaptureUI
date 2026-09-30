import { mix } from "../theme";
import type { LayerCtx } from "./types";

export const TAU = Math.PI * 2;
export const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
export function lighten(color: string, amount: number): string {
  return color.startsWith("#") ? mix(color, "#ffffff", amount) : color;
}
export function idleBand(i: number, time: number): number {
  return (0.5 + 0.5 * Math.sin(time / 760 + i * 0.4)) * 0.1;
}
export function energy(d: LayerCtx, index: number, count: number): number {
  const at = Math.round(index / Math.max(1, count - 1) * Math.max(0, d.bands.length - 1));
  return clamp01(d.live ? (d.bands[at] ?? 0) : idleBand(index, d.time));
}
