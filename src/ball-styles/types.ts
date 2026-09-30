import type { OrbColors } from "../theme";

export interface LayerCtx {
  center: number;
  unit: number;
  size: number;
  breathe: number;
  level: number;
  peak: number;
  live: boolean;
  colors: OrbColors;
  time: number;
  bands: Float32Array;
  useWave: boolean;
}
export type BallDraw = (ctx: CanvasRenderingContext2D, frame: LayerCtx) => void;
export type BallDataSource = "spectrum" | "wave" | "adaptive" | "level" | "peak";
export type BallLayer = "inner" | "outer";
interface StyleConfig {
  id: string;
  mode: BallDataSource;
  colorSlots: number;
  draw: BallDraw;
  idleGlyph: "visible" | "dim" | "hidden";
  slowTransition: boolean;
}
export type InnerBallStyle = StyleConfig & { layer: "inner" };
export type OuterBallStyle = StyleConfig & { layer: "outer" };
export type BallStyle = InnerBallStyle | OuterBallStyle;

export interface BallStyleLocale {
  zh: string; en: string; hintZh: string; hintEn: string;
}
export interface BallStyleModule {
  style: BallStyle; locale: BallStyleLocale;
}
export function defineBallStyle(id: string, layer: BallLayer, mode: BallDataSource, colorSlots: number, locale: BallStyleLocale, draw: BallDraw, idleGlyph: StyleConfig["idleGlyph"] = "hidden", slowTransition = true): BallStyleModule {
  return { style: { id, layer, mode, colorSlots, draw, idleGlyph, slowTransition }, locale };
}
