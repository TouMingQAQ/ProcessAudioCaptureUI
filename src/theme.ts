/**
 * 主题系统。
 *
 * 一套主题 = 一份色板（`Palette`），色板里的每个字段都会变成一个 CSS 变量
 * `--ui-<kebab-case>`，页面样式全部读这些变量，所以换主题只是重写一批变量，
 * 不用动任何布局。主界面的波形 / 频谱画布拿不到 CSS 变量，改由 [`canvasColors`]
 * 直接从色板取色，而且固定用亮色那一份。
 *
 * 深色模式（`light` / `dark` / `system`）只作用于**应用主题**；悬浮球不吃明暗 ——
 * 它是悬在桌面上的一个小球，跟着系统一起变暗只会更难看清。
 *
 * 悬浮球这一侧刻意拆成三件互不相干的事：
 *
 * * **配色**（本文件）—— 用户自己排的一串**色槽**，样式按需往下取，不够就复用
 *   最后一槽（见 [`slotColor`]）；外发光、球芯这些由色槽派生，用户不用逐个配；
 * * **律动样式**（`ball-style.ts`）—— 只管小球长什么样、读哪一份数据，里面一个
 *   颜色都不写；还分**内圈 / 外圈**两层，各选一个叠加，各绑各的数据源；
 * * **尺寸与律动缩放**（`ball-pulse.ts`）—— 只管多大，以及"跟着音乐点头"的幅度。
 *
 * 三者自由组合：换配色不会改形状，换形状也不会动到颜色。
 */

import { ballStyleById, resolveDataSource } from "./ball-style";

export {
  BALL_STYLES,
  BALL_INNER_STYLES,
  BALL_OUTER_STYLES,
  BALL_DATA_SOURCES,
  DEFAULT_BALL_DATA_SOURCE,
  DEFAULT_BALL_INNER_STYLE,
  DEFAULT_BALL_OUTER_STYLE,
  ballStyleById,
  ballStylesOf,
  currentBallInnerStyle,
  currentBallOuterStyle,
  currentBallInnerSource,
  currentBallOuterSource,
  resolveDataSource,
} from "./ball-style";
export type { BallDataSource, BallLayer, BallStyle } from "./ball-style";

/* ------------------------------------------------------------------ 类型 */

export type ThemeMode = "light" | "dark" | "system";
export type Appearance = "light" | "dark";

/** 双语名称，跟着语言设置走。 */
export interface Bi {
  zh: string;
  en: string;
}

/** 应用界面色板。字段名即 CSS 变量名（`--ui-` + 短横线形式）。 */
export interface Palette {
  /** 页面背景：可以是纯色，也可以是渐变。 */
  bg: string;
  /** 卡片描边（亮色主题下是"白色内发光边"）。 */
  cardBorder: string;
  /** 面板底色（可能半透明）。 */
  surface: string;
  /** 实心卡片底色。 */
  surfaceSolid: string;
  /** 次级面板底色（列表项、日志框）。 */
  surfaceSoft: string;
  /** 输入框 / 分段控件底色。 */
  field: string;
  text: string;
  textDim: string;
  textFaint: string;
  /** 强调色与渐变副色。 */
  accent: string;
  accent2: string;
  /** 压强调色渐变的文字色：白，强调色太浅时自动换成中性深色。 */
  accentInk: string;
  /** 压「危险色 → 强调色」渐变的文字色（停止采集这类按钮）。 */
  dangerInk: string;
  line: string;
  lineStrong: string;
  ok: string;
  okSoft: string;
  warn: string;
  warnSoft: string;
  danger: string;
  dangerSoft: string;
  shadow: string;
  vizGrid: string;
  vizWaveA: string;
  vizWaveB: string;
  vizWaveC: string;
  vizSpecA: string;
  vizSpecB: string;
  vizSpecC: string;
  vizPeak: string;
  vizGlow: string;
}

/**
 * 小球绘制用的一组颜色。
 *
 * 用户维护的是一串**有序色槽**（`slots`），样式按自己的需要往下取：不够就复用最后一槽
 * （见 [`slotColor`]）。`halo` / `core` / `pulse` 这些是由色槽算出来的派生色，给绘制
 * 代码与 CSS 用，用户不必逐个去配 —— 换一个主色，整颗球跟着换。
 */
export interface OrbColors {
  /** 用户自定义色槽（有序，至少一个）。 */
  slots: string[];
  /** 外发光（径向渐变：中心亮、边缘透明）。 */
  halo: string;
  /** 外发光的中段色。 */
  haloMid: string;
  /** 内层球体的渐变起止色。 */
  core: string;
  coreEdge: string;
  /** 三色渐变（按角度 / 位置 / 圈层插值），供 CSS 装饰用。 */
  barA: string;
  barB: string;
  barC: string;
  /** 中心随音量跳动的圆点。 */
  pulse: string;
  /** 待机时显示的音符颜色。 */
  glyph: string;
  /** 投影。 */
  shadow: string;
}

export interface AppTheme {
  id: string;
  name: Bi;
  light: Palette;
  dark: Palette;
}

/* -------------------------------------------------------------- 颜色工具 */

function parseHex(hex: string): [number, number, number] {
  const text = hex.replace("#", "");
  const full =
    text.length === 3
      ? text
          .split("")
          .map((c) => c + c)
          .join("")
      : text;
  const value = Number.parseInt(full.slice(0, 6), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;
}

/** 两色线性混合，`t = 0` 取 `a`。 */
export function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = parseHex(a);
  const [r2, g2, b2] = parseHex(b);
  return toHex([r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t]);
}

/** 给颜色加透明度。 */
export function alpha(color: string, a: number): string {
  const [r, g, b] = parseHex(color);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** WCAG 相对亮度（0 = 黑，1 = 白）。 */
function luminance(color: string): number {
  const [r, g, b] = parseHex(color);
  const linear = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** 两色的对比度（1 = 完全一样，21 = 黑配白）。 */
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** 压强调色用的中性深色 —— 浅色强调色上白字糊掉时换它。 */
const ACCENT_INK_DARK = "#1b1e24";

/**
 * 挑一个压得住渐变的文字色。
 *
 * 按钮 / 分段控件 / 徽标都是"渐变底 + 白字"，白字并不是万能：强调色浅的主题
 * （樱花 / 马卡龙 / 薄荷 / 北境）白字会糊进底色里。这里取渐变中点按 WCAG 对比度
 * 算一遍，白字达不到 3（UI 控件的最低要求）就换成中性深色。
 */
function inkOn(a: string, b: string): string {
  return contrast(mix(a, b, 0.5), "#ffffff") >= 3 ? "#ffffff" : ACCENT_INK_DARK;
}

/* ---------------------------------------------------------------- 种子 */

/**
 * 一套应用主题只需要给"种子"：背景、卡片、正文、强调色、频谱三色。
 * 描边、次级文字、阴影这些全部由 [`buildPalette`] 推导 —— 主题多起来以后
 * 手写几十个字段既容易写错，也很难保证对比度一致。
 */
interface AppSeed {
  accent: string;
  accent2: string;
  /** 页面背景 [亮色, 暗色]。 */
  bg: [string, string];
  /** 卡片底色 [亮色, 暗色]。 */
  card: [string, string];
  /** 正文色 [亮色, 暗色]。 */
  ink: [string, string];
  /** 频谱三色（低 → 高）；不给就用强调色推一组。 */
  viz?: [string, string, string];
  /** 暗色模式下的频谱三色，不给就沿用 `viz`。 */
  vizDark?: [string, string, string];
}

const SEMANTIC = {
  light: {
    ok: "#1f8a63",
    warn: "#9a6b1f",
    danger: "#c2436a",
  },
  dark: {
    ok: "#5fd2a4",
    warn: "#e2bb7a",
    danger: "#ff8fa8",
  },
};

function buildPalette(seed: AppSeed, appearance: Appearance): Palette {
  const dark = appearance === "dark";
  const bg = seed.bg[dark ? 1 : 0];
  const card = seed.card[dark ? 1 : 0];
  const ink = seed.ink[dark ? 1 : 0];
  const fallbackViz: [string, string, string] = [seed.accent, seed.accent2, seed.accent2];
  const viz = (dark && seed.vizDark) || seed.viz || fallbackViz;
  const semantic = dark ? SEMANTIC.dark : SEMANTIC.light;

  return {
    bg,
    cardBorder: dark ? alpha("#ffffff", 0.07) : alpha(card, 0.95),
    surface: alpha(card, dark ? 0.82 : 0.86),
    surfaceSolid: card,
    surfaceSoft: alpha(card, dark ? 0.6 : 0.7),
    field: card,
    text: ink,
    textDim: mix(ink, card, 0.4),
    textFaint: mix(ink, card, 0.62),
    accent: seed.accent,
    accent2: seed.accent2,
    accentInk: inkOn(seed.accent, seed.accent2),
    line: alpha(seed.accent, dark ? 0.34 : 0.26),
    lineStrong: alpha(seed.accent, dark ? 0.66 : 0.55),
    ok: semantic.ok,
    okSoft: alpha(semantic.ok, dark ? 0.2 : 0.16),
    warn: semantic.warn,
    warnSoft: alpha(semantic.warn, dark ? 0.22 : 0.18),
    danger: semantic.danger,
    dangerSoft: alpha(semantic.danger, dark ? 0.22 : 0.18),
    dangerInk: inkOn(semantic.danger, seed.accent),
    shadow: dark ? "rgba(0, 0, 0, 0.55)" : alpha(seed.accent, 0.16),
    vizGrid: alpha(seed.accent, dark ? 0.26 : 0.2),
    vizWaveA: viz[0],
    vizWaveB: viz[1],
    vizWaveC: viz[2],
    vizSpecA: viz[0],
    vizSpecB: viz[1],
    vizSpecC: viz[2],
    vizPeak: alpha(viz[2], 0.9),
    vizGlow: alpha(viz[2], 0.5),
  };
}

/* ------------------------------------------------------------ 悬浮球配色 */

/** 还没配过颜色时用的那一个。 */
export const DEFAULT_BALL_COLOR = "#66ccff";

/** 色槽上限：再多也用不上，界面与绘制都按它截断。 */
export const MAX_BALL_COLORS = 8;

function isHexColor(value: string): boolean {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim());
}

/** 按槽位取色：越界就复用最后一槽。 */
function pick(slots: string[], index: number): string {
  const at = Math.min(Math.max(Math.round(index), 0), slots.length - 1);
  return slots[at] ?? DEFAULT_BALL_COLOR;
}

/**
 * 收敛用户色槽：丢掉不合法的写法、统一小写、截到 [`MAX_BALL_COLORS`]，并且**至少留一个**。
 *
 * 空数组表示"还没配过"（旧配置升级上来就是这样），这里补成默认色 —— 所以调用方拿到的
 * 结果永远可以直接拿去画。
 */
export function normalizeBallColors(colors: readonly string[] | null | undefined): string[] {
  const cleaned = (colors ?? [])
    .map((color) => color.trim().toLowerCase())
    .filter(isHexColor)
    .slice(0, MAX_BALL_COLORS);
  return cleaned.length > 0 ? cleaned : [DEFAULT_BALL_COLOR];
}

/**
 * 样式要第 `index` 个颜色时调它。
 *
 * 色槽不够就**复用最后一槽** —— 用户只给一个颜色，整套样式照样能画出来，只是变成单色。
 */
export function slotColor(colors: OrbColors, index: number): string {
  return pick(colors.slots, index);
}

/** 三色渐变取色：`t`（0..1）在槽 0 → 1 → 2 之间插值；色槽不足时自然退化成纯色。 */
export function slotRamp(colors: OrbColors, t: number): string {
  const x = Math.min(1, Math.max(0, t));
  const a = pick(colors.slots, 0);
  const b = pick(colors.slots, 1);
  const c = pick(colors.slots, 2);
  return x < 0.5 ? mix(a, b, x * 2) : mix(b, c, (x - 0.5) * 2);
}

/** 色槽 → 绘制配色。派生规则集中在这里：换一个主色，整颗球跟着换。 */
export function orbColorsFrom(colors: readonly string[] | null | undefined): OrbColors {
  const slots = normalizeBallColors(colors);
  const main = pick(slots, 0);
  return {
    slots,
    halo: alpha(main, 0.42),
    haloMid: alpha(pick(slots, 1), 0.24),
    // 球芯是"亮面"：主色往白里提，深色桌面上才不至于糊成一团
    core: mix(main, "#ffffff", 0.74),
    coreEdge: mix(main, "#ffffff", 0.16),
    barA: pick(slots, 0),
    barB: pick(slots, 1),
    barC: pick(slots, 2),
    pulse: pick(slots, slots.length - 1),
    glyph: main,
    shadow: alpha(main, 0.45),
  };
}

/* ------------------------------------------------------------ 应用主题表 */

interface AppSeedEntry extends AppSeed {
  id: string;
  name: Bi;
}

const APP_SEEDS: AppSeedEntry[] = [
  {
    id: "solid",
    name: { zh: "纯色", en: "Solid" },
    accent: "#3f7dff",
    accent2: "#6b9bff",
    // 纯色主题：不铺渐变，卡片也不做玻璃质感，就是一块干净的颜色
    bg: ["#f2f3f5", "#15171c"],
    card: ["#ffffff", "#1d2027"],
    ink: ["#22262e", "#e6e9ef"],
    viz: ["#6ea8ff", "#8f8cf0", "#a99bf0"],
    vizDark: ["#3f6fd8", "#6a63c9", "#8a76d6"],
  },
  {
    id: "macaron",
    name: { zh: "马卡龙", en: "Macaron" },
    accent: "#f0699a",
    accent2: "#b8a4ea",
    bg: ["linear-gradient(160deg, #fff3f8 0%, #fdf7ff 42%, #eef7ff 100%)", "linear-gradient(160deg, #1a1520 0%, #191425 45%, #121820 100%)"],
    card: ["#ffffff", "#241d2b"],
    ink: ["#5a4a5e", "#f0e6f0"],
    viz: ["#9fd4ff", "#c9a9f2", "#ff8fb8"],
    vizDark: ["#6fb4e8", "#a086e0", "#ff8fb8"],
  },
  {
    id: "sakura",
    name: { zh: "樱花", en: "Sakura" },
    accent: "#e8618c",
    accent2: "#f0a5bd",
    bg: ["linear-gradient(160deg, #fff5f7 0%, #fff0f4 100%)", "linear-gradient(160deg, #211519 0%, #1a1116 100%)"],
    card: ["#ffffff", "#2a1c22"],
    ink: ["#4b3540", "#f6e6ec"],
    viz: ["#ffd0dd", "#f7a8c4", "#e8618c"],
    vizDark: ["#b06a86", "#e0819f", "#ff91b4"],
  },
  {
    id: "ocean",
    name: { zh: "深海", en: "Ocean" },
    accent: "#0e86c4",
    accent2: "#3fb6c9",
    bg: ["linear-gradient(160deg, #eef7ff 0%, #e6f4f8 100%)", "linear-gradient(160deg, #0b1620 0%, #0a1a22 100%)"],
    card: ["#ffffff", "#122430"],
    ink: ["#22384a", "#dceaf2"],
    viz: ["#7fd0f0", "#57b8e0", "#2f8fd0"],
    vizDark: ["#2d7fb8", "#3aa8c8", "#4fd6d0"],
  },
  {
    id: "forest",
    name: { zh: "苔原", en: "Forest" },
    accent: "#3f8f5f",
    accent2: "#7fbf6a",
    bg: ["linear-gradient(160deg, #f3f8f2 0%, #eef6ef 100%)", "linear-gradient(160deg, #101a14 0%, #0e1a18 100%)"],
    card: ["#ffffff", "#16241c"],
    ink: ["#2b3a2e", "#dfeee2"],
    viz: ["#a8d98f", "#6cc08a", "#3f9f7f"],
    vizDark: ["#3f7f5f", "#5aa87a", "#7fc98a"],
  },
  {
    id: "sunset",
    name: { zh: "落日", en: "Sunset" },
    accent: "#e8763f",
    accent2: "#e05a7a",
    bg: ["linear-gradient(160deg, #fff5ec 0%, #fff0ef 100%)", "linear-gradient(160deg, #1e1512 0%, #1b121a 100%)"],
    card: ["#ffffff", "#2a1e19"],
    ink: ["#4a352c", "#f6e6dc"],
    viz: ["#ffc98f", "#ff9f72", "#e8608f"],
    vizDark: ["#c07a3f", "#e8845f", "#f06f92"],
  },
  {
    id: "grape",
    name: { zh: "葡萄紫", en: "Grape" },
    accent: "#7b5cd6",
    accent2: "#a86ce0",
    bg: ["linear-gradient(160deg, #f7f3ff 0%, #f3f0ff 100%)", "linear-gradient(160deg, #171326 0%, #141226 100%)"],
    card: ["#ffffff", "#211a33"],
    ink: ["#38304e", "#e8e2f8"],
    viz: ["#b39cf0", "#9b7ae8", "#c07ae0"],
    vizDark: ["#6f5cb8", "#8f6fe0", "#b47ce0"],
  },
  {
    id: "nord",
    name: { zh: "北境", en: "Nord" },
    accent: "#5e81ac",
    accent2: "#88c0d0",
    bg: ["linear-gradient(160deg, #f2f6f9 0%, #edf2f6 100%)", "linear-gradient(160deg, #22272f 0%, #2e3440 100%)"],
    card: ["#ffffff", "#2b3038"],
    ink: ["#2e3440", "#e5e9f0"],
    viz: ["#88c0d0", "#81a1c1", "#5e81ac"],
    vizDark: ["#5e81ac", "#81a1c1", "#88c0d0"],
  },
  {
    id: "solar",
    name: { zh: "日光", en: "Solarized" },
    accent: "#268bd2",
    accent2: "#2aa198",
    bg: ["linear-gradient(160deg, #fdf6e3 0%, #f7f0dc 100%)", "linear-gradient(160deg, #002b36 0%, #00323f 100%)"],
    card: ["#fffbf0", "#073642"],
    ink: ["#586e75", "#eee8d5"],
    viz: ["#859900", "#2aa198", "#268bd2"],
    vizDark: ["#859900", "#2aa198", "#4aa8e0"],
  },
  {
    id: "graphite",
    name: { zh: "石墨", en: "Graphite" },
    accent: "#5a6472",
    accent2: "#8b94a3",
    bg: ["#f4f5f6", "#14161a"],
    card: ["#ffffff", "#1c1f24"],
    ink: ["#2b2f36", "#e4e7ec"],
    viz: ["#b6bec9", "#8b94a3", "#5a6472"],
    vizDark: ["#4a525e", "#6f7a89", "#9aa4b2"],
  },
  {
    id: "neon",
    name: { zh: "霓虹", en: "Neon" },
    accent: "#7a3ff0",
    accent2: "#00b8d4",
    bg: ["linear-gradient(160deg, #f4f0ff 0%, #eefaff 100%)", "linear-gradient(160deg, #0a0a18 0%, #120a1e 100%)"],
    card: ["#ffffff", "#161629"],
    ink: ["#2a2b4a", "#eaeaff"],
    viz: ["#00e5ff", "#7a3ff0", "#ff3fb0"],
    vizDark: ["#22e0ff", "#b46bff", "#ff3fb0"],
  },
  {
    id: "mint",
    name: { zh: "薄荷", en: "Mint" },
    accent: "#1fa88f",
    accent2: "#57c9d8",
    bg: ["linear-gradient(160deg, #eefaf6 0%, #eaf7fb 100%)", "linear-gradient(160deg, #0c1a18 0%, #0b1a20 100%)"],
    card: ["#ffffff", "#132523"],
    ink: ["#24403c", "#dbf0ec"],
    viz: ["#8fe8d0", "#5fd0c0", "#3fb8d0"],
    vizDark: ["#2f8f80", "#3fb8a8", "#5fd0e0"],
  },
];

export const APP_THEMES: AppTheme[] = APP_SEEDS.map(({ id, name, ...seed }) => ({
  id,
  name,
  light: buildPalette(seed, "light"),
  dark: buildPalette(seed, "dark"),
}));

export const DEFAULT_APP_THEME = "solid";

/* -------------------------------------------------------- 悬浮球配色预设 */

export interface BallColorPreset {
  id: string;
  name: Bi;
  /** 三个主色：点一下铺进色槽，之后还能接着改。 */
  colors: [string, string, string];
}

/**
 * 快捷预设 —— 颜色本身由用户自由配（见 `ballColors`），这里只是几组现成的起手式。
 *
 * 每套取的是原来那版"环形频谱三色"，铺进色槽后照样能单独改某一槽。
 */
export const BALL_COLOR_PRESETS: BallColorPreset[] = [
  { id: "solid", name: { zh: "纯色", en: "Solid" }, colors: ["#9fc4ff", "#7f9bf0", "#5f7ce0"] },
  { id: "macaron", name: { zh: "马卡龙", en: "Macaron" }, colors: ["#9fd4ff", "#c9a9f2", "#ff8fb8"] },
  { id: "sakura", name: { zh: "樱花", en: "Sakura" }, colors: ["#ffd0dd", "#f7a8c4", "#e8618c"] },
  { id: "ocean", name: { zh: "深海", en: "Ocean" }, colors: ["#7fd0f0", "#57b8e0", "#2f8fd0"] },
  { id: "forest", name: { zh: "苔原", en: "Forest" }, colors: ["#a8d98f", "#6cc08a", "#3f9f7f"] },
  { id: "sunset", name: { zh: "落日", en: "Sunset" }, colors: ["#ffc98f", "#ff9f72", "#e8608f"] },
  { id: "grape", name: { zh: "葡萄紫", en: "Grape" }, colors: ["#b39cf0", "#9b7ae8", "#c07ae0"] },
  { id: "gold", name: { zh: "流金", en: "Gold" }, colors: ["#ffe6a8", "#f0c46a", "#d09a3c"] },
  { id: "neon", name: { zh: "霓虹", en: "Neon" }, colors: ["#00e5ff", "#7a3ff0", "#ff3fb0"] },
  { id: "graphite", name: { zh: "石墨", en: "Graphite" }, colors: ["#b6bec9", "#8b94a3", "#5a6472"] },
  { id: "mint", name: { zh: "薄荷", en: "Mint" }, colors: ["#8fe8d0", "#5fd0c0", "#3fb8d0"] },
];

/** 按 id 找预设（旧配置里的 `ballTheme` 就是预设 id，升级时用它填色槽）。 */
export function ballPresetById(id: string): BallColorPreset | null {
  return BALL_COLOR_PRESETS.find((preset) => preset.id === id) ?? null;
}

/* ------------------------------------------------------------ 变量应用 */

/**
 * 字段名 → 变量名的一段：`accentInk` → `accent-ink`、`accent2` → `accent-2`。
 *
 * 数字也要断开：`accent2` 若原样拼进去就是 `--ui-accent2`，而样式里写的是
 * `--ui-accent-2`，会静默取不到值、整条 `background` 声明一起失效。
 */
const kebab = (key: string) => key.replace(/[A-Z]|\d+/g, (m) => `-${m.toLowerCase()}`);

/**
 * 把色板摊成 CSS 变量表。
 *
 * 预览卡片也用它：给预览元素设上同一套变量，预览里就能直接写
 * `var(--ui-accent)` 之类的样式 —— 预览和真实界面共用一份 CSS 规则，
 * 不会出现"预览挺好看、套上去不是那样"。
 */
export function paletteStyle(palette: Palette): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(palette)) {
    if (value) out[`--ui-${kebab(key)}`] = value;
  }
  return out;
}

/**
 * 小球配色 → `--ui-orb-*`（悬浮球窗口的光晕、悬停面板装饰、样式卡片预览都读它）。
 *
 * `slots` 本身是数组，不进 CSS —— 它只给画布绘制用。
 */
export function orbStyle(orb: OrbColors): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(orb)) {
    if (key === "slots" || !value) continue;
    out[`--ui-orb-${kebab(key)}`] = value;
  }
  return out;
}

/**
 * 悬浮球悬停面板的色板。
 *
 * 面板不跟着小球一起花：底色与正文固定用中性亮色（悬浮球不吃明暗），只有强调色
 * 取自用户色槽 —— 这样换配色时面板的按钮、焦点圈会跟着变，但读起来仍然清楚。
 */
function ballPanelPalette(orb: OrbColors): Palette {
  const light: [string, string] = ["#ffffff", "#ffffff"];
  return buildPalette(
    {
      accent: slotColor(orb, 0),
      accent2: slotColor(orb, 1),
      bg: light,
      card: light,
      ink: ["#22262e", "#22262e"],
    },
    "light",
  );
}

/** 把变量写进指定元素（默认是 `<html>`）。 */
export function applyVars(target: HTMLElement, vars: Record<string, string>) {
  for (const [key, value] of Object.entries(vars)) target.style.setProperty(key, value);
}

export function appThemeById(id: string): AppTheme {
  return APP_THEMES.find((theme) => theme.id === id) ?? APP_THEMES[0];
}

/** 系统当前是不是深色。 */
export function prefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** 把 `light` / `dark` / `system` 收敛成实际生效的明暗。 */
export function resolveAppearance(mode: ThemeMode): Appearance {
  return mode === "system" ? (prefersDark() ? "dark" : "light") : mode;
}

/**
 * 当前生效的应用主题 —— 只给画布用（见 [`canvasColors`]）。
 *
 * 画布不吃 CSS 变量：那里面只放"当前生效"的那一份配色，而波形 / 频谱固定要**亮色**
 * 那一份，所以这里自己记一个主题 id。初值只是兜底，`applyAppTheme` 一调就会覆盖。
 */
let activeAppTheme: AppTheme = APP_THEMES[0];

/** 应用主题：写变量 + 标记明暗，返回实际生效的明暗（窗口标题栏要用）。 */
export function applyAppTheme(themeId: string, mode: ThemeMode): Appearance {
  const appearance = resolveAppearance(mode);
  const theme = appThemeById(themeId);
  activeAppTheme = theme;
  applyVars(document.documentElement, paletteStyle(theme[appearance]));
  markAppearance(appearance);
  return appearance;
}

/**
 * 悬浮球配色：把用户色槽铺成整套变量（面板 + 小球，形状不归它管，见 [`applyBallLook`]）。
 *
 * 不吃深色模式：色槽只有一份，切浅色 / 深色 / 跟随系统都不动它。写进
 * `<html data-appearance>` 的也一直是 `light`，这样窗口里的原生控件与面板配色一致。
 * 主窗口的明暗不受影响 —— 那是另一个 WebView。
 */
export function applyBallColors(colors: readonly string[]): void {
  const orb = orbColorsFrom(colors);
  applyVars(document.documentElement, {
    ...paletteStyle(ballPanelPalette(orb)),
    ...orbStyle(orb),
  });
  markAppearance("light");
}

/**
 * 落地悬浮球的「律动样式」与两圈各自的数据源。
 *
 * 只写几个 `data-*`，给两边用：
 * * `ball-render.ts` 侧通过 `ball-style.ts` 的 `currentBall*Style()` 读；
 * * `ball.css` 也可以通过 `[data-ball-inner=…]` 给特定样式加待机动画。
 */
export function applyBallLook(
  innerStyleId: string,
  outerStyleId: string,
  innerSource: string,
  outerSource: string,
): void {
  const inner = ballStyleById(innerStyleId, "inner");
  const outer = ballStyleById(outerStyleId, "outer");
  const root = document.documentElement;
  root.dataset.ballInner = inner.id;
  root.dataset.ballOuter = outer.id;
  root.dataset.ballIdleGlyph = inner.idleGlyph;
  root.dataset.ballSlowTransition = String(inner.slowTransition || outer.slowTransition);
  root.dataset.ballInnerSource = resolveDataSource(innerSource, inner.mode);
  root.dataset.ballOuterSource = resolveDataSource(outerSource, outer.mode);
}

function markAppearance(appearance: Appearance) {
  const root = document.documentElement;
  root.dataset.appearance = appearance;
  // 让浏览器原生控件（滚动条、下拉框）跟着走
  root.style.colorScheme = appearance;
}

/**
 * 主界面波形 / 频谱画布要用的颜色。
 *
 * 这两块画布画的是**数据**，不是界面：它们固定取当前应用主题的**亮色**那一份，
 * 深色（含跟随系统）下也不跟着压暗 —— 深色下面板底色本就是深的，"深底 + 亮柱"
 * 已经够清楚，再把柱子一起调暗只会更难看清。换主题时仍然会换（见 `applyAppTheme`），
 * 只是不再跟着明暗走。
 *
 * 唯一跟着明暗走的是参考线 `grid`：它得压在面板底色上，跟着变才不会糊成一片。
 */
export function canvasColors() {
  const light = activeAppTheme.light;
  const surface =
    document.documentElement.dataset.appearance === "dark" ? activeAppTheme.dark : light;
  return {
    grid: surface.vizGrid,
    waveA: light.vizWaveA,
    waveB: light.vizWaveB,
    waveC: light.vizWaveC,
    specA: light.vizSpecA,
    specB: light.vizSpecB,
    specC: light.vizSpecC,
    peak: light.vizPeak,
    glow: light.vizGlow,
  };
}
