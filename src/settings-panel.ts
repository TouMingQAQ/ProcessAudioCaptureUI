/**
 * 设置面板（主界面左下角的「设置」按钮打开）。
 *
 * 四个 tab：
 * * 通用 —— 语言、自动跟随；
 * * 主题 —— 深色模式 + 应用主题；
 * * 悬浮球 —— 配色（自定义色槽 + 快捷预设）、律动样式（内圈 / 外圈各一个）、
 *   尺寸与律动（大小、显示倍率、随音频缩放）；
 * * 内核 —— 采集内核的加载状态与重新加载（原来挂在顶栏上，现在挪进来）。
 *
 * 应用主题卡片是真正"所见即所得"的：卡片里的浅色 / 深色两半各自带上那套主题的 CSS
 * 变量，里头的迷你界面用的全是和真实界面同一批 `var(--ui-*)`。
 *
 * 悬浮球这边有三块可以折叠：
 * * **配色** —— 用户自己排的一张色槽表（至少一个色），样式按顺序往下取；
 * * **律动样式** —— 内外两层各一个真画布卡片，跑的就是悬浮球窗口那份绘制代码
 *   （`renderOrb`），卡片上看到的就是换上去以后的样子；
 * * **尺寸与律动** —— 大小、显示倍率，以及"跟着音乐点头"的算法。
 *
 * 样式名字与说明都按 id 去 `i18n.ts` 取（`ballStyle.<id>`），样式表里不再各写一份中英文。
 */

import type { DllStatus, MonitorTick, Settings } from "./api";
import type { BallDataSource, BallStyle } from "./ball-style";
import { renderStylePreview } from "./ball-render";
import {
  BALL_PULSE_ALGORITHMS,
  DEFAULT_BALL_PULSE_ALGORITHM,
  DEFAULT_BALL_PULSE_AMOUNT,
} from "./ball-pulse";
import { bi, t } from "./i18n";
import { FRAME_RATE_CHOICES, type SettingsBinding } from "./settings";
import { getSelfName } from "./window-list";
import {
  APP_THEMES,
  BALL_COLOR_PRESETS,
  BALL_DATA_SOURCES,
  BALL_INNER_STYLES,
  BALL_OUTER_STYLES,
  DEFAULT_APP_THEME,
  DEFAULT_BALL_COLOR,
  DEFAULT_BALL_INNER_STYLE,
  DEFAULT_BALL_OUTER_STYLE,
  MAX_BALL_COLORS,
  applyVars,
  ballStyleById,
  orbColorsFrom,
  paletteStyle,
  type Appearance,
  type OrbColors,
  type Palette,
} from "./theme";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少元素 #${id}`);
  return el as T;
};

/** 小球预览的画布边长（CSS 像素），和 `.style-card-orb` 的尺寸保持一致。 */
const PREVIEW_SIZE = 56;

/** 十六进制色（`#rgb` / `#rrggbb`）。 */
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** 迷你界面骨架：一条侧栏 + 一个内容块 + 几根"频谱柱"（应用主题卡片预览用）。 */
function mockApp(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "mock";

  const side = document.createElement("div");
  side.className = "mock-side";
  for (let i = 0; i < 3; i++) {
    const row = document.createElement("span");
    row.className = "mock-row";
    side.append(row);
  }

  const main = document.createElement("div");
  main.className = "mock-main";
  const title = document.createElement("span");
  title.className = "mock-title";
  const viz = document.createElement("div");
  viz.className = "mock-viz";
  for (let i = 0; i < 7; i++) viz.append(document.createElement("i"));
  main.append(title, viz);

  wrap.append(side, main);
  return wrap;
}

interface Preview {
  appearance: Appearance;
  palette: Palette;
}

/** 应用主题卡片：左右分别是浅色 / 深色预览。 */
function themeCard(id: string, name: string, appearances: Preview[], selected: boolean): HTMLButtonElement {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "theme-card";
  card.dataset.themeId = id;
  card.setAttribute("aria-pressed", String(selected));
  card.title = name;

  const shot = document.createElement("div");
  shot.className = "theme-shot";
  for (const item of appearances) {
    const half = document.createElement("div");
    half.className = "theme-half";
    half.dataset.appearance = item.appearance;
    applyVars(half, paletteStyle(item.palette));
    half.append(mockApp());
    shot.append(half);
  }

  card.append(shot, metaRow(name, selected));
  return card;
}

/** 卡片底部那行：名字 +（选中时）「当前」标签。 */
function metaRow(name: string, selected: boolean): HTMLElement {
  const meta = document.createElement("div");
  meta.className = "theme-meta";
  const label = document.createElement("span");
  label.className = "theme-name";
  label.textContent = name;
  meta.append(label);
  if (selected) {
    const tag = document.createElement("span");
    tag.className = "theme-tag";
    tag.textContent = t("settings.theme.current");
    meta.append(tag);
  }
  return meta;
}

/* ------------------------------------------------------------- 配色预设 */

/** 一张快捷预设：三条颜色 + 名字。点一下把这三色铺进色槽。 */
function presetCard(preset: (typeof BALL_COLOR_PRESETS)[number], current: string[]): HTMLButtonElement {
  const name = bi(preset.name);
  const card = document.createElement("button");
  card.type = "button";
  card.className = "preset-card";
  card.title = name;
  card.setAttribute("aria-pressed", String(preset.colors.join(" ") === current.join(" ")));

  const band = document.createElement("span");
  band.className = "preset-band";
  for (const color of preset.colors) {
    const chip = document.createElement("i");
    chip.style.background = color;
    band.append(chip);
  }

  const label = document.createElement("span");
  label.className = "preset-name";
  label.textContent = name;

  card.append(band, label);
  return card;
}

/* --------------------------------------------------------------- 样式卡片 */

/** 数据源的名字（频谱 / 波形 / 自适应 / 响度 / 峰值）。 */
function sourceName(source: BallDataSource): string {
  return t(`ballStyle.source.${source}`);
}

/** 样式名字与说明都放在 `i18n.ts`（键名 `ballStyle.<id>` / `ballStyle.hint.<id>`）。 */
function styleName(style: BallStyle): string {
  return t(`ballStyle.${style.id}`);
}

/**
 * 一张律动样式卡片。
 *
 * 预览画的是"换成它以后整颗球的样子"：只替换这一层的样式，另一层保留当前选择，
 * 所以内圈卡片里也有外圈、外圈卡片里也有内圈，看到的就是实物的样子。
 */
function styleCard(style: BallStyle, inner: BallStyle, outer: BallStyle, selected: boolean): HTMLButtonElement {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "style-card";
  card.dataset.styleId = style.id;
  card.dataset.layer = style.layer;
  card.setAttribute("aria-pressed", String(selected));
  card.title = t(`ballStyle.hint.${style.id}`);

  const previewInner = style.layer === "inner" ? style : inner;
  const previewOuter = style.layer === "outer" ? style : outer;

  const shot = document.createElement("span");
  shot.className = "style-card-shot";
  const canvas = document.createElement("canvas");
  canvas.className = "style-card-orb";
  canvas.dataset.orbInner = previewInner.id;
  canvas.dataset.orbOuter = previewOuter.id;
  shot.append(canvas);

  if (selected) {
    const tag = document.createElement("span");
    tag.className = "style-card-tag";
    tag.textContent = t("settings.theme.current");
    shot.append(tag);
  }

  const meta = document.createElement("span");
  meta.className = "style-card-meta";
  const label = document.createElement("span");
  label.className = "style-card-name";
  label.textContent = styleName(style);
  const origin = document.createElement("span");
  origin.className = "style-card-source";
  origin.textContent = sourceName(style.mode);
  meta.append(label, origin);

  card.append(shot, meta);
  return card;
}

/** 把样式卡片里的画布逐个画出来（此时它们已经在 DOM 里）。 */
function paintStylePreviews(root: HTMLElement, colors: OrbColors) {
  const dpr = window.devicePixelRatio || 1;
  root.querySelectorAll<HTMLCanvasElement>("canvas[data-orb-inner]").forEach((canvas) => {
    const inner = ballStyleById(canvas.dataset.orbInner ?? "", "inner");
    const outer = ballStyleById(canvas.dataset.orbOuter ?? "", "outer");
    renderStylePreview(canvas, inner, outer, colors, PREVIEW_SIZE, dpr);
  });
}

export interface SettingsPanelOptions {
  prefs: SettingsBinding;
  /** 点「重新加载内核」时调用（主界面拿到的是 `reload_dll`）。 */
  reloadKernel: () => Promise<DllStatus>;
  /** 想往主界面日志里写一行就调它。 */
  log?: (message: string, kind?: "info" | "warn" | "error") => void;
  /**
   * 主界面当前选中的窗口的进程名（没选中时返回 `null`）。
   *
   * 「持续监听」那一栏拿它做"用当前选中的窗口"按钮 —— 让用户不必手打进程名。
   */
  selectedProcess?: () => string | null;
  /** 手动设置 / 清除持续监听对象（走 `set_monitor_target`，有起流 / 停流的副作用）。 */
  setMonitorTarget?: (processName: string) => Promise<void>;
}

export interface SettingsPanel {
  open(): void;
  close(): void;
  toggle(): void;
  get isOpen(): boolean;
  /** 设置变化（本窗口或别的窗口改的）后同步控件状态。 */
  sync(settings: Settings): void;
  /** 把内核状态渲染到「内核」tab。 */
  syncKernel(status: DllStatus | null): void;
  /** 每次扫描 tick 同步「持续监听」的状态（正在监听 / 等待目标出现）。 */
  syncMonitor(tick: MonitorTick | null): void;
  /** 语言变化后重刷所有文案（含主题卡片里的名字）。 */
  relang(settings: Settings): void;
}

export function createSettingsPanel(options: SettingsPanelOptions): SettingsPanel {
  const { prefs, reloadKernel, log, selectedProcess, setMonitorTarget } = options;

  const overlay = $<HTMLDivElement>("settings");
  const scrim = $<HTMLDivElement>("settings-scrim");
  const closeBtn = $<HTMLButtonElement>("settings-close");
  const modeGroup = $<HTMLDivElement>("theme-mode-group");
  const langGroup = $<HTMLDivElement>("language-group");
  const frameRateGroup = $<HTMLDivElement>("frame-rate-group");
  const autoFollowBox = $<HTMLInputElement>("set-auto-follow");
  const monitorInput = $<HTMLInputElement>("monitor-target-input");
  const monitorSetBtn = $<HTMLButtonElement>("monitor-target-set");
  const monitorClearBtn = $<HTMLButtonElement>("monitor-target-clear");
  const monitorPickBtn = $<HTMLButtonElement>("monitor-target-pick");
  const monitorState = $<HTMLSpanElement>("monitor-target-state");
  const appGrid = $<HTMLDivElement>("app-theme-grid");
  const resetBtn = $<HTMLButtonElement>("theme-reset");
  const reloadBtn = $<HTMLButtonElement>("btn-kernel-reload");

  /* ------------------------------------------------------------ 悬浮球控件 */
  const colorSlots = $<HTMLDivElement>("ball-color-slots");
  const colorAddBtn = $<HTMLButtonElement>("ball-color-add");
  const colorPresets = $<HTMLDivElement>("ball-color-presets");
  const ballResetBtn = $<HTMLButtonElement>("ball-reset");
  const innerGrid = $<HTMLDivElement>("ball-inner-grid");
  const outerGrid = $<HTMLDivElement>("ball-outer-grid");
  const innerSourceGroup = $<HTMLDivElement>("ball-inner-source");
  const outerSourceGroup = $<HTMLDivElement>("ball-outer-source");
  const innerNote = $<HTMLParagraphElement>("ball-inner-note");
  const outerNote = $<HTMLParagraphElement>("ball-outer-note");
  const sizeInput = $<HTMLInputElement>("ball-size");
  const sizeValue = $<HTMLSpanElement>("ball-size-value");
  const gainInput = $<HTMLInputElement>("ball-gain");
  const gainValue = $<HTMLSpanElement>("ball-gain-value");
  const pulseAmountInput = $<HTMLInputElement>("ball-pulse-amount");
  const pulseAmountValue = $<HTMLSpanElement>("ball-pulse-amount-value");
  const pulseBox = $<HTMLInputElement>("ball-pulse");
  const pulseGroup = $<HTMLDivElement>("ball-pulse-group");
  const pulseNote = $<HTMLParagraphElement>("ball-pulse-note");
  const lockedBox = $<HTMLInputElement>("ball-locked");

  const knStatus = $<HTMLDivElement>("kn-status");
  const knStatusDot = $<HTMLSpanElement>("kn-status-dot");
  const knStatusText = $<HTMLSpanElement>("kn-status-text");
  const knVersion = $<HTMLSpanElement>("kn-version");
  const knPath = $<HTMLSpanElement>("kn-path");
  const knExpected = $<HTMLSpanElement>("kn-expected");
  const knCandidates = $<HTMLUListElement>("kn-candidates");

  /* ------------------------------------------------------------- 窗口名单 */
  const allowInput = $<HTMLInputElement>("allow-input");
  const allowAddBtn = $<HTMLButtonElement>("allow-add");
  const allowItems = $<HTMLUListElement>("allow-items");
  const blockInput = $<HTMLInputElement>("block-input");
  const blockAddBtn = $<HTMLButtonElement>("block-add");
  const blockItems = $<HTMLUListElement>("block-items");

  let settings: Settings = prefs.get();
  let opened = false;
  /** 最近一次扫描 tick：用来知道"持续监听"现在是在等目标还是正在采。 */
  let lastTick: MonitorTick | null = null;
  /** 正在写监听对象：三个按钮先禁掉，免得连点。 */
  let monitorBusy = false;

  /* ---------------------------------------------------------- 折叠区块 */

  overlay.querySelectorAll<HTMLElement>(".set-block.is-collapsible").forEach((block) => {
    const head = block.querySelector<HTMLButtonElement>(".set-block-head.is-collapsible");
    if (!head) return;
    head.addEventListener("click", () => {
      const collapsed = block.dataset.collapsed !== "true";
      block.dataset.collapsed = String(collapsed);
      head.setAttribute("aria-expanded", String(!collapsed));
    });
  });

  /* ------------------------------------------------------------ 应用主题 */

  function renderAppGrid() {
    const frag = document.createDocumentFragment();
    for (const theme of APP_THEMES) {
      frag.append(
        themeCard(
          theme.id,
          bi(theme.name),
          [
            { appearance: "light", palette: theme.light },
            { appearance: "dark", palette: theme.dark },
          ],
          theme.id === settings.appTheme,
        ),
      );
    }
    appGrid.replaceChildren(frag);
  }

  /* ------------------------------------------------------------ 帧率上限 */

  /** 帧率档位按钮：`0` 显示成「不限」。 */
  function renderFrameRates() {
    const frag = document.createDocumentFragment();
    for (const fps of FRAME_RATE_CHOICES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "seg";
      btn.dataset.fps = String(fps);
      btn.textContent =
        fps === 0
          ? t("settings.general.frameRateUnlimited")
          : t("settings.general.frameRateUnit", { fps });
      const active = fps === settings.frameRate;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
      btn.addEventListener("click", () => void prefs.patch({ frameRate: fps }));
      frag.append(btn);
    }
    frameRateGroup.replaceChildren(frag);
  }

  /* ---------------------------------------------------------- 持续监听 */

  /** 当前该显示哪一句状态：没目标 / 在等目标 / 正在采目标 / 记住了但没采。 */
  function renderMonitorState() {
    const target = settings.monitorTarget;
    if (!target) {
      monitorState.textContent = t("settings.general.monitorNone");
      monitorState.dataset.state = "none";
      return;
    }
    if (lastTick?.waiting) {
      monitorState.textContent = t("settings.general.monitorWaiting", { name: target });
      monitorState.dataset.state = "waiting";
      return;
    }
    if (lastTick?.active) {
      monitorState.textContent = t("settings.general.monitorActive", { name: target });
      monitorState.dataset.state = "active";
      return;
    }
    // 目标记着、手上却没在采：用户点过停止就是这种状态，别写成"正在监听"
    monitorState.textContent = t("settings.general.monitorRemembered", { name: target });
    monitorState.dataset.state = "none";
  }

  function renderMonitor() {
    // 别在用户打字的时候把输入框覆盖掉
    if (document.activeElement !== monitorInput) monitorInput.value = settings.monitorTarget;
    monitorSetBtn.disabled = monitorBusy;
    monitorClearBtn.disabled = monitorBusy || settings.monitorTarget === "";
    monitorPickBtn.disabled = monitorBusy;
    renderMonitorState();
  }

  /**
   * 设置 / 清除持续监听对象。
   *
   * 走的是专用命令而不是 `prefs.patch`：它有副作用（目标在跑就切过去采，不在跑就等），
   * 前端只要把用户填的进程名交出去就行，其余由后端定夺。
   */
  async function applyMonitorTarget(name: string) {
    if (!setMonitorTarget) return;
    monitorBusy = true;
    renderMonitor();
    try {
      const target = name.trim().toLowerCase();
      await setMonitorTarget(target);
      // 只说"设好了"：到底是立刻在采还是在等它出现，由后端算，界面按 tick 显示
      log?.(
        target
          ? t("settings.general.monitorSetLog", { name: target })
          : t("settings.general.monitorCleared"),
      );
    } catch (err) {
      log?.(t("settings.general.monitorFailed", { err: String(err) }), "error");
    } finally {
      monitorBusy = false;
      renderMonitor();
    }
  }

  /* ------------------------------------------------------------ 悬浮球配色 */

  function patchColors(next: string[]) {
    void prefs.patch({ ballColors: next });
  }

  function setSlot(index: number, color: string) {
    const next = [...settings.ballColors];
    next[index] = color;
    patchColors(next);
  }

  /** 色槽表：一行一个颜色（取色器 + 手填十六进制 + 删除）。 */
  function renderColorSlots() {
    const colors = settings.ballColors;
    const frag = document.createDocumentFragment();

    colors.forEach((color, index) => {
      const row = document.createElement("div");
      row.className = "color-slot";

      const swatch = document.createElement("input");
      swatch.type = "color";
      swatch.className = "slot-swatch";
      swatch.value = color;
      swatch.addEventListener("input", () => setSlot(index, swatch.value));

      const text = document.createElement("input");
      text.type = "text";
      text.className = "slot-text";
      text.value = color;
      text.spellcheck = false;
      text.addEventListener("change", () => {
        if (HEX.test(text.value.trim())) setSlot(index, text.value.trim().toLowerCase());
        // 打错了就退回原值，不把半截输入写进设置
        else text.value = color;
      });

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "slot-remove";
      remove.textContent = "×";
      remove.title = t("settings.ball.slotRemove");
      remove.disabled = colors.length <= 1;
      remove.addEventListener("click", () => {
        const next = colors.filter((_, i) => i !== index);
        if (next.length > 0) patchColors(next);
      });

      row.append(swatch, text, remove);
      frag.append(row);
    });

    colorSlots.replaceChildren(frag);
    colorAddBtn.disabled = colors.length >= MAX_BALL_COLORS;
  }

  function renderPresets() {
    const frag = document.createDocumentFragment();
    for (const preset of BALL_COLOR_PRESETS) {
      frag.append(presetCard(preset, settings.ballColors));
    }
    colorPresets.replaceChildren(frag);
  }

  /* ------------------------------------------------------------ 悬浮球样式 */

  function renderStyleGrids() {
    const inner = ballStyleById(settings.ballInnerStyle, "inner");
    const outer = ballStyleById(settings.ballOuterStyle, "outer");

    const innerFrag = document.createDocumentFragment();
    for (const style of BALL_INNER_STYLES) {
      innerFrag.append(styleCard(style, inner, outer, style.id === inner.id));
    }
    innerGrid.replaceChildren(innerFrag);

    const outerFrag = document.createDocumentFragment();
    for (const style of BALL_OUTER_STYLES) {
      outerFrag.append(styleCard(style, inner, outer, style.id === outer.id));
    }
    outerGrid.replaceChildren(outerFrag);

    // 卡片插进 DOM 之后再画：此时画布拿得到真实的 CSS 尺寸
    const colors = orbColorsFrom(settings.ballColors);
    paintStylePreviews(innerGrid, colors);
    paintStylePreviews(outerGrid, colors);

    innerNote.textContent = t(`ballStyle.source.hint.${settings.ballInnerSource}`);
    outerNote.textContent = t(`ballStyle.source.hint.${settings.ballOuterSource}`);
  }

  /** 一排数据源按钮：点一下就把这一圈的数据源换掉。 */
  function fillSourceGroup(
    group: HTMLElement,
    current: string,
    patchKey: "ballInnerSource" | "ballOuterSource",
  ) {
    const frag = document.createDocumentFragment();
    for (const source of BALL_DATA_SOURCES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "seg";
      btn.dataset.source = source;
      btn.textContent = sourceName(source);
      btn.title = t(`ballStyle.source.hint.${source}`);
      const active = source === current;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
      btn.addEventListener("click", () => void prefs.patch({ [patchKey]: source }));
      frag.append(btn);
    }
    group.replaceChildren(frag);
  }

  function renderSourceGroups() {
    fillSourceGroup(innerSourceGroup, settings.ballInnerSource, "ballInnerSource");
    fillSourceGroup(outerSourceGroup, settings.ballOuterSource, "ballOuterSource");
  }

  /* ------------------------------------------------------- 尺寸与律动 */

  function renderMotion() {
    sizeInput.value = String(settings.ballSize);
    sizeValue.textContent = settings.ballSize.toFixed(1);
    gainInput.value = String(settings.ballGain);
    gainValue.textContent = settings.ballGain.toFixed(1);
    pulseAmountInput.value = String(settings.ballPulseAmount);
    pulseAmountValue.textContent = settings.ballPulseAmount.toFixed(1);
    pulseBox.checked = settings.ballPulse;
    pulseAmountInput.disabled = !settings.ballPulse;

    const frag = document.createDocumentFragment();
    for (const algorithm of BALL_PULSE_ALGORITHMS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "seg";
      btn.dataset.algorithm = algorithm.id;
      btn.textContent = t(`ballPulse.${algorithm.id}`);
      btn.title = t(`ballPulse.hint.${algorithm.id}`);
      const active = algorithm.id === settings.ballPulseAlgorithm;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
      btn.addEventListener("click", () => void prefs.patch({ ballPulseAlgorithm: algorithm.id }));
      frag.append(btn);
    }
    pulseGroup.replaceChildren(frag);

    const enabled = settings.ballPulse;
    pulseGroup.classList.toggle("is-disabled", !enabled);
    pulseNote.textContent = t(`ballPulse.hint.${settings.ballPulseAlgorithm}`);

    lockedBox.checked = settings.ballLocked;
  }

  /* ------------------------------------------------------------- 窗口名单 */

  /**
   * 名单里的一条。
   *
   * `locked` 那条就是本应用自己（`getSelfName()`）：后端把"采集自己被挡掉"做成硬规则，
   * 界面只负责展示 —— 删除按钮直接禁用，点不动比点了报错友好。
   */
  function nameItem(name: string, kind: "allow" | "block"): HTMLLIElement {
    const item = document.createElement("li");
    const locked = kind === "block" && name === getSelfName();
    item.className = "name-item";
    if (locked) item.classList.add("is-locked");

    const text = document.createElement("span");
    text.className = "name-text";
    text.textContent = name;
    item.append(text);

    if (locked) {
      const badge = document.createElement("span");
      badge.className = "name-badge";
      badge.textContent = t("settings.window.self");
      badge.title = t("settings.window.selfTitle");
      item.append(badge);
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "name-remove";
    remove.textContent = "✕";
    remove.disabled = locked;
    remove.title = locked ? t("settings.window.selfTitle") : t("settings.window.remove", { name });
    remove.addEventListener("click", () => void removeName(name, kind));
    item.append(remove);

    return item;
  }

  function renderNameLists() {
    const fill = (host: HTMLUListElement, names: string[], kind: "allow" | "block") => {
      if (names.length === 0) {
        const empty = document.createElement("li");
        empty.className = "name-empty";
        empty.textContent = t("settings.window.empty");
        host.replaceChildren(empty);
        return;
      }
      const frag = document.createDocumentFragment();
      for (const name of names) frag.append(nameItem(name, kind));
      host.replaceChildren(frag);
    };
    fill(allowItems, settings.windowAllowlist, "allow");
    fill(blockItems, settings.windowBlocklist, "block");
  }

  /** 名单里加一条。去重与转小写由 `normalize` 兜底，这里只管提示与落盘。 */
  async function addName(kind: "allow" | "block", raw: string): Promise<boolean> {
    const name = raw.trim().toLowerCase();
    if (!name) return false;

    const list = kind === "allow" ? settings.windowAllowlist : settings.windowBlocklist;
    if (list.includes(name)) {
      log?.(t("settings.window.duplicate", { name }), "warn");
      return false;
    }

    const next = [...list, name];
    try {
      await prefs.patch(kind === "allow" ? { windowAllowlist: next } : { windowBlocklist: next });
      log?.(t("settings.window.added", { name }));
      return true;
    } catch (err) {
      log?.(t("settings.window.saveFailed", { err: String(err) }), "error");
      return false;
    }
  }

  async function removeName(name: string, kind: "allow" | "block") {
    // 黑名单里的本程序是后端的硬规则，删掉也会被补回来 —— 干脆当没这回事
    if (kind === "block" && name === getSelfName()) return;

    const list = kind === "allow" ? settings.windowAllowlist : settings.windowBlocklist;
    const next = list.filter((entry) => entry !== name);
    try {
      await prefs.patch(kind === "allow" ? { windowAllowlist: next } : { windowBlocklist: next });
    } catch (err) {
      log?.(t("settings.window.saveFailed", { err: String(err) }), "error");
    }
  }

  const wireNameInput = (
    kind: "allow" | "block",
    input: HTMLInputElement,
    button: HTMLButtonElement,
  ) => {
    const submit = () => {
      void addName(kind, input.value).then((added) => {
        if (added) input.value = "";
      });
    };
    button.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submit();
    });
  };
  wireNameInput("allow", allowInput, allowAddBtn);
  wireNameInput("block", blockInput, blockAddBtn);

  /* -------------------------------------------------------------- 控件同步 */

  function renderControls() {
    modeGroup.querySelectorAll<HTMLButtonElement>(".seg").forEach((btn) => {
      const active = btn.dataset.mode === settings.themeMode;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
    langGroup.querySelectorAll<HTMLButtonElement>(".seg").forEach((btn) => {
      const active = btn.dataset.lang === settings.language;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
    autoFollowBox.checked = settings.autoFollow;

    renderFrameRates();
    renderMonitor();
    renderAppGrid();
    renderColorSlots();
    renderPresets();
    renderStyleGrids();
    renderSourceGroups();
    renderMotion();
    renderNameLists();
  }

  function sync(next: Settings) {
    settings = next;
    renderControls();
  }

  /* ------------------------------------------------------------------ 内核 */

  function syncKernel(status: DllStatus | null) {
    knStatus.classList.remove("is-ok", "is-bad");
    if (!status) {
      knStatus.classList.add("is-bad");
      knStatusText.textContent = t("kernel.missing");
      knVersion.textContent = "—";
      knPath.textContent = "—";
      knExpected.textContent = "—";
      knCandidates.replaceChildren();
      return;
    }

    knStatus.classList.add(status.loaded ? "is-ok" : "is-bad");
    knStatusText.textContent = status.loaded
      ? t("kernel.ready", { version: status.version })
      : t("kernel.missing");
    knStatusDot.title = status.error ?? "";
    knVersion.textContent = status.version ? `v${status.version}` : "—";
    knPath.textContent = status.path ?? (status.error || "—");
    knExpected.textContent = status.expectedDir;

    if (status.found.length === 0) {
      const li = document.createElement("li");
      li.className = "kn-missing";
      li.textContent = t("settings.kernel.none");
      knCandidates.replaceChildren(li);
    } else {
      const frag = document.createDocumentFragment();
      status.found.forEach((path, index) => {
        const li = document.createElement("li");
        if (index === 0) li.classList.add("is-first");
        li.textContent = path;
        frag.append(li);
      });
      knCandidates.replaceChildren(frag);
    }
  }

  /* ---------------------------------------------------------------- 交互 */

  overlay.querySelectorAll<HTMLButtonElement>(".settings-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const name = tab.dataset.tab;
      overlay.querySelectorAll<HTMLButtonElement>(".settings-tab").forEach((other) => {
        other.classList.toggle("is-active", other === tab);
      });
      overlay.querySelectorAll<HTMLElement>(".settings-pane").forEach((pane) => {
        pane.classList.toggle("is-active", pane.dataset.pane === name);
      });
    });
  });

  modeGroup.addEventListener("click", (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLButtonElement>(".seg");
    if (!btn?.dataset.mode) return;
    void prefs.patch({ themeMode: btn.dataset.mode as Settings["themeMode"] });
  });

  langGroup.addEventListener("click", (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLButtonElement>(".seg");
    if (!btn?.dataset.lang) return;
    void prefs.patch({ language: btn.dataset.lang as Settings["language"] });
  });

  autoFollowBox.addEventListener("change", () => {
    void prefs.patch({ autoFollow: autoFollowBox.checked });
  });

  monitorSetBtn.addEventListener("click", () => void applyMonitorTarget(monitorInput.value));
  monitorClearBtn.addEventListener("click", () => void applyMonitorTarget(""));
  monitorInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void applyMonitorTarget(monitorInput.value);
  });
  monitorPickBtn.addEventListener("click", () => {
    const name = selectedProcess?.();
    if (!name) {
      log?.(t("settings.general.monitorNoSelection"), "warn");
      return;
    }
    monitorInput.value = name;
    void applyMonitorTarget(name);
  });

  lockedBox.addEventListener("change", () => {
    void prefs.patch({ ballLocked: lockedBox.checked });
  });

  appGrid.addEventListener("click", (event) => {
    const card = (event.target as HTMLElement).closest<HTMLButtonElement>(".theme-card");
    const id = card?.dataset.themeId;
    if (id) void prefs.patch({ appTheme: id });
  });

  colorAddBtn.addEventListener("click", () => {
    if (settings.ballColors.length >= MAX_BALL_COLORS) return;
    // 新槽位接在最后一个颜色的后面，加进去就有变化可看
    const last = settings.ballColors[settings.ballColors.length - 1] ?? DEFAULT_BALL_COLOR;
    patchColors([...settings.ballColors, last]);
  });

  colorPresets.addEventListener("click", (event) => {
    const card = (event.target as HTMLElement).closest<HTMLButtonElement>(".preset-card");
    const index = card ? [...colorPresets.children].indexOf(card) : -1;
    const preset = BALL_COLOR_PRESETS[index];
    if (preset) patchColors([...preset.colors]);
  });

  innerGrid.addEventListener("click", (event) => {
    const card = (event.target as HTMLElement).closest<HTMLButtonElement>(".style-card");
    const id = card?.dataset.styleId;
    if (id) void prefs.patch({ ballInnerStyle: id });
  });

  outerGrid.addEventListener("click", (event) => {
    const card = (event.target as HTMLElement).closest<HTMLButtonElement>(".style-card");
    const id = card?.dataset.styleId;
    if (id) void prefs.patch({ ballOuterStyle: id });
  });

  // 滑块拖动时只更新数字，松手（change）才落盘，免得一路写文件
  sizeInput.addEventListener("input", () => {
    sizeValue.textContent = Number(sizeInput.value).toFixed(1);
  });
  sizeInput.addEventListener("change", () => {
    void prefs.patch({ ballSize: Number(sizeInput.value) });
  });

  gainInput.addEventListener("input", () => {
    gainValue.textContent = Number(gainInput.value).toFixed(1);
  });
  gainInput.addEventListener("change", () => {
    void prefs.patch({ ballGain: Number(gainInput.value) });
  });

  pulseAmountInput.addEventListener("input", () => {
    pulseAmountValue.textContent = Number(pulseAmountInput.value).toFixed(1);
  });
  pulseAmountInput.addEventListener("change", () => {
    void prefs.patch({ ballPulseAmount: Number(pulseAmountInput.value) });
  });

  pulseBox.addEventListener("change", () => {
    void prefs.patch({ ballPulse: pulseBox.checked });
  });

  resetBtn.addEventListener("click", () => {
    void prefs.patch({ appTheme: DEFAULT_APP_THEME, themeMode: "system" });
  });

  ballResetBtn.addEventListener("click", () => {
    void prefs.patch({
      ballColors: [DEFAULT_BALL_COLOR],
      ballInnerStyle: DEFAULT_BALL_INNER_STYLE,
      ballOuterStyle: DEFAULT_BALL_OUTER_STYLE,
      ballInnerSource: "",
      ballOuterSource: "",
      ballSize: 1,
      ballGain: 1,
      ballPulse: false,
      ballPulseAlgorithm: DEFAULT_BALL_PULSE_ALGORITHM,
      ballPulseAmount: DEFAULT_BALL_PULSE_AMOUNT,
    });
  });

  reloadBtn.addEventListener("click", async () => {
    reloadBtn.disabled = true;
    try {
      const status = await reloadKernel();
      syncKernel(status);
      log?.(t("settings.kernel.reloaded2"), "info");
    } catch (err) {
      log?.(t("kernel.queryFailed", { err: String(err) }), "error");
    } finally {
      reloadBtn.disabled = false;
    }
  });

  scrim.addEventListener("click", () => close());
  closeBtn.addEventListener("click", () => close());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && opened) close();
  });

  function open() {
    opened = true;
    overlay.hidden = false;
    overlay.classList.add("is-open");
  }

  function close() {
    opened = false;
    overlay.classList.remove("is-open");
    overlay.hidden = true;
  }

  renderControls();

  return {
    open,
    close,
    toggle: () => (opened ? close() : open()),
    get isOpen() {
      return opened;
    },
    sync,
    syncKernel,
    syncMonitor(tick) {
      lastTick = tick;
      renderMonitorState();
    },
    relang: (next) => sync(next),
  };
}
