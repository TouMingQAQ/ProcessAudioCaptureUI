/**
 * 悬浮球「律动样式」。
 *
 * 这里定义的是**小球长什么样、怎么跟着音乐动**，与配色完全无关：
 * 颜色由「悬浮球主题」（`theme.ts` 里的 `BALL_THEMES`）负责，形状由这份样式表负责，
 * 两者自由组合 —— 换配色不用重画形状，换样式也不用重新配一遍色。
 *
 * 每种样式都要说明自己**读哪一种音频数据**（见 `BallDataSource`）：
 * * `spectrum` —— 采集内核的 128 柱对数频谱，适合表现"哪个频段在响"；
 * * `wave` —— 采集内核的 256 组峰谷包络波形，适合表现鼓点与整体起伏；
 * * `adaptive` —— 每帧比较两者，谁更活跃就用谁。
 *
 * 样式只是"一份数据怎么画"的声明；真正的绘制在 `ball-render.ts` 里，
 * 那一份代码同时给悬浮球窗口和设置里的样式卡片预览用，预览与实物不会走样。
 */

/**
 * 小球律动的数据源 —— 也就是"小球读哪一份数据来跳"。
 *
 * 名字与说明都放在 `i18n.ts`（键名 `ballStyle.source.<id>` / `...hint.<id>`），
 * 这里只留 id，顺带当一份"合法取值"的清单。
 */
export type BallDataSource = "spectrum" | "wave" | "adaptive";

export const BALL_DATA_SOURCES: BallDataSource[] = ["spectrum", "wave", "adaptive"];

export const DEFAULT_BALL_DATA_SOURCE: BallDataSource = "adaptive";

/**
 * 样式本体。
 *
 * 名字与说明不写在这里 —— 它们的中英文在 `i18n.ts` 里，键名是
 * `ballStyle.<id>` / `ballStyle.hint.<id>`。一份文案只在一个地方维护，
 * 语言切换时也不会漏掉哪一句。
 */
export interface BallStyle {
  id: string;
  /** 默认跟着哪种数据律动。 */
  mode: BallDataSource;
  /** 这份样式支不支持用频谱驱动（`bars` 这类天生只认频谱）。 */
  spectrum: boolean;
  /** 支不支持用波形驱动。 */
  wave: boolean;
}

/**
 * 六种样式刻意做得互不相似：环形柱、柱状、示波器、粒子、涟漪、激光。
 * 前三种是"看得出来在放什么"，后三种更偏氛围。
 */
export const BALL_STYLES: BallStyle[] = [
  { id: "ring", mode: "spectrum", spectrum: true, wave: true },
  // 柱阵天生是一排频谱柱，喂波形画不出来，所以不吃波形
  { id: "bars", mode: "spectrum", spectrum: true, wave: false },
  { id: "wave", mode: "wave", spectrum: true, wave: true },
  { id: "particles", mode: "spectrum", spectrum: true, wave: true },
  { id: "ripple", mode: "adaptive", spectrum: true, wave: true },
  { id: "laser", mode: "wave", spectrum: true, wave: true },
];

export const DEFAULT_BALL_STYLE = "ring";

/* ---------------------------------------------------------------- 应用 */

export function ballStyleById(id: string): BallStyle {
  return BALL_STYLES.find((style) => style.id === id) ?? BALL_STYLES[0];
}

export function ballDataSourceExists(id: string): boolean {
  return BALL_DATA_SOURCES.includes(id as BallDataSource);
}

/**
 * 这份样式能不能用这个数据源。
 *
 * 不能的话（例如「柱阵」本身就要一排频谱柱）就退回样式自己的默认值，
 * 免得设置文件里留下一个画不出来的组合。
 */
export function supportsSource(style: BallStyle, source: BallDataSource): boolean {
  if (source === "adaptive") return style.spectrum && style.wave;
  return source === "spectrum" ? style.spectrum : style.wave;
}

/** 收敛到"这份样式画得出来"的数据源。 */
export function resolveDataSource(styleId: string, source: string): BallDataSource {
  const style = ballStyleById(styleId);
  const wanted = ballDataSourceExists(source) ? (source as BallDataSource) : style.mode;
  return supportsSource(style, wanted) ? wanted : style.mode;
}

/** 从 <html data-ball-style> 上读当前样式（两个 WebView 共用同一份设置）。 */
export function currentBallStyle(): BallStyle {
  const id = document.documentElement.dataset.ballStyle;
  return ballStyleById(id ?? DEFAULT_BALL_STYLE);
}

export function currentBallDataSource(): BallDataSource {
  const id = document.documentElement.dataset.ballSource;
  return resolveDataSource(
    currentBallStyle().id,
    id ?? DEFAULT_BALL_DATA_SOURCE,
  );
}

/**
 * 每帧先按当前数据源把「频谱柱」整理出来，样式绘制代码就只认一种输入。
 *
 * 两种数据在这里被抹平成同一形状：`bands` 是当帧各位置的能量（0..1），
 * `useWave` 告诉绘制代码这次拿到的是不是波形包络 —— 示波器样式要靠它决定画折线还是画柱子。
 */
export function bandsForFrame(
  frame: { spectrum: ArrayLike<number>; wave: ArrayLike<number> },
  source: BallDataSource,
  count: number,
): { bands: Float32Array; useWave: boolean; level: number } {
  const bands = new Float32Array(count);
  const n = Math.max(1, count);
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

  if (useWave) {
    const m = wave.length;
    for (let i = 0; i < n; i++) {
      const at = m <= 1 ? 0 : Math.round((i / (n - 1 || 1)) * (m - 1));
      bands[i] = Math.min(1, Math.max(0, wave[at] ?? 0));
    }
  } else {
    const m = spec.length;
    for (let i = 0; i < n; i++) {
      const at = m <= 1 ? 0 : Math.round((i / (n - 1 || 1)) * (m - 1));
      bands[i] = Math.min(1, Math.max(0, spec[at] ?? 0));
    }
  }

  return { bands, useWave, level: useWave ? Math.min(1, wen) : Math.min(1, lens) };
}
