import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "./styles.css";
import {
  EVT_AUDIO,
  EVT_ERROR,
  EVT_STOPPED,
  api,
  type AudioFrameEvent,
  type AudioWindowInfo,
  type DllStatus,
  type StopReport,
} from "./api";
import { Visualizer, formatDb } from "./visualizer";

/* ---------------------------------------------------------------- DOM 引用 */

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少元素 #${id}`);
  return el as T;
};

const dllBadge = $<HTMLDivElement>("dll-badge");
const dllBadgeText = $<HTMLSpanElement>("dll-badge-text");
const btnReload = $<HTMLButtonElement>("btn-reload");
const btnRefresh = $<HTMLButtonElement>("btn-refresh");
const btnCapture = $<HTMLButtonElement>("btn-capture");
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
const statsText = $<HTMLDivElement>("stats-text");
const logBox = $<HTMLDivElement>("log");

const visualizer = new Visualizer(
  $<HTMLCanvasElement>("canvas-wave"),
  $<HTMLCanvasElement>("canvas-spectrum"),
);

/* ------------------------------------------------------------------- 状态 */

let allWindows: AudioWindowInfo[] = [];
let selectedPid: number | null = null;
let capturingPid: number | null = null;
let lastFrame: AudioFrameEvent | null = null;
let lastDllStatus: DllStatus | null = null;

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
  dllBadge.classList.remove("badge-muted", "badge-ok", "badge-error");

  if (status.loaded) {
    dllBadge.classList.add("badge-ok");
    dllBadgeText.textContent = `DLL v${status.version} 已加载`;
    dllBadge.title = status.path ?? "";
  } else {
    dllBadge.classList.add("badge-error");
    dllBadgeText.textContent = "DLL 未加载";
    dllBadge.title = status.error ?? "";
  }

  btnCapture.disabled = !status.loaded || selectedPid === null;
}

async function refreshDllStatus(reload: boolean) {
  try {
    const status = reload ? await api.reloadDll() : await api.dllStatus();
    renderDllStatus(status);
    if (status.loaded) {
      log(`DLL 已加载：${status.path}（版本 ${status.version}）`);
    } else {
      log(status.error ?? "DLL 未加载", "error");
      log(`请把 ProcessAudioCapture.dll 放到：${status.expectedDir}`, "warn");
    }
  } catch (err) {
    log(`查询 DLL 状态失败：${String(err)}`, "error");
  }
}

/* --------------------------------------------------------------- 窗口列表 */

function sessionLabel(win: AudioWindowInfo): string {
  switch (win.sessionState) {
    case "active":
      return "正在播放";
    case "inactive":
      return "会话空闲";
    case "expired":
      return "会话已失效";
    default:
      return "无音频会话";
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

  windowCount.textContent = `${list.length} / ${allWindows.length}`;
  windowList.replaceChildren();

  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = allWindows.length === 0 ? "没有找到可捕获的窗口" : "没有匹配的窗口";
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
    item.querySelector(".win-proc")!.textContent = win.processName || "未知进程";
    item.querySelector(".win-state")!.textContent = sessionLabel(win);

    item.addEventListener("click", () => selectWindow(win.pid));
    frag.append(item);
  }
  windowList.append(frag);
}

function selectWindow(pid: number | null) {
  if (capturingPid !== null && pid !== capturingPid) {
    log("请先停止当前采集再切换窗口", "warn");
    return;
  }
  selectedPid = pid;
  const win = allWindows.find((w) => w.pid === pid) ?? null;

  const title = nowCapturing.querySelector(".nc-title")!;
  const sub = nowCapturing.querySelector(".nc-sub")!;
  if (win) {
    title.textContent = `${win.processName} — ${win.title}`;
    sub.textContent = `PID ${win.pid} · ${sessionLabel(win)} · 会话峰值 ${(win.sessionPeak * 100).toFixed(1)}%`;
  } else {
    title.textContent = "尚未选择窗口";
    sub.textContent = '从左侧列表选择一个正在播放声音的窗口，然后点击"开始采集"';
  }

  btnCapture.disabled = !(lastDllStatus?.loaded ?? false) || pid === null;
  renderWindowList();
}

async function refreshWindows() {
  windowList.innerHTML = '<div class="empty">正在枚举窗口…</div>';
  try {
    const result = await api.listWindows();
    allWindows = result.windows;

    warningsBox.hidden = result.warnings.length === 0;
    warningsBox.textContent = result.warnings.join(" | ");

    if (selectedPid !== null && !allWindows.some((w) => w.pid === selectedPid)) {
      selectWindow(null);
    }
    renderWindowList();
    log(`枚举到 ${allWindows.length} 个可见窗口`);
  } catch (err) {
    windowList.innerHTML = '<div class="empty">枚举窗口失败</div>';
    log(`枚举窗口失败：${String(err)}`, "error");
  }
}

/* ----------------------------------------------------------------- 采集 */

async function startCapture() {
  if (selectedPid === null) return;
  const win = allWindows.find((w) => w.pid === selectedPid);
  btnCapture.disabled = true;
  btnCapture.textContent = "激活中…";

  try {
    const report = await api.startCapture(selectedPid, win?.processName ?? "", recordWav.checked);
    capturingPid = report.pid;
    lastFrame = null;
    visualizer.reset();
    setSessionState("采集进行中", "pill-live");
    btnCapture.textContent = "停止采集";
    btnCapture.disabled = false;
    btnCapture.classList.remove("btn-primary");
    btnCapture.classList.add("btn-danger");
    log(
      `开始采集 ${report.processName} (PID ${report.pid})，格式 ${report.sampleRate || "?"} Hz / ${
        report.channels || "?"
      } 声道`,
    );
    if (report.wavPath) log(`录制中：${report.wavPath}`);
    report.warnings.forEach((w) => log(w, "warn"));
  } catch (err) {
    setSessionState("采集失败", "pill-error");
    btnCapture.textContent = "开始采集";
    btnCapture.disabled = false;
    log(`启动采集失败：${String(err)}`, "error");
  }
}

async function stopCapture() {
  btnCapture.disabled = true;
  btnCapture.textContent = "停止中…";
  try {
    const report = await api.stopCapture();
    handleStopped(report);
  } catch (err) {
    log(`停止采集失败：${String(err)}`, "error");
  } finally {
    btnCapture.disabled = false;
  }
}

function handleStopped(report: StopReport | null) {
  capturingPid = null;
  setSessionState("未采集", "pill-idle");
  btnCapture.textContent = "开始采集";
  btnCapture.classList.add("btn-primary");
  btnCapture.classList.remove("btn-danger");
  btnCapture.disabled = !(lastDllStatus?.loaded ?? false) || selectedPid === null;
  visualizer.reset();
  renderWindowList();

  if (!report) {
    log("没有正在进行的采集");
    return;
  }

  const seconds = report.durationMs / 1000;
  log(
    `已停止：${report.processName} · 共 ${report.totalFrames.toLocaleString()} 帧 / ${seconds.toFixed(
      1,
    )} 秒 · ${report.sampleRate} Hz ${report.channels}ch`,
  );
  if (report.droppedSamples > 0) {
    log(`因缓冲溢出丢弃了 ${report.droppedSamples.toLocaleString()} 个采样`, "warn");
  }
  if (report.wavPath) {
    log(`WAV 已保存：${report.wavPath}`);
  } else if (recordWav.checked) {
    log("未生成 WAV（可能未收到任何音频数据）", "warn");
  }
  report.warnings.forEach((w) => log(w, "warn"));
}

function setSessionState(text: string, cls: string) {
  sessionState.textContent = text;
  sessionState.className = `pill ${cls}`;
}

/* ------------------------------------------------------------ 事件与初始化 */

function updateMeters(rms: number, peak: number, stale: boolean) {
  const scale = (v: number) => Math.min(Math.pow(v, 0.45), 1) * 100;
  meterRms.style.width = `${scale(rms).toFixed(1)}%`;
  meterPeak.style.width = `${scale(peak).toFixed(1)}%`;
  meterRmsText.textContent = formatDb(rms);
  meterPeakText.textContent = formatDb(peak);
  meterRms.classList.toggle("is-hot", peak > 0.98);

  const frame = lastFrame;
  if (!frame || stale) {
    if (capturingPid === null) statsText.textContent = "—";
    return;
  }
  const seconds = frame.elapsedMs / 1000;
  statsText.textContent = `${frame.totalFrames.toLocaleString()} 帧 · ${seconds.toFixed(
    1,
  )}s · ${frame.windowMs.toFixed(0)}ms/帧`;
  waveMeta.textContent = `${frame.waveform.length} 点包络`;
  specMeta.textContent = `${frame.spectrum.length} 柱`;
}

async function bootstrap() {
  visualizer.onRender = updateMeters;

  const unlisteners: UnlistenFn[] = [];
  unlisteners.push(
    await listen<AudioFrameEvent>(EVT_AUDIO, (event) => {
      if (capturingPid === null) return;
      if (event.payload.pid !== capturingPid) return;
      lastFrame = event.payload;
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
  window.addEventListener("beforeunload", () => unlisteners.forEach((fn) => fn()));

  btnReload.addEventListener("click", () => refreshDllStatus(true));
  btnRefresh.addEventListener("click", () => {
    void refreshWindows();
  });
  searchInput.addEventListener("input", renderWindowList);
  filterAudio.addEventListener("change", renderWindowList);
  btnCapture.addEventListener("click", () => {
    if (capturingPid !== null) void stopCapture();
    else void startCapture();
  });

  await refreshDllStatus(false);
  await refreshWindows();

  // 有音频会话的窗口会不断变化，周期性刷新列表
  window.setInterval(() => {
    if (capturingPid === null && document.visibilityState === "visible") {
      void refreshWindows();
    }
  }, 5000);

  log("就绪。先让目标窗口播放声音，再从左侧选择它。");
}

void bootstrap();
