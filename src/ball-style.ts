/**
 * 悬浮球「律动样式」。
 *
 * 这里定义的是**小球长什么样、怎么跟着音乐动**，与配色完全无关：颜色是用户在设置里
 * 排的一串色槽（见 `theme.ts`），形状由这份样式表负责，两者自由组合 —— 换配色不用
 * 重画形状，换样式也不用重新配一遍色。
 *
 * 样式分**内圈**与**外圈**两层：
 * * 内圈画球体里面的东西（球芯、脉冲、粒子、涟漪）；
 * * 外圈画球体外面的东西（环柱、柱阵、示波、激光）。
 *
 * 两层各选一个叠在一起，而且**各绑各的数据源** —— 同一颗球可以"外面跟频谱跳、
 * 里面跟音量呼吸"。
 *
 * 每种样式都要说明三件事：
 * * `layer` —— 属于哪一圈；
 * * `mode` —— 默认跟哪种音频数据（见 `BallDataSource`）；
 * * `colorSlots` —— 这套画法要几个颜色槽。用户给的颜色不够时复用最后一槽
 *   （见 `theme.ts` 的 [`slotColor`]），所以再少的颜色也画得出来。
 *
 * 真正的绘制在 `ball-render.ts` 里，那一份代码同时给悬浮球窗口和设置里的样式卡片
 * 预览用，预览与实物不会走样。
 */

/**
 * 小球律动的数据源 —— 也就是"小球读哪一份数据来跳"。
 *
 * 前三种是**逐位置**的（每根柱子 / 每个采样点各有各的值），后两种是**整帧一个数**：
 * 选了它们，各位置会拿到同一个值 —— 环柱会变成一圈等高的"音量环"，也说得通。
 *
 * 名字与说明都在 `i18n.ts`（键名 `ballStyle.source.<id>` / `...hint.<id>`），
 * 这里只留 id，顺带当一份"合法取值"的清单。
 */
export type BallDataSource = "spectrum" | "wave" | "adaptive" | "level" | "peak";

export const BALL_DATA_SOURCES: BallDataSource[] = [
  "spectrum",
  "wave",
  "adaptive",
  "level",
  "peak",
];

export const DEFAULT_BALL_DATA_SOURCE: BallDataSource = "adaptive";

/** 小球的那两层。 */
export type BallLayer = "inner" | "outer";

/** 样式本体。名字与说明的中英文在 `i18n.ts`（键名 `ballStyle.<id>`）。 */
export interface BallStyle {
  id: string;
  /** 画在球体里层还是外层。 */
  layer: BallLayer;
  /** 默认跟着哪种数据律动。 */
  mode: BallDataSource;
  /** 这套画法要几个颜色槽；用户颜色不够时复用最后一槽。 */
  colorSlots: number;
}

/**
 * 内圈样式：画在球体里面。
 *
 * 「无」是把这一圈整个关掉 —— 只想要外面一圈环柱、球体保持干净时用它。
 */
export const BALL_INNER_STYLES: BallStyle[] = [
  // 球芯：一颗静态的渐变球，什么都不跟，就放在那里
  { id: "core", layer: "inner", mode: "level", colorSlots: 1 },
  // 脉冲：球芯 + 随音量收放的同心圈
  { id: "pulse", layer: "inner", mode: "level", colorSlots: 2 },
  // 粒子：一圈细小光点被音乐推开，安静时轻轻呼吸
  { id: "particles", layer: "inner", mode: "spectrum", colorSlots: 3 },
  // 涟漪：声压一圈圈荡开，响度越大越密越亮
  { id: "ripple", layer: "inner", mode: "level", colorSlots: 3 },
  { id: "none", layer: "inner", mode: "adaptive", colorSlots: 0 },
];

/** 外圈样式：画在球体外面。 */
export const BALL_OUTER_STYLES: BallStyle[] = [
  // 环柱：经典环形频谱，一圈柱子的长度就是各频段的能量
  { id: "ring", layer: "outer", mode: "spectrum", colorSlots: 3 },
  // 柱阵：球体正面一列均衡器柱，低音在左、高音在右
  { id: "bars", layer: "outer", mode: "spectrum", colorSlots: 3 },
  // 示波：把波形卷成一圈，直接描出峰谷包络的起伏
  { id: "wave", layer: "outer", mode: "wave", colorSlots: 2 },
  // 激光：两道细长的激光线扫过球体，鼓点越强转得越快
  { id: "laser", layer: "outer", mode: "wave", colorSlots: 2 },
  { id: "none", layer: "outer", mode: "adaptive", colorSlots: 0 },
];

/** 两圈合起来 —— 遍历界面时用它。 */
export const BALL_STYLES: BallStyle[] = [...BALL_INNER_STYLES, ...BALL_OUTER_STYLES];

export const DEFAULT_BALL_INNER_STYLE = "core";
export const DEFAULT_BALL_OUTER_STYLE = "ring";

/* ---------------------------------------------------------------- 应用 */

/** 某一圈的全部样式。 */
export function ballStylesOf(layer: BallLayer): BallStyle[] {
  return layer === "inner" ? BALL_INNER_STYLES : BALL_OUTER_STYLES;
}

/** 按 id 取样式；认不出来就退回这一圈的第一个。 */
export function ballStyleById(id: string, layer: BallLayer = "outer"): BallStyle {
  const list = ballStylesOf(layer);
  return list.find((style) => style.id === id) ?? list[0];
}

export function ballDataSourceExists(id: string): boolean {
  return BALL_DATA_SOURCES.includes(id as BallDataSource);
}

/**
 * 收敛到一个合法的数据源。
 *
 * 认不出来（配置手改坏了、或旧版本写下的值）就退回样式自己的默认值。
 */
export function resolveDataSource(source: string, fallback: BallDataSource): BallDataSource {
  return ballDataSourceExists(source) ? (source as BallDataSource) : fallback;
}

/** 从 `<html data-ball-inner>` 读内圈样式（两个 WebView 共用同一份设置）。 */
export function currentBallInnerStyle(): BallStyle {
  return ballStyleById(
    document.documentElement.dataset.ballInner ?? DEFAULT_BALL_INNER_STYLE,
    "inner",
  );
}

export function currentBallOuterStyle(): BallStyle {
  return ballStyleById(
    document.documentElement.dataset.ballOuter ?? DEFAULT_BALL_OUTER_STYLE,
    "outer",
  );
}

export function currentBallInnerSource(): BallDataSource {
  const style = currentBallInnerStyle();
  return resolveDataSource(document.documentElement.dataset.ballInnerSource ?? "", style.mode);
}

export function currentBallOuterSource(): BallDataSource {
  const style = currentBallOuterStyle();
  return resolveDataSource(document.documentElement.dataset.ballOuterSource ?? "", style.mode);
}

/**
 * 每帧先按数据源把「各位置的能量」整理出来，绘制代码就只认一种输入。
 *
 * 三种逐位置的数据在这里被抹平成同一形状：`bands` 是当帧各位置的能量（0..1），
 * `useWave` 告诉绘制代码这次拿到的是不是波形包络 —— 示波器样式要靠它决定画折线
 * 还是画柱子。`level` / `peak` 这类整帧数据则把 `bands` 全填成同一个值。
 */
export function bandsForFrame(
  frame: { spectrum: ArrayLike<number>; wave: ArrayLike<number>; rms?: number; peak?: number },
  source: BallDataSource,
  count: number,
): { bands: Float32Array; useWave: boolean; level: number } {
  const n = Math.max(1, count);
  const bands = new Float32Array(n);
  const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

  // 整帧一个数：所有位置拿到同一个值，环柱就成了一圈等高的"音量环"
  if (source === "level" || source === "peak") {
    const value = clamp01(source === "level" ? (frame.rms ?? 0) : (frame.peak ?? 0));
    bands.fill(value);
    return { bands, useWave: false, level: value };
  }

  const spec = frame.spectrum;
  const wave = frame.wave;
  if (spec.length === 0 && wave.length === 0) return { bands, useWave: false, level: 0 };

  const mean = (values: ArrayLike<number>) => {
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[i] ?? 0;
    return values.length > 0 ? sum / values.length : 0;
  };

  const lens = mean(spec) * 1.6;
  const wen = mean(wave) * 1.6;
  const useWave = source === "wave" || (source === "adaptive" && wen > lens);

  const m = useWave ? wave.length : spec.length;
  for (let i = 0; i < n; i++) {
    const at = m <= 1 ? 0 : Math.round((i / (n - 1 || 1)) * (m - 1));
    bands[i] = clamp01(useWave ? (wave[at] ?? 0) : (spec[at] ?? 0));
  }

  return { bands, useWave, level: clamp01(useWave ? wen : lens) };
}
