/**
 * 界面偏好的前端状态。
 *
 * 主界面与悬浮球是两个 WebView，各自跑一份 [`bindSettings`]：启动时从 Rust 读一份，
 * 之后监听 `pac://settings` 广播。任意一边改了设置，Rust 广播回来，两边同时换肤 ——
 * 不依赖 WebView 之间是否共享 localStorage。
 *
 * `scope` 决定这份窗口该套哪条线：主界面跟「应用主题」+「深色模式」，悬浮球跟用户自己
 * 排的色槽与内外两个律动样式（悬浮球不吃明暗，固定按亮色那套走）。
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { EVT_SETTINGS, api, type Settings } from "./api";
import {
  DEFAULT_BALL_PULSE_ALGORITHM,
  DEFAULT_BALL_PULSE_AMOUNT,
  pulseAlgorithmById,
} from "./ball-pulse";
import { setLanguage } from "./i18n";
import {
  APP_THEMES,
  DEFAULT_APP_THEME,
  DEFAULT_BALL_COLOR,
  applyAppTheme,
  applyBallColors,
  applyBallLook,
  ballPresetById,
  ballStyleById,
  normalizeBallColors,
  resolveDataSource,
  type Appearance,
} from "./theme";

/**
 * 界面上的帧率档位（`0` = 不限）。设置面板按它排一组按钮，`normalize` 也按它收口 ——
 * 手改坏的 settings.json 落不到中间值上。
 */
export const FRAME_RATE_CHOICES = [15, 30, 60, 120, 0] as const;
/** 默认帧率上限。 */
export const DEFAULT_FRAME_RATE = 30;

export const DEFAULT_SETTINGS: Settings = {
  themeMode: "system",
  appTheme: DEFAULT_APP_THEME,
  language: "zh-CN",
  autoFollow: false,
  recordWav: false,

  // 特效渲染的帧率上限：默认 30。0 = 不限（见 [`normalizeFrameRate`]）
  frameRate: DEFAULT_FRAME_RATE,

  // 持续监听的目标（进程名）。空 = 没有目标，启动时不会自动起流。
  // 平时由后端在起流成功后回填，用户也可以手动指定。
  monitorTarget: "",

  // 窗口名单：空 = 不限制。本应用自己的进程名由后端保证永远在黑名单里。
  windowAllowlist: [],
  windowBlocklist: [],

  // 悬浮球的几项都用"空值 = 还没配过"当哨兵：`normalize` 会按旧配置或默认值补上。
  // 这样做是为了让老版本的 settings.json 平滑升级 —— 见 [`normalizeBall`]。
  ballColors: [],
  ballInnerStyle: "",
  ballOuterStyle: "",
  ballInnerSource: "",
  ballOuterSource: "",
  ballSize: 1,
  ballGain: 1,
  ballPulse: false,
  ballPulseAlgorithm: DEFAULT_BALL_PULSE_ALGORITHM,
  ballPulseAmount: DEFAULT_BALL_PULSE_AMOUNT,
  // 球心在屏幕里的位置（0~1）：默认贴着右下角那一带，和以前的样子差不多
  ballPosX: 0.92,
  ballPosY: 0.88,
  ballLocked: false,

  // 遗留字段：只在迁移时读一次
  ballTheme: "solid",
  ballStyle: "",
  ballSource: "",
};

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

/** 帧率收敛：只认那几个档位，其余一律落回默认值。 */
function normalizeFrameRate(value: unknown): number {
  return FRAME_RATE_CHOICES.includes(value as (typeof FRAME_RATE_CHOICES)[number])
    ? (value as number)
    : DEFAULT_FRAME_RATE;
}

/** 进程名收敛：去空白、统一小写。和 Rust 侧 `filter::tidy` 同一套规则。 */
function tidyName(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * 进程名收敛：去空白、统一小写、去重。
 *
 * 大小写不敏感是有意的 —— Windows 进程名本就如此，用户填 `Chrome.EXE` 也该命中。规则与
 * Rust 侧的 `filter::tidy` 完全一致，两边不会出现"列表里过滤了、自动跟随没过滤"。
 */
function tidyNames(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const name = entry.trim().toLowerCase();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * 悬浮球那几项的收敛与迁移。
 *
 * 老版本的 settings.json 里只有 `ballTheme`（配色预设）/ `ballStyle`（唯一那个样式）/
 * `ballSource`（唯一那个数据源），新版本换成了自定义色槽 + 内外两层。空值表示"还没
 * 配过"，于是老配置能原地升级：配色铺成当时那个预设的三色，旧的样式与数据源当成外圈。
 */
function normalizeBall(merged: Settings): void {
  if (merged.ballColors.length === 0) {
    const preset = ballPresetById(merged.ballTheme);
    merged.ballColors = preset ? [...preset.colors] : [DEFAULT_BALL_COLOR];
  }
  merged.ballColors = normalizeBallColors(merged.ballColors);

  // 外圈：没配过就沿用旧版那个唯一样式（可能为空，那就落回默认样式）
  merged.ballOuterStyle = ballStyleById(merged.ballOuterStyle || merged.ballStyle, "outer").id;
  merged.ballInnerStyle = ballStyleById(merged.ballInnerStyle, "inner").id;

  const inner = ballStyleById(merged.ballInnerStyle, "inner");
  const outer = ballStyleById(merged.ballOuterStyle, "outer");
  merged.ballInnerSource = resolveDataSource(merged.ballInnerSource, inner.mode);
  merged.ballOuterSource = resolveDataSource(
    merged.ballOuterSource || merged.ballSource,
    outer.mode,
  );

  merged.ballSize = clampNumber(merged.ballSize, 0, 3, 1);
  merged.ballGain = clampNumber(merged.ballGain, 0, 5, 1);
  merged.ballPulse = Boolean(merged.ballPulse);
  merged.ballPulseAlgorithm = pulseAlgorithmById(merged.ballPulseAlgorithm).id;
  merged.ballPulseAmount = clampNumber(merged.ballPulseAmount, 1, 3, 1);
  // 球心位置是屏幕里的百分比：夹在 0..1，具体留边由前端按球的实际大小算
  merged.ballPosX = clampNumber(merged.ballPosX, 0, 1, 0.92);
  merged.ballPosY = clampNumber(merged.ballPosY, 0, 1, 0.88);
  merged.ballLocked = Boolean(merged.ballLocked);
}

/** 字段可能是手改坏的、也可能来自旧版本，一律收敛到已知取值。 */
export function normalize(raw: Partial<Settings> | null | undefined): Settings {
  const merged: Settings = { ...DEFAULT_SETTINGS, ...(raw ?? {}) };

  if (!APP_THEMES.some((theme) => theme.id === merged.appTheme)) {
    merged.appTheme = DEFAULT_APP_THEME;
  }
  if (merged.themeMode !== "light" && merged.themeMode !== "dark" && merged.themeMode !== "system") {
    merged.themeMode = "system";
  }
  if (merged.language !== "zh-CN" && merged.language !== "en-US") {
    merged.language = "zh-CN";
  }

  merged.windowAllowlist = tidyNames(merged.windowAllowlist);
  merged.windowBlocklist = tidyNames(merged.windowBlocklist);

  merged.frameRate = normalizeFrameRate(merged.frameRate);
  merged.monitorTarget = tidyName(merged.monitorTarget);

  normalizeBall(merged);
  return merged;
}

export interface SettingsBinding {
  /** 当前生效的设置（已归一化）。 */
  get(): Settings;
  /** 从后端读一次并应用。读不到就用默认值，不让设置拦住启动。 */
  load(): Promise<Settings>;
  /** 改一部分字段：先本地生效（点一下立刻变色），落盘失败再回滚。 */
  patch(patch: Partial<Settings>): Promise<Settings>;
  /** 别的窗口改了设置时回调（本窗口也会收到，用来同步控件状态）。 */
  subscribe(fn: (settings: Settings) => void): Promise<UnlistenFn>;
  /** 再套用一次当前设置 —— 系统明暗切换时用，不写盘也不广播。 */
  reapply(): Appearance;
  /** 系统明暗变化时回调 —— 只有 `themeMode === "system"` 才需要重新套用。 */
  watchSystem(fn: () => void): void;
}

export function bindSettings(scope: "app" | "ball"): SettingsBinding {
  let current: Settings = { ...DEFAULT_SETTINGS };

  /**
   * 套用设置：`scope` 决定用哪条线。深色模式只作用于应用主题 —— 悬浮球按色槽走，
   * 切浅色 / 深色 / 跟随系统时它一动不动。
   *
   * 悬浮球这边配色与形状互不覆盖：前者只写 `--ui-*` / `--ui-orb-*` 颜色变量，
   * 后者只写 `<html>` 上的 `data-ball-*`。
   */
  const apply = (settings: Settings): Appearance => {
    current = settings;
    setLanguage(settings.language);

    let appearance: Appearance;
    if (scope === "ball") {
      applyBallColors(settings.ballColors);
      applyBallLook(
        settings.ballInnerStyle,
        settings.ballOuterStyle,
        settings.ballInnerSource,
        settings.ballOuterSource,
      );
      appearance = "light";
    } else {
      appearance = applyAppTheme(settings.appTheme, settings.themeMode);
    }

    // 标题栏 / 边框跟着明暗走（悬浮球固定浅色；它无边框，其实用不上）
    void getCurrentWindow()
      .setTheme(appearance)
      .catch(() => {});

    return appearance;
  };

  return {
    get: () => current,

    async load() {
      let raw: Partial<Settings> | null = null;
      try {
        raw = await api.getSettings();
      } catch {
        // 读不到就用默认值：设置不该拦住启动
      }
      const settings = normalize(raw);
      apply(settings);
      return settings;
    },

    async patch(patch) {
      const previous = current;
      const next = normalize({ ...current, ...patch });
      apply(next);
      try {
        const saved = normalize(await api.saveSettings(next));
        apply(saved);
        return saved;
      } catch (err) {
        // 落盘失败：界面已经乐观更新过了，这里退回去，免得"看着改了其实没存住"
        apply(previous);
        throw err;
      }
    },

    reapply: () => apply(current),

    subscribe(fn) {
      return listen<Settings>(EVT_SETTINGS, (event) => {
        const settings = normalize(event.payload);
        apply(settings);
        fn(settings);
      });
    },

    watchSystem(fn) {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", fn);
    },
  };
}
