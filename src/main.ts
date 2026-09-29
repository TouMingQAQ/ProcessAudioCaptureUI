import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "./styles.css";
import {
  EVT_AUDIO,
  EVT_CAPTURE_CHANGED,
  EVT_ERROR,
  EVT_MONITOR,
  EVT_STOPPED,
  api,
  type AudioFrameEvent,
  type AudioWindowInfo,
  type CaptureChanged,
  type DllStatus,
  type MonitorTick,
  type Settings,
  type StopReport,
} from "./api";
import { applyI18n, t } from "./i18n";
import { bindSettings } from "./settings";
import { createSettingsPanel, type SettingsPanel } from "./settings-panel";
import { Visualizer, formatDb } from "./visualizer";

/* ---------------------------------------------------------------- DOM 引用 */

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少元素 #${id}`);
  return el as T;
};

const btnRefresh = $<HTMLButtonElement>("btn-refresh");
const btnBall = $<HTMLButtonElement>("btn-ball");
const btnSettings = $<HTMLButtonElement>("btn-settings");
const btnCapture = $<HTMLButtonElement>("btn-capture");
const followMain = $<HTMLInputElement>("follow-main");
const searchInput = $<HTMLInputElement>("search");
const filterAudio = $<HTMLInputElement>("filter-audio");
const recordWav = $<HTMLInputElement>("record-wav");
const windowList = $<HTMLDivElement>("window-list");
const windowCount = $<HTMLSpanElement>("window-count");
const warningsBox = $<HTMLDivElement>("warnings");
const nowCapturing = $<HTMLDivElement>("now-capturing");
const sessionState = $<HTMLSpanElement>("session-state");
const waveMeta = $<HTMLSpanElement>("wave-meta");
const specMeta = $<HTMLSpanElement>("spec-meta");
const meterRms = $<HTMLDivElement>("meter-rms");
const meterPeak = $<HTMLDivElement>("meter-peak");
const meterRmsText = $<HTMLDivElement>("meter-rms-text");
const meterPeakText = $<HTMLDivElement>("meter-peak-text");
const logBox = $<HTMLDivElement>("log");

const visualizer = new Visualizer(
  $<HTMLCanvasElement>("canvas-wave"),
  $<HTMLCanvasElement>("canvas-spectrum"),
);

/* ------------------------------------------------------------------- 状态 */

const prefs = bindSettings("app");

let settings: Settings = prefs.get();
let panel: SettingsPanel | null = null;
let lastDllStatus: DllStatus | null = null;

let allWindows: AudioWindowInfo[] = [];
let selectedPid: number | null = null;
let capturingPid: number | null = null;
let autoFollow = false;
let ballVisible = true;
/** 当前会话状态（文案跟着语言变，所以要记住键而不是记住字符串）。 */
let sessionKey: "session.idle" | "session.live" | "session.failed" = "session.idle";
let sessionCls = "pill-idle";

/* ------------------------------------------------------------------- 日志 */

function log(message: string, kind: "info" | "warn" | "error" = "info") {
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const line = document.createElement("div");
  line.className = `log-line log-${kind}`;
  line.innerHTML = `<span class="log-time">${time}</span><span class="log-msg"></span>`;
  const msg = line.querySelector(".log-msg");
  if (msg) msg.textContent = message;
  logBox.prepend(line);
  while (logBox.childElementCount > 120) logBox.lastElementChild?.remove();
}

/* --------------------------------------------------------------- DLL 状态 */

function renderDllStatus(status: DllStatus) {
  lastDllStatus = status;
  btnCapture.disabled = !status.loaded || selectedPid === null;
  panel?.syncKernel(status);
}

async function refreshDllStatus(reload: boolean) {
  try {
    const status = reload ? await api.reloadDll() : await api.dllStatus();
    renderDllStatus(status);
    if (status.loaded) {
      log(t("kernel.reloaded", { path: status.path ?? "—", version: status.version }));
    } else {
      log(status.error ? t("kernel.notLoaded") : t("kernel.missing"), "error");
      log(t("kernel.placeHint", { dir: status.expectedDir }), "warn");
    }
  } catch (err) {
    log(t("kernel.queryFailed", { err: String(err) }), "error");
  }
}

/* --------------------------------------------------------------- 窗口列表 */

function sessionLabel(win: AudioWindowInfo): string {
  switch (win.sessionState) {
    case "active":
      return t("session.active");
    case "inactive":
      return t("session.inactive");
    case "expired":
      return t("session.expired");
    default:
      return t("session.none");
  }
}

function renderWindowList() {
  const keyword = searchInput.value.trim().toLowerCase();
  const onlyAudio = filterAudio.checked;

  const list = allWindows.filter((win) => {
    if (onlyAudio && win.sessionState !== "active") return false;
    if (!keyword) return true;
    return (
      win.title.toLowerCase().includes(keyword) ||
      win.processName.toLowerCase().includes(keyword) ||
      String(win.pid).includes(keyword)
    );
  });

  windowCount.textContent = t("list.count", { shown: list.length, total: allWindows.length });
  windowList.replaceChildren();

  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = allWindows.length === 0 ? t("list.none") : t("list.noMatch");
    windowList.append(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const win of list) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "win-item";
    item.setAttribute("role", "option");
    if (win.pid === selectedPid) item.classList.add("is-selected");
    if (win.pid === capturingPid) item.classList.add("is-capturing");
    item.title = win.processPath || win.title;

    const level = Math.min(Math.pow(win.sessionPeak, 0.5), 1) * 100;

    item.innerHTML = `
      <div class="win-main">
        <div class="win-title"></div>
        <div class="win-sub">
          <span class="win-proc"></span>
          <span class="win-pid">PID ${win.pid}</span>
        </div>
      </div>
      <div class="win-side">
        <span class="win-state state-${win.sessionState}"></span>
        <div class="win-meter"><i style="width:${level.toFixed(1)}%"></i></div>
      </div>
    `;

    item.querySelector(".win-title")!.textContent = win.title;
    const procEl = item.querySelector(".win-proc")!;
    procEl.textContent = win.processName || t("list.unknownProcess");
    if (!win.windowVisible) {
      // 没有窗口的进程（播放器缩在托盘里），标题是从系统媒体信息取的，标一下免得困惑
      const badge = document.createElement("span");
      badge.className = "win-badge";
      badge.textContent = t("list.trayBadge");
      badge.title = t("list.trayBadgeTitle");
      procEl.after(badge);
    }
    item.querySelector(".win-state")!.textContent = sessionLabel(win);

    item.addEventListener("click", () => selectWindow(win.pid));
    frag.append(item);
  }
  windowList.append(frag);
}

function renderSelected() {
  const win = allWindows.find((w) => w.pid === selectedPid) ?? null;
  const title = nowCapturing.querySelector(".nc-title")!;
  const sub = nowCapturing.querySelector(".nc-sub")!;
  if (win) {
    title.textContent = `${win.processName} — ${win.title}`;
    sub.textContent = t("view.pickedSub", {
      pid: win.pid,
      state: sessionLabel(win),
      peak: (win.sessionPeak * 100).toFixed(1),
    });
  } else {
    title.textContent = t("view.selected");
    sub.textContent = t("view.selectedSub");
  }
  btnCapture.disabled = !(lastDllStatus?.loaded ?? false) || selectedPid === null;
}

function selectWindow(pid: number | null) {
  if (capturingPid !== null && pid !== capturingPid) {
    log(t("list.stopFirst"), "warn");
    return;
  }
  selectedPid = pid;
  renderSelected();
  renderWindowList();
}

async function refreshWindows() {
  windowList.innerHTML = `<div class="empty">${t("list.enumerating")}</div>`;
  try {
    const result = await api.listWindows();
    allWindows = result.windows;

    warningsBox.hidden = result.warnings.length === 0;
    warningsBox.textContent = result.warnings.join(" | ");

    if (selectedPid !== null && !allWindows.some((w) => w.pid === selectedPid)) {
      selectWindow(null);
    }
    renderWindowList();
    log(t("list.enumerated", { n: allWindows.length }));
  } catch (err) {
    windowList.innerHTML = `<div class="empty">${t("list.enumerateFailed")}</div>`;
    log(t("list.enumerateFailedLog", { err: String(err) }), "error");
  }
}

/* ----------------------------------------------------------------- 采集 */

async function startCapture() {
  if (selectedPid === null) return;
  const win = allWindows.find((w) => w.pid === selectedPid);
  btnCapture.disabled = true;
  btnCapture.textContent = t("view.capturing");

  try {
    const report = await api.startCapture(selectedPid, win?.processName ?? "", recordWav.checked);
    capturingPid = report.pid;
    visualizer.reset();
    setSessionState("session.live", "pill-live");
    btnCapture.textContent = t("view.stop");
    btnCapture.disabled = false;
    btnCapture.classList.remove("btn-primary");
    btnCapture.classList.add("btn-danger");
    log(
      t("capture.started", {
        name: report.processName,
        pid: report.pid,
        rate: report.sampleRate || "?",
        channels: report.channels || "?",
      }),
    );
    if (report.wavPath) log(t("capture.recording", { path: report.wavPath }));
    report.warnings.forEach((w) => log(w, "warn"));
  } catch (err) {
    setSessionState("session.failed", "pill-error");
    btnCapture.textContent = t("view.capture");
    btnCapture.disabled = false;
    log(t("capture.startFailed", { err: String(err) }), "error");
  }
}

async function stopCapture() {
  btnCapture.disabled = true;
  btnCapture.textContent = t("view.stopping");
  try {
    const report = await api.stopCapture();
    handleStopped(report);
  } catch (err) {
    log(t("capture.stopFailed", { err: String(err) }), "error");
  } finally {
    btnCapture.disabled = false;
  }
}

/** 把"正在采集"那套界面复位。自己停的、别处（悬浮球 / 托盘）停的，都走这里。 */
function resetCaptureUi() {
  capturingPid = null;
  setSessionState("session.idle", "pill-idle");
  btnCapture.textContent = t("view.capture");
  btnCapture.classList.add("btn-primary");
  btnCapture.classList.remove("btn-danger");
  btnCapture.disabled = !(lastDllStatus?.loaded ?? false) || selectedPid === null;
  visualizer.reset();
  renderWindowList();
  refreshTexts();
}

/**
 * 把主界面拉到"别处已经改过"的采集状态。
 *
 * 采集不只从这里开始 —— 悬浮球和托盘都能开关，而主界面并不知道。两个 WebView 之间
 * 没有共享内存，只能靠这个函数对齐：`pac://capture-changed` 一到就查一次真实状态，
 * 每秒的扫描 tick 里也带着同样的字段，哪边先到就用哪边。
 */
function adoptCaptureState(active: boolean, pid: number | null, name: string | null) {
  if (active === (capturingPid !== null)) return;

  if (!active) {
    resetCaptureUi();
    log(t("capture.adoptedStop"));
    return;
  }

  capturingPid = pid;
  if (pid !== null) selectedPid = pid;
  visualizer.reset();
  setSessionState("session.live", "pill-live");
  btnCapture.textContent = t("view.stop");
  btnCapture.disabled = false;
  btnCapture.classList.remove("btn-primary");
  btnCapture.classList.add("btn-danger");
  renderWindowList();
  renderSelected();
  log(t("capture.adopted", { name: name ?? t("list.unknownProcess"), pid: pid ?? "—" }));
}

function handleStopped(report: StopReport | null) {
  resetCaptureUi();

  if (!report) {
    log(t("capture.nothing"));
    return;
  }

  log(
    t("capture.stopped", {
      name: report.processName,
      frames: report.totalFrames.toLocaleString(),
      seconds: (report.durationMs / 1000).toFixed(1),
      rate: report.sampleRate,
      channels: report.channels,
    }),
  );
  if (report.droppedSamples > 0) {
    log(t("capture.dropped", { n: report.droppedSamples.toLocaleString() }), "warn");
  }
  if (report.wavPath) {
    log(t("capture.wavSaved", { path: report.wavPath }));
  } else if (recordWav.checked) {
    log(t("capture.wavMissing"), "warn");
  }
  report.warnings.forEach((w) => log(w, "warn"));
}

function setSessionState(key: typeof sessionKey, cls: string) {
  sessionKey = key;
  sessionCls = cls;
  sessionState.textContent = t(key);
  sessionState.className = `pill ${cls}`;
}

/* ------------------------------------------------------------ 事件与初始化 */

function updateMeters(rms: number, peak: number) {
  const scale = (v: number) => Math.min(Math.pow(v, 0.45), 1) * 100;
  meterRms.style.width = `${scale(rms).toFixed(1)}%`;
  meterPeak.style.width = `${scale(peak).toFixed(1)}%`;
  meterRmsText.textContent = formatDb(rms);
  meterPeakText.textContent = formatDb(peak);
  meterRms.classList.toggle("is-hot", peak > 0.98);
}

/* ------------------------------------------------- 实时扫描 / 悬浮球联动 */

function syncBallButton() {
  btnBall.textContent = ballVisible ? t("ball.toggle.on") : t("ball.toggle.off");
  btnBall.setAttribute("aria-pressed", String(ballVisible));
}

/**
 * 后端每 1.2 秒扫一次音频会话，这里把「当前监听窗口」的信息实时反映到界面上 ——
 * 音乐软件切歌时窗口标题会跟着变。帧数 / 已运行时长不再展示。
 */
function applyTick(tick: MonitorTick) {
  if (tick.autoFollow !== autoFollow) {
    autoFollow = tick.autoFollow;
    followMain.checked = autoFollow;
  }

  // 悬浮球或托盘开关过采集时，主界面得跟上 —— 这是两个窗口之间唯一的同步途径
  adoptCaptureState(tick.active, tick.pid, tick.capturing?.processName ?? null);

  if (!tick.active || capturingPid === null) return;

  const name = tick.capturing?.processName ?? tick.processName ?? t("list.unknownProcess");
  const title = tick.capturing?.title?.trim() ?? "";
  const media = tick.media;
  const titleEl = nowCapturing.querySelector(".nc-title");
  const subEl = nowCapturing.querySelector(".nc-sub");
  // SMTC 的曲名比窗口标题更干净，优先用；窗口标题读不到时它也是唯一来源
  if (titleEl) titleEl.textContent = media?.title || title || name;
  if (subEl) {
    const who = media?.artist ? `${media.artist} · ${name}` : name;
    subEl.textContent = t("capture.tickSub", {
      who,
      pid: tick.pid ?? "—",
      rate: tick.sampleRate || "?",
      channels: tick.channels || "?",
    });
  }
}

/** 语言变化后，把动态生成过的文案全部重刷一遍。 */
function refreshTexts() {
  applyI18n();
  syncBallButton();
  sessionState.textContent = t(sessionKey);
  sessionState.className = `pill ${sessionCls}`;
  btnCapture.textContent = capturingPid !== null ? t("view.stop") : t("view.capture");
  waveMeta.textContent = t("view.metaWave", { n: 256 });
  specMeta.textContent = t("view.metaSpec", { n: 128 });
  renderWindowList();
  renderSelected();
}

async function bootstrap() {
  // 先落地主题与语言，避免默认配色闪一下再换
  settings = await prefs.load();
  // 画布是在模块顶层就建好的（那会儿主题还没读回来），这里按刚生效的主题补取一次色
  visualizer.refreshTheme();

  panel = createSettingsPanel({
    prefs,
    reloadKernel: () => api.reloadDll(),
    log: (message, kind) => log(message, kind),
  });

  visualizer.onRender = updateMeters;
  applyI18n();
  refreshTexts();

  // 记录 / 自动跟随这两个开关可能在上次运行时改过，先把界面同步过来
  recordWav.checked = settings.recordWav;
  followMain.checked = settings.autoFollow;

  const unlisteners: UnlistenFn[] = [];
  unlisteners.push(
    await listen<AudioFrameEvent>(EVT_AUDIO, (event) => {
      if (capturingPid === null) return;
      if (event.payload.pid !== capturingPid) return;
      visualizer.push(event.payload);
    }),
  );
  unlisteners.push(
    await listen<StopReport>(EVT_STOPPED, (event) => {
      if (capturingPid !== null) handleStopped(event.payload);
    }),
  );
  unlisteners.push(
    await listen<string>(EVT_ERROR, (event) => log(event.payload, "error")),
  );
  unlisteners.push(
    await listen<MonitorTick>(EVT_MONITOR, (event) => applyTick(event.payload)),
  );
  unlisteners.push(
    await listen<CaptureChanged>(EVT_CAPTURE_CHANGED, (event) => {
      log(event.payload.message, event.payload.switched ? "info" : "warn");
      // 悬浮球那边动过采集：拉一次真实状态跟着同步（事件本身不区分开始 / 停止）
      void api
        .captureStatus()
        .then((status) => adoptCaptureState(status.active, status.pid, status.processName))
        .catch(() => {});
    }),
  );
  unlisteners.push(
    await prefs.subscribe((next) => {
      settings = next;
      // 换了语言要把所有文案重刷，换了主题要重新读一次画布颜色
      visualizer.refreshTheme();
      recordWav.checked = next.recordWav;
      followMain.checked = next.autoFollow;
      autoFollow = next.autoFollow;
      refreshTexts();
      panel?.sync(next);
    }),
  );
  window.addEventListener("beforeunload", () => unlisteners.forEach((fn) => fn()));

  // 「跟随系统」时，系统切到深色要立刻跟着变（不写盘、不广播，只重套一次）
  prefs.watchSystem(() => {
    if (prefs.get().themeMode !== "system") return;
    prefs.reapply();
    visualizer.refreshTheme();
  });

  btnRefresh.addEventListener("click", () => {
    void refreshWindows();
  });
  btnSettings.addEventListener("click", () => panel?.toggle());
  searchInput.addEventListener("input", renderWindowList);
  filterAudio.addEventListener("change", renderWindowList);
  btnCapture.addEventListener("click", () => {
    if (capturingPid !== null) void stopCapture();
    else void startCapture();
  });
  btnBall.addEventListener("click", async () => {
    const next = !ballVisible;
    try {
      await api.setBallVisible(next);
      ballVisible = next;
      syncBallButton();
      log(ballVisible ? t("ball.shown") : t("ball.hidden"));
    } catch (err) {
      log(t("ball.toggleFailed", { err: String(err) }), "error");
    }
  });
  followMain.addEventListener("change", async () => {
    const wanted = followMain.checked;
    try {
      autoFollow = await api.setAutoFollow(wanted);
      followMain.checked = autoFollow;
      await prefs.patch({ autoFollow });
      log(autoFollow ? t("follow.on") : t("follow.off"));
    } catch (err) {
      followMain.checked = autoFollow;
      log(t("follow.failed", { err: String(err) }), "error");
    }
  });
  recordWav.addEventListener("change", () => {
    void prefs.patch({ recordWav: recordWav.checked });
  });

  await refreshDllStatus(false);
  await refreshWindows();

  // 有音频会话的窗口会不断变化，周期性刷新列表
  window.setInterval(() => {
    if (capturingPid === null && document.visibilityState === "visible") {
      void refreshWindows();
    }
  }, 5000);

  log(t("log.ready"));
}

void bootstrap();
