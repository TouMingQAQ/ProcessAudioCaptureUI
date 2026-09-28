/**
 * 主题系统。
 *
 * 一套主题 = 一份色板（`Palette`），色板里的每个字段都会变成一个 CSS 变量
 * `--ui-<kebab-case>`，页面样式全部读这些变量，所以换主题只是重写一批变量，
 * 不用动任何布局。画布（波形 / 频谱 / 悬浮球）拿不到 CSS 变量，改用
 * [`paletteStyle`] 里同样的变量名 + [`cssVar`] 读回来，保证两边颜色永远一致。
 *
 * 主题分为「应用主题」与「悬浮球主题」两条线，各自都有亮色 / 暗色两份色板；
 * 具体用哪份由深色模式（`light` / `dark` / `system`）决定。
 *
 * 悬浮球这一侧刻意拆成两件互不相干的事：
 *
 * * **配色**（本文件的 `BALL_THEMES`）—— 只管颜色，不管形状；
 * * **律动样式**（`ball-style.ts` 的 `BALL_STYLES`）—— 只管小球长什么样、跟着
 *   频谱还是波形动，里面一个颜色都不写。
 *
 * 两者自由组合，换样式不会动到配色，换配色也不会改形状。
 */

import {
  DEFAULT_BALL_STYLE,
  ballStyleById,
  resolveDataSource,
  type BallStyle,
} from "./ball-style";

export {
  BALL_STYLES,
  BALL_DATA_SOURCES,
  DEFAULT_BALL_DATA_SOURCE,
  DEFAULT_BALL_STYLE,
  ballStyleById,
  currentBallDataSource,
  currentBallStyle,
  resolveDataSource,
} from "./ball-style";
export type { BallDataSource, BallStyle } from "./ball-style";

/** 兜底：还没套过样式时也能画出一颗球（`DEFAULT_BALL_STYLE` 一定在表里）。 */
export const FALLBACK_BALL_STYLE: BallStyle = ballStyleById(DEFAULT_BALL_STYLE);

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
  /** 强调色上的文字色。 */
  accentInk: string;
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

/** 悬浮球小球的配色。形状由「律动样式」决定，这里只有颜色。 */
export interface OrbPalette {
  /** 外发光（径向渐变的起点色）。 */
  halo: string;
  /** 外发光的中段色。 */
  haloMid: string;
  /** 内层球体的渐变两色。 */
  core: string;
  coreEdge: string;
  /** 三色渐变（按角度 / 位置 / 圈层插值）。 */
  barA: string;
  barB: string;
  barC: string;
  /** 中心随音量跳动的圆点。 */
  pulse: string;
  /** 待机时显示的音符颜色。 */
  glyph: string;
  shadow: string;
}

export interface BallSkin {
  panel: Palette;
  orb: OrbPalette;
}

export interface AppTheme {
  id: string;
  name: Bi;
  light: Palette;
  dark: Palette;
}

export interface BallTheme {
  id: string;
  name: Bi;
  light: BallSkin;
  dark: BallSkin;
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
    accentInk: "#ffffff",
    line: alpha(seed.accent, dark ? 0.34 : 0.26),
    lineStrong: alpha(seed.accent, dark ? 0.66 : 0.55),
    ok: semantic.ok,
    okSoft: alpha(semantic.ok, dark ? 0.2 : 0.16),
    warn: semantic.warn,
    warnSoft: alpha(semantic.warn, dark ? 0.22 : 0.18),
    danger: semantic.danger,
    dangerSoft: alpha(semantic.danger, dark ? 0.22 : 0.18),
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

interface BallSeed {
  /** 面板底色 [亮, 暗]。 */
  panel: [string, string];
  /** 面板正文 [亮, 暗]。 */
  ink: [string, string];
  accent: string;
  accent2: string;
  /** 环形频谱三色（亮色模式）。 */
  bars: [string, string, string];
  barsDark?: [string, string, string];
  /** 内层球体渐变两色（亮色模式）。 */
  core: [string, string];
  coreDark?: [string, string];
  /** 外发光起点色（亮色模式）。 */
  halo: string;
  haloDark?: string;
  glyph: string;
}

function buildBallSkin(seed: BallSeed, appearance: Appearance): BallSkin {
  const dark = appearance === "dark";
  const bars = dark && seed.barsDark ? seed.barsDark : seed.bars;
  const core = dark && seed.coreDark ? seed.coreDark : seed.core;
  const halo = dark && seed.haloDark ? seed.haloDark : seed.halo;

  return {
    // 面板其实就是一套小色板：骨架复用 buildPalette，省得再维护一份描边 / 次级文字
    panel: buildPalette(
      {
        accent: seed.accent,
        accent2: seed.accent2,
        bg: seed.panel,
        card: seed.panel,
        ink: seed.ink,
      },
      appearance,
    ),
    orb: {
      halo: alpha(halo, dark ? 0.55 : 0.42),
      haloMid: alpha(seed.accent2, dark ? 0.3 : 0.24),
      core: core[0],
      coreEdge: core[1],
      barA: bars[0],
      barB: bars[1],
      barC: bars[2],
      pulse: seed.accent,
      glyph: seed.glyph,
      shadow: dark ? "rgba(0, 0, 0, 0.6)" : alpha(seed.accent, 0.45),
    },
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

/* ---------------------------------------------------------- 悬浮球主题表 */

interface BallSeedEntry extends BallSeed {
  id: string;
  name: Bi;
}

const BALL_SEEDS: BallSeedEntry[] = [
  {
    id: "solid",
    name: { zh: "纯色", en: "Solid" },
    panel: ["#ffffff", "#1d2027"],
    ink: ["#22262e", "#e6e9ef"],
    accent: "#3f7dff",
    accent2: "#6b9bff",
    bars: ["#9fc4ff", "#7f9bf0", "#5f7ce0"],
    barsDark: ["#3f6fd8", "#5f7ae0", "#8f9bf5"],
    core: ["#ffffff", "#eaf0ff"],
    coreDark: ["#2a3350", "#1b2438"],
    halo: "#3f7dff",
    haloDark: "#5c95ff",
    glyph: "#3f7dff",
  },
  {
    id: "macaron",
    name: { zh: "马卡龙", en: "Macaron" },
    panel: ["#fffdfd", "#241d2b"],
    ink: ["#5a4a5e", "#f0e6f0"],
    accent: "#ff8fb8",
    accent2: "#b8a4ea",
    bars: ["#9fd4ff", "#c9a9f2", "#ff8fb8"],
    barsDark: ["#6fb4e8", "#a086e0", "#ff8fb8"],
    core: ["#ffffff", "#ffeaf4"],
    coreDark: ["#38263a", "#2a1c2c"],
    halo: "#ffb0d0",
    haloDark: "#ff8fb8",
    glyph: "#ff8fb8",
  },
  {
    id: "sakura",
    name: { zh: "樱花", en: "Sakura" },
    panel: ["#fffafc", "#2a1c22"],
    ink: ["#4b3540", "#f6e6ec"],
    accent: "#e8618c",
    accent2: "#f0a5bd",
    bars: ["#ffd0dd", "#f7a8c4", "#e8618c"],
    barsDark: ["#b06a86", "#e0819f", "#ff91b4"],
    core: ["#ffffff", "#ffeef4"],
    coreDark: ["#3d242f", "#2c1a22"],
    halo: "#f7a8c4",
    haloDark: "#ff91b4",
    glyph: "#e8618c",
  },
  {
    id: "ocean",
    name: { zh: "深海", en: "Ocean" },
    panel: ["#fafdff", "#122430"],
    ink: ["#22384a", "#dceaf2"],
    accent: "#0e86c4",
    accent2: "#3fb6c9",
    bars: ["#7fd0f0", "#57b8e0", "#2f8fd0"],
    barsDark: ["#2d7fb8", "#3aa8c8", "#4fd6d0"],
    core: ["#ffffff", "#e8f7ff"],
    coreDark: ["#153346", "#0e2230"],
    halo: "#57b8e0",
    haloDark: "#4fd6d0",
    glyph: "#0e86c4",
  },
  {
    id: "forest",
    name: { zh: "苔原", en: "Forest" },
    panel: ["#fbfefb", "#16241c"],
    ink: ["#2b3a2e", "#dfeee2"],
    accent: "#3f8f5f",
    accent2: "#7fbf6a",
    bars: ["#a8d98f", "#6cc08a", "#3f9f7f"],
    barsDark: ["#3f7f5f", "#5aa87a", "#7fc98a"],
    core: ["#ffffff", "#ecf9ee"],
    coreDark: ["#1c3524", "#132418"],
    halo: "#7fbf6a",
    haloDark: "#7fc98a",
    glyph: "#3f8f5f",
  },
  {
    id: "sunset",
    name: { zh: "落日", en: "Sunset" },
    panel: ["#fffcf7", "#2a1e19"],
    ink: ["#4a352c", "#f6e6dc"],
    accent: "#e8763f",
    accent2: "#e05a7a",
    bars: ["#ffc98f", "#ff9f72", "#e8608f"],
    barsDark: ["#c07a3f", "#e8845f", "#f06f92"],
    core: ["#ffffff", "#fff0e2"],
    coreDark: ["#40281d", "#2e1b15"],
    halo: "#ff9f72",
    haloDark: "#f06f92",
    glyph: "#e8763f",
  },
  {
    id: "grape",
    name: { zh: "葡萄紫", en: "Grape" },
    panel: ["#fdfbff", "#211a33"],
    ink: ["#38304e", "#e8e2f8"],
    accent: "#7b5cd6",
    accent2: "#a86ce0",
    bars: ["#b39cf0", "#9b7ae8", "#c07ae0"],
    barsDark: ["#6f5cb8", "#8f6fe0", "#b47ce0"],
    core: ["#ffffff", "#efe9ff"],
    coreDark: ["#2b2246", "#1d1733"],
    halo: "#a86ce0",
    haloDark: "#c78ce8",
    glyph: "#7b5cd6",
  },
  {
    id: "gold",
    name: { zh: "流金", en: "Gold" },
    panel: ["#fffdf6", "#241f16"],
    ink: ["#4a3d22", "#f3e9d2"],
    accent: "#d0a24c",
    accent2: "#e8c06a",
    bars: ["#ffe6a8", "#f0c46a", "#d09a3c"],
    barsDark: ["#a8802f", "#d3a748", "#f0cf7a"],
    core: ["#ffffff", "#fff6e2"],
    coreDark: ["#3b3020", "#281f12"],
    halo: "#f0c46a",
    haloDark: "#ffd98a",
    glyph: "#d0a24c",
  },
  {
    id: "neon",
    name: { zh: "霓虹", en: "Neon" },
    panel: ["#fdfaff", "#161629"],
    ink: ["#2a2b4a", "#eaeaff"],
    accent: "#7a3ff0",
    accent2: "#00b8d4",
    bars: ["#00e5ff", "#7a3ff0", "#ff3fb0"],
    barsDark: ["#22e0ff", "#b46bff", "#ff3fb0"],
    core: ["#ffffff", "#f0eaff"],
    coreDark: ["#241a45", "#160f2e"],
    halo: "#7a3ff0",
    haloDark: "#b46bff",
    glyph: "#7a3ff0",
  },
  {
    id: "graphite",
    name: { zh: "石墨", en: "Graphite" },
    panel: ["#ffffff", "#1c1f24"],
    ink: ["#2b2f36", "#e4e7ec"],
    accent: "#5a6472",
    accent2: "#8b94a3",
    bars: ["#b6bec9", "#8b94a3", "#5a6472"],
    barsDark: ["#4a525e", "#6f7a89", "#9aa4b2"],
    core: ["#ffffff", "#f0f2f5"],
    coreDark: ["#272b31", "#181b1f"],
    halo: "#8b94a3",
    haloDark: "#9aa4b2",
    glyph: "#5a6472",
  },
  {
    id: "mint",
    name: { zh: "薄荷", en: "Mint" },
    panel: ["#fbfefd", "#132523"],
    ink: ["#24403c", "#dbf0ec"],
    accent: "#1fa88f",
    accent2: "#57c9d8",
    bars: ["#8fe8d0", "#5fd0c0", "#3fb8d0"],
    barsDark: ["#2f8f80", "#3fb8a8", "#5fd0e0"],
    core: ["#ffffff", "#e8fdf8"],
    coreDark: ["#16362f", "#0d241f"],
    halo: "#5fd0c0",
    haloDark: "#5fd0e0",
    glyph: "#1fa88f",
  },
];

export const BALL_THEMES: BallTheme[] = BALL_SEEDS.map(({ id, name, ...seed }) => ({
  id,
  name,
  light: buildBallSkin(seed, "light"),
  dark: buildBallSkin(seed, "dark"),
}));

export const DEFAULT_BALL_THEME = "solid";

/* ------------------------------------------------------------ 变量应用 */

const kebab = (key: string) => key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

/**
 * 把色板摊成 CSS 变量表。
 *
 * 预览卡片也用它：给预览元素设上同一套变量，预览里就能直接写
 * `var(--ui-accent)` 之类的样式 —— 预览和真实界面共用一份 CSS 规则，
 * 不会出现"预览挺好看、套上去不是那样"。
 */
export function paletteStyle(palette: Palette, orb?: OrbPalette): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(palette)) {
    if (value) out[`--ui-${kebab(key)}`] = value;
  }
  if (orb) {
    for (const [key, value] of Object.entries(orb)) {
      if (value) out[`--ui-orb-${kebab(key)}`] = value;
    }
  }
  return out;
}

/** 把变量写进指定元素（默认是 `<html>`）。 */
export function applyVars(target: HTMLElement, vars: Record<string, string>) {
  for (const [key, value] of Object.entries(vars)) target.style.setProperty(key, value);
}

export function appThemeById(id: string): AppTheme {
  return APP_THEMES.find((theme) => theme.id === id) ?? APP_THEMES[0];
}

export function ballThemeById(id: string): BallTheme {
  return BALL_THEMES.find((theme) => theme.id === id) ?? BALL_THEMES[0];
}

/** 系统当前是不是深色。 */
export function prefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** 把 `light` / `dark` / `system` 收敛成实际生效的明暗。 */
export function resolveAppearance(mode: ThemeMode): Appearance {
  return mode === "system" ? (prefersDark() ? "dark" : "light") : mode;
}

/** 应用主题：写变量 + 标记明暗，返回实际生效的明暗（窗口标题栏要用）。 */
export function applyAppTheme(themeId: string, mode: ThemeMode): Appearance {
  const appearance = resolveAppearance(mode);
  applyVars(document.documentElement, paletteStyle(appThemeById(themeId)[appearance]));
  markAppearance(appearance);
  return appearance;
}

/** 悬浮球主题：面板与小球一起换色（形状不归它管，见 [`applyBallLook`]）。 */
export function applyBallTheme(themeId: string, mode: ThemeMode): Appearance {
  const appearance = resolveAppearance(mode);
  const skin = ballThemeById(themeId)[appearance];
  applyVars(document.documentElement, paletteStyle(skin.panel, skin.orb));
  markAppearance(appearance);
  return appearance;
}

/**
 * 落地悬浮球的「律动样式」与「数据源」。
 *
 * 只写两个 `data-*`，同时给两边用：
 * * `ball-render.ts` 从 [`currentBallStyle`] / [`currentBallDataSource`] 读；
 * * `ball.css` 靠 `[data-ball-style=…]` 给不同样式配不同的待机动画（例如涟漪不显示音符）。
 */
export function applyBallLook(styleId: string, source: string): void {
  const style = ballStyleById(styleId);
  const root = document.documentElement;
  root.dataset.ballStyle = style.id;
  root.dataset.ballSource = resolveDataSource(style.id, source);
  // 样式自己偏好的那份数据，卡片上那行小字要用（与用户选的可能不同）
  root.dataset.ballStyleDefault = style.mode;
}

function markAppearance(appearance: Appearance) {
  const root = document.documentElement;
  root.dataset.appearance = appearance;
  // 让浏览器原生控件（滚动条、下拉框）跟着走
  root.style.colorScheme = appearance;
}

/**
 * 按当前明暗取一套小球配色。
 *
 * 悬浮球窗口要画布颜色，但它只有「悬浮球主题 id」这一份设置，也只能从这里拿 ——
 * 明暗则由 `<html data-appearance>` 决定（`applyBallTheme` 刚写过）。
 */
export function ballOrbColors(themeId: string): OrbPalette {
  const appearance: Appearance = document.documentElement.dataset.appearance === "dark" ? "dark" : "light";
  return ballThemeById(themeId)[appearance].orb;
}

/** 取指定主题在指定明暗下的小球配色（调用方自己指定，不读页面状态）。 */
export function orbPaletteFor(themeId: string, appearance: Appearance): OrbPalette {
  return ballThemeById(themeId)[appearance].orb;
}

/** 读一个已经生效的 CSS 变量（画布用）。 */
export function cssVar(name: string, fallback = "#000000"): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** 画布需要的颜色一次读齐。 */
export function canvasColors() {
  return {
    grid: cssVar("--ui-viz-grid", "rgba(0,0,0,0.15)"),
    waveA: cssVar("--ui-viz-wave-a"),
    waveB: cssVar("--ui-viz-wave-b"),
    waveC: cssVar("--ui-viz-wave-c"),
    specA: cssVar("--ui-viz-spec-a"),
    specB: cssVar("--ui-viz-spec-b"),
    specC: cssVar("--ui-viz-spec-c"),
    peak: cssVar("--ui-viz-peak"),
    glow: cssVar("--ui-viz-glow"),
  };
}
