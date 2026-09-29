export type BallDataSource = "spectrum" | "wave" | "adaptive" | "level" | "peak";
export type BallLayer = "inner" | "outer";
export interface BallStyle {
  id: string;
  layer: BallLayer;
  mode: BallDataSource;
  colorSlots: number;
  renderer: string;
}

export interface BallStyleLocale {
  zh: string; en: string; hintZh: string; hintEn: string;
}
export interface BallStyleModule {
  style: BallStyle; locale: BallStyleLocale;
  /** Renderer dispatch id owned by this style module. */
  renderer: string;
}
export function defineBallStyle(id: string, layer: BallLayer, mode: BallDataSource, colorSlots: number, locale: BallStyleLocale, renderer = id): BallStyleModule {
  return { style: { id, layer, mode, colorSlots, renderer }, locale, renderer };
}
