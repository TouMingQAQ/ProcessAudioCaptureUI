/**
 * 界面偏好的前端状态。
 *
 * 主界面与悬浮球是两个 WebView，各自跑一份 [`bindSettings`]：启动时从 Rust 读一份，
 * 之后监听 `pac://settings` 广播。任意一边改了设置，Rust 广播回来，两边同时换肤 ——
 * 不依赖 WebView 之间是否共享 localStorage。
 *
 * `scope` 决定这份窗口该套哪套主题：主界面跟「应用主题」，悬浮球跟「悬浮球主题」，
 * 但深色模式（浅色 / 深色 / 跟随系统）是共用的。
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { EVT_SETTINGS, api, type Settings } from "./api";
import { setLanguage } from "./i18n";
import {
  APP_THEMES,
  BALL_THEMES,
  BALL_DATA_SOURCES,
  BALL_STYLES,
  DEFAULT_APP_THEME,
  DEFAULT_BALL_DATA_SOURCE,
  DEFAULT_BALL_STYLE,
  DEFAULT_BALL_THEME,
  applyAppTheme,
  applyBallLook,
  applyBallTheme,
  resolveDataSource,
  type Appearance,
} from "./theme";

export const DEFAULT_SETTINGS: Settings = {
  themeMode: "system",
  appTheme: DEFAULT_APP_THEME,
  ballTheme: DEFAULT_BALL_THEME,
  ballStyle: DEFAULT_BALL_STYLE,
  ballSource: DEFAULT_BALL_DATA_SOURCE,
  language: "zh-CN",
  autoFollow: false,
  recordWav: false,
};

/** 字段可能是手改坏的、也可能来自旧版本，一律收敛到已知取值。 */
export function normalize(raw: Partial<Settings> | null | undefined): Settings {
  const merged = { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
  if (!APP_THEMES.some((theme) => theme.id === merged.appTheme)) {
    merged.appTheme = DEFAULT_APP_THEME;
  }
  if (!BALL_THEMES.some((theme) => theme.id === merged.ballTheme)) {
    merged.ballTheme = DEFAULT_BALL_THEME;
  }
  if (!BALL_STYLES.some((style) => style.id === merged.ballStyle)) {
    merged.ballStyle = DEFAULT_BALL_STYLE;
  }
  // 数据源还要跟样式对得上：像「柱阵」这种只认频谱的样式不能配波形
  const source = BALL_DATA_SOURCES.includes(merged.ballSource)
    ? merged.ballSource
    : DEFAULT_BALL_DATA_SOURCE;
  merged.ballSource = resolveDataSource(merged.ballStyle, source);
  if (merged.themeMode !== "light" && merged.themeMode !== "dark" && merged.themeMode !== "system") {
    merged.themeMode = "system";
  }
  if (merged.language !== "zh-CN" && merged.language !== "en-US") {
    merged.language = "zh-CN";
  }
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
   * 套用设置：亮暗决定取哪份色板，`scope` 决定用哪条主题线。
   *
   * 悬浮球这边要先上**配色**、再上**形状**（律动样式 + 数据源）—— 两者互不覆盖：
   * 前者只写 `--ui-orb-*` 这类颜色变量，后者只写 `<html>` 上的 `data-ball-*`。
   */
  const apply = (settings: Settings): Appearance => {
    current = settings;
    setLanguage(settings.language);

    let appearance: Appearance;
    if (scope === "ball") {
      appearance = applyBallTheme(settings.ballTheme, settings.themeMode);
      applyBallLook(settings.ballStyle, settings.ballSource);
    } else {
      appearance = applyAppTheme(settings.appTheme, settings.themeMode);
    }

    // 主窗口的标题栏 / 边框也跟着系统深色走；悬浮球无边框，调了也没坏处
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
