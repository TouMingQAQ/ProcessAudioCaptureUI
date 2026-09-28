/**
 * 设置面板（主界面左下角的「设置」按钮打开）。
 *
 * 三个 tab：
 * * 通用 —— 语言、自动跟随、默认录制；
 * * 主题 —— 深色模式 + 应用主题 + 悬浮球配色 + 悬浮球律动样式；
 * * 内核 —— 采集内核的加载状态与重新加载（原来挂在顶栏上，现在挪进来）。
 *
 * 主题卡片是真正"所见即所得"的：卡片里的浅色 / 深色两半各自带上那套主题的 CSS
 * 变量，里头的迷你界面用的全是和真实界面同一批 `var(--ui-*)`，所以预览长什么样、
 * 套上去就是什么样。
 *
 * 悬浮球这边分成两件事，设置里也是两块：
 * * **配色**（悬浮球主题）—— 只换颜色，卡片用 DOM 拼一个迷你小球；
 * * **律动样式** —— 决定小球长什么样、跟着频谱还是波形动，卡片里是一块真画布，
 *   跑的是悬浮球窗口那一份绘制代码（`renderOrb`），所以预览就是实物的样子。
 *
 * 样式名字与说明都按 id 去 `i18n.ts` 取（`ballStyle.<id>`），样式表里不再各写一份中英文。
 */

import type { DllStatus, Settings } from "./api";
import { bandsForFrame, type BallDataSource, type BallStyle } from "./ball-style";
import { colorsFromPalette, renderOrb, type BallFrame, type OrbColors } from "./ball-render";
import { bi, t } from "./i18n";
import type { SettingsBinding } from "./settings";
import {
  APP_THEMES,
  BALL_STYLES,
  BALL_THEMES,
  DEFAULT_APP_THEME,
  DEFAULT_BALL_DATA_SOURCE,
  DEFAULT_BALL_STYLE,
  DEFAULT_BALL_THEME,
  applyVars,
  ballThemeById,
  paletteStyle,
  resolveDataSource,
  type Appearance,
  type OrbPalette,
  type Palette,
} from "./theme";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少元素 #${id}`);
  return el as T;
};

/** 小球预览的画布边长（CSS 像素），和 `.style-card-orb` 的尺寸保持一致。 */
const PREVIEW_SIZE = 56;

/** 迷你界面骨架：一条侧栏 + 一个内容块 + 几根"频谱柱"。 */
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

/** 迷你小球：一圈环 + 中心球（只用来预览配色，形状差异在样式卡片里看）。 */
function mockOrb(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "mock-orb";
  const halo = document.createElement("span");
  halo.className = "mock-orb-halo";
  const ring = document.createElement("span");
  ring.className = "mock-orb-ring";
  const core = document.createElement("span");
  core.className = "mock-orb-core";
  wrap.append(halo, ring, core);
  return wrap;
}

interface Preview {
  appearance: Appearance;
  palette: Palette;
  /** 悬浮球主题才有：小球配色。 */
  orb?: OrbPalette;
}

/** 一张主题卡片：左右分别是浅色 / 深色预览。 */
function themeCard(
  id: string,
  name: string,
  appearances: Preview[],
  selected: boolean,
  withOrb: boolean,
): HTMLButtonElement {
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
    applyVars(half, paletteStyle(item.palette, item.orb));
    half.append(withOrb ? mockOrb() : mockApp());
    shot.append(half);
  }

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

  card.append(shot, meta);
  return card;
}

/* --------------------------------------------------------------- 样式卡片 */

/** 样式卡片里那块画布要用的固定假数据：同一份数据每次都画出同一张图，不会闪。 */
function previewFrame(style: BallStyle): BallFrame {
  const count = 48;
  const spectrum: number[] = [];
  const wave: number[] = [];
  for (let i = 0; i < count; i++) {
    const x = i / (count - 1);
    // 频谱：低音厚、往高音衰减，带一点起伏
    spectrum.push(Math.min(1, (0.9 - x * 0.5) * (0.7 + 0.3 * Math.sin(i * 0.7))));
    // 波形包络：中间一个明显的峰，两边收敛
    wave.push(Math.min(1, Math.abs(Math.sin(x * Math.PI * 2.4)) * (0.35 + 0.65 * Math.sin(x * Math.PI))));
  }
  const { bands, useWave, level } = bandsForFrame({ spectrum, wave }, style.mode, count);
  return { bands, useWave, level, peak: 0, live: true, time: 0 };
}

/** 数据源的名字（频谱 / 波形 / 自适应）。 */
function sourceName(source: BallDataSource): string {
  return t(`ballStyle.source.${source}`);
}

/**
 * 样式名字与说明都放在 `i18n.ts` 里（键名 `ballStyle.<id>` / `ballStyle.hint.<id>`），
 * 不跟着 `BALL_STYLES` 一起维护两份，避免"改了一处忘了另一处"。
 */
function styleName(style: BallStyle): string {
  return t(`ballStyle.${style.id}`);
}

/**
 * 一张律动样式卡片：上面是真画布预览，下面是名字与数据来源。
 *
 * 画布尺寸要等 `getBoundingClientRect` 有值，所以卡片插进 DOM 之后再画
 * （见 `paintStylePreviews`）。
 */
function styleCard(style: BallStyle, selected: boolean): HTMLButtonElement {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "style-card";
  card.dataset.styleId = style.id;
  card.setAttribute("aria-pressed", String(selected));
  card.title = t(`ballStyle.hint.${style.id}`);

  const shot = document.createElement("span");
  shot.className = "style-card-shot";
  const canvas = document.createElement("canvas");
  canvas.className = "style-card-orb";
  canvas.dataset.orbPreview = style.id;
  shot.append(canvas);

  const meta = document.createElement("span");
  meta.className = "style-card-meta";
  const label = document.createElement("span");
  label.className = "style-card-name";
  label.textContent = styleName(style);
  const origin = document.createElement("span");
  origin.className = "style-card-source";
  origin.textContent = sourceName(style.mode);
  meta.append(label, origin);

  if (selected) {
    const tag = document.createElement("span");
    tag.className = "style-card-tag";
    tag.textContent = t("settings.theme.current");
    shot.append(tag);
  }

  card.append(shot, meta);
  return card;
}

/** 把样式卡片里的画布逐个画出来（此时它们已经在 DOM 里，量得到尺寸）。 */
function paintStylePreviews(root: HTMLElement, colors: OrbColors) {
  root.querySelectorAll<HTMLCanvasElement>("canvas[data-orb-preview]").forEach((canvas) => {
    const style = BALL_STYLES.find((item) => item.id === canvas.dataset.orbPreview);
    if (!style) return;
    renderOrb(canvas, style, colors, previewFrame(style), PREVIEW_SIZE, window.devicePixelRatio || 1);
  });
}

export interface SettingsPanelOptions {
  prefs: SettingsBinding;
  /** 点「重新加载内核」时调用（主界面拿到的是 `reload_dll`）。 */
  reloadKernel: () => Promise<DllStatus>;
  /** 想往主界面日志里写一行就调它。 */
  log?: (message: string, kind?: "info" | "warn" | "error") => void;
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
  /** 语言变化后重刷所有文案（含主题卡片里的名字）。 */
  relang(settings: Settings): void;
}

export function createSettingsPanel(options: SettingsPanelOptions): SettingsPanel {
  const { prefs, reloadKernel, log } = options;

  const overlay = $<HTMLDivElement>("settings");
  const scrim = $<HTMLDivElement>("settings-scrim");
  const closeBtn = $<HTMLButtonElement>("settings-close");
  const modeGroup = $<HTMLDivElement>("theme-mode-group");
  const langGroup = $<HTMLDivElement>("language-group");
  const autoFollowBox = $<HTMLInputElement>("set-auto-follow");
  const recordWavBox = $<HTMLInputElement>("set-record-wav");
  const appGrid = $<HTMLDivElement>("app-theme-grid");
  const ballGrid = $<HTMLDivElement>("ball-theme-grid");
  const styleGrid = $<HTMLDivElement>("ball-style-grid");
  const sourceRow = $<HTMLDivElement>("ball-source-row");
  const sourceGroup = $<HTMLDivElement>("ball-source-group");
  const sourceNote = $<HTMLParagraphElement>("ball-source-note");
  const resetBtn = $<HTMLButtonElement>("theme-reset");
  const reloadBtn = $<HTMLButtonElement>("btn-kernel-reload");

  const knStatus = $<HTMLDivElement>("kn-status");
  const knStatusDot = $<HTMLSpanElement>("kn-status-dot");
  const knStatusText = $<HTMLSpanElement>("kn-status-text");
  const knVersion = $<HTMLSpanElement>("kn-version");
  const knPath = $<HTMLSpanElement>("kn-path");
  const knExpected = $<HTMLSpanElement>("kn-expected");
  const knCandidates = $<HTMLUListElement>("kn-candidates");

  let settings: Settings = prefs.get();
  let opened = false;

  /* ------------------------------------------------------------ 主题网格 */

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
          false,
        ),
      );
    }
    appGrid.replaceChildren(frag);
  }

  function renderBallGrid() {
    const frag = document.createDocumentFragment();
    for (const theme of BALL_THEMES) {
      frag.append(
        themeCard(
          theme.id,
          bi(theme.name),
          [
            { appearance: "light", palette: theme.light.panel, orb: theme.light.orb },
            { appearance: "dark", palette: theme.dark.panel, orb: theme.dark.orb },
          ],
          theme.id === settings.ballTheme,
          true,
        ),
      );
    }
    ballGrid.replaceChildren(frag);
  }

  /**
   * 律动样式网格：卡片里的画布用的是**当前悬浮球主题**的配色与真实绘制代码，
   * 所以在这里点样式之前就能看到"换成它长什么样"。
   */
  function renderStyleGrid() {
    const colors = colorsFromPalette(currentOrbPalette());
    const frag = document.createDocumentFragment();
    for (const style of BALL_STYLES) {
      frag.append(styleCard(style, style.id === settings.ballStyle));
    }
    styleGrid.replaceChildren(frag);
    paintStylePreviews(styleGrid, colors);
  }

  function currentOrbPalette(): OrbPalette {
    const appearance: Appearance =
      document.documentElement.dataset.appearance === "dark" ? "dark" : "light";
    return ballThemeById(settings.ballTheme)[appearance].orb;
  }

  /**
   * 数据源那一排。
   *
   * 样式只认一种数据时（例如「柱阵」天生是一排频谱柱）整排收起来 —— 摆一排点不动的
   * 按钮不如不摆，改成一句话说清楚它跟的是什么。
   */
  function renderSourceRow() {
    const style = BALL_STYLES.find((item) => item.id === settings.ballStyle) ?? BALL_STYLES[0];
    const choice = style.spectrum && style.wave;

    sourceRow.hidden = !choice;
    sourceNote.hidden = false;
    if (!choice) {
      sourceNote.textContent = t("settings.theme.ballSource.fixed", {
        style: styleName(style),
        source: sourceName(style.mode),
      });
      return;
    }

    sourceNote.textContent = t(`settings.theme.ballSource.hint.${settings.ballSource}`);
    sourceGroup.querySelectorAll<HTMLButtonElement>(".seg").forEach((btn) => {
      const active = btn.dataset.source === settings.ballSource;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
  }

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
    recordWavBox.checked = settings.recordWav;
    renderAppGrid();
    renderBallGrid();
    renderStyleGrid();
    renderSourceRow();
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

  recordWavBox.addEventListener("change", () => {
    void prefs.patch({ recordWav: recordWavBox.checked });
  });

  appGrid.addEventListener("click", (event) => {
    const card = (event.target as HTMLElement).closest<HTMLButtonElement>(".theme-card");
    const id = card?.dataset.themeId;
    if (id) void prefs.patch({ appTheme: id });
  });

  ballGrid.addEventListener("click", (event) => {
    const card = (event.target as HTMLElement).closest<HTMLButtonElement>(".theme-card");
    const id = card?.dataset.themeId;
    if (id) void prefs.patch({ ballTheme: id });
  });

  styleGrid.addEventListener("click", (event) => {
    const card = (event.target as HTMLElement).closest<HTMLButtonElement>(".style-card");
    const id = card?.dataset.styleId;
    if (!id) return;
    // 换了样式以后数据源要重新收敛：新样式可能画不出当前选的那份数据
    void prefs.patch({
      ballStyle: id,
      ballSource: resolveDataSource(id, settings.ballSource),
    });
  });

  sourceGroup.addEventListener("click", (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLButtonElement>(".seg");
    const source = btn?.dataset.source;
    if (!source) return;
    void prefs.patch({ ballSource: resolveDataSource(settings.ballStyle, source) });
  });

  resetBtn.addEventListener("click", () => {
    void prefs.patch({
      appTheme: DEFAULT_APP_THEME,
      ballTheme: DEFAULT_BALL_THEME,
      ballStyle: DEFAULT_BALL_STYLE,
      ballSource: DEFAULT_BALL_DATA_SOURCE,
      themeMode: "system",
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
    relang: (next) => sync(next),
  };
}
