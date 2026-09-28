import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./ball.css";
import {
  EVT_AUDIO,
  EVT_BALL_HOVER,
  EVT_CAPTURE_CHANGED,
  EVT_MONITOR,
  EVT_STOPPED,
  api,
  type AudioFrameEvent,
  type AudioWindowInfo,
  type BallHover,
  type CaptureChanged,
  type CaptureStatus,
  type MediaInfo,
  type MonitorTick,
  type StopReport,
} from "./api";
import { applyI18n, t } from "./i18n";
import { bindSettings } from "./settings";
import { OrbVisualizer, formatDb } from "./orb";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少元素 #${id}`);
  return el as T;
};

const stage = $<HTMLDivElement>("stage");
const orb = $<HTMLButtonElement>("orb");
const panel = $<HTMLElement>("panel");
const nowName = $<HTMLDivElement>("now-name");
const nowTitle = $<HTMLDivElement>("now-title");
const nowState = $<HTMLSpanElement>("now-state");
const meterFill = $<HTMLElement>("meter-fill");
const meterText = $<HTMLSpanElement>("meter-text");
const candidateBox = $<HTMLDivElement>("candidate");
const candidateText = $<HTMLSpanElement>("candidate-text");
const btnCapture = $<HTMLButtonElement>("btn-capture");
const btnFollow = $<HTMLButtonElement>("btn-follow");
const btnMain = $<HTMLButtonElement>("btn-main");
const hint = $<HTMLParagraphElement>("hint");

const visualizer = new OrbVisualizer($<HTMLCanvasElement>("orb-canvas"));
const appWindow = getCurrentWindow();
const prefs = bindSettings("ball");

let capturing = false;
let autoFollow = false;
let busy = false;
let expanded = false;
let hintTimer = 0;
/** 最近一次扫描结果：语言一变要用新语言把这一tick 重新渲染一遍。 */
let lastTick: MonitorTick | null = null;

/* ------------------------------------------------------------- 悬停展开 */

/**
 * 悬停状态由后端给（见 `src-tauri/src/ball.rs`），这里只负责切样式。
 *
 * 为什么不在这里监听 mouseenter/mouseleave 再改窗口尺寸：小球窗口的尺寸是**恒定**
 * 的，展开 / 收起只是显示或隐藏面板，窗口既不缩放也不移动。一旦让窗口缩放，WebView
 * 的布局视口（= 窗口客户区）会晚一帧才跟上，那一帧里内容仍按旧视口排版、却已经画在
 * 新窗口的左上角 —— 小球就会"飞"一下。所以缩放这条路整个拿掉，悬停改由后端轮询
 * 光标位置判断；顺带的好处是"鼠标在面板上"也算悬停，跨过小球与面板之间的缝隙时
 * 不会因为两个元素各自的 mouseleave 时序对不上而抖。
 */
function applyHover(hovered: boolean) {
  if (expanded === hovered) return;
  expanded = hovered;
  stage.classList.toggle("is-expanded", hovered);
  panel.setAttribute("aria-hidden", hovered ? "false" : "true");
}

void listen<BallHover>(EVT_BALL_HOVER, (event) => applyHover(event.payload.hovered));

/* ----------------------------------------------------------------- 拖拽 */

orb.addEventListener("mousedown", (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  void appWindow.startDragging().catch(() => {});
});

/* ----------------------------------------------------------------- 文案 */

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

/** SMTC 会话的播放状态怎么说给用户听。 */
function mediaLabel(media: MediaInfo): string {
  switch (media.status) {
    case "playing":
      return t("ballWindow.mediaPlaying");
    case "paused":
      return t("ballWindow.mediaPaused");
    case "stopped":
    case "closed":
      return t("ballWindow.mediaStopped");
    default:
      return t("ballWindow.mediaSession");
  }
}

function flashHint(text: string) {
  hint.textContent = text;
  window.clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => {
    hint.textContent = t("follow.chip");
  }, 5200);
}

function syncCaptureButton() {
  if (busy) {
    btnCapture.textContent = capturing ? t("ballWindow.stopping") : t("ballWindow.starting");
    btnCapture.disabled = true;
    return;
  }
  btnCapture.disabled = false;
  btnCapture.textContent = capturing ? t("ballWindow.stop") : t("ballWindow.capture");
  btnCapture.classList.toggle("is-stop", capturing);
}

function syncFollowButton() {
  btnFollow.setAttribute("aria-pressed", String(autoFollow));
}

function applyStatus(status: CaptureStatus) {
  capturing = status.active;
  visualizer.setActive(status.active);
  stage.classList.toggle("is-live", status.active);
  if (!status.active) {
    visualizer.relax();
    // 主行（now-title）放状态，次行（now-name）放提示
    nowTitle.textContent = t("ballWindow.idleTitle");
    nowName.textContent = t("ballWindow.idleSub");
    nowState.textContent = t("ballWindow.idleState");
    nowState.classList.remove("is-live");
  } else {
    nowName.textContent = status.processName ?? `PID ${status.pid}`;
  }
  syncCaptureButton();
}

/* --------------------------------------------------------------- 事件 */

function onTick(tick: MonitorTick) {
  lastTick = tick;
  capturing = tick.active;
  visualizer.setActive(tick.active);
  stage.classList.toggle("is-live", tick.active);
  syncCaptureButton();

  if (tick.active) {
    const name = tick.capturing?.processName ?? tick.processName ?? t("list.unknownProcess");
    const windowTitle = tick.capturing?.title?.trim() ?? "";
    const media = tick.media;

    if (media?.title) {
      // SMTC 的元数据最规整：曲名一行、歌手一行，和系统媒体面板显示的一致，
      // 而且播放器缩进托盘也照样读得到
      nowTitle.textContent = media.title;
      nowName.textContent = [media.artist, name].filter(Boolean).join(" · ");
    } else {
      // 退回窗口标题；连窗口都没有（缩在托盘里）时说明原因
      nowTitle.textContent = windowTitle || name;
      nowName.textContent = windowTitle ? name : t("capture.minimized");
    }

    let stateText = t("ballWindow.capturing");
    let live = true;
    if (media) {
      stateText = mediaLabel(media);
      live = media.status === "playing";
    } else if (tick.capturing) {
      stateText = sessionLabel(tick.capturing);
    }
    nowState.textContent = stateText;
    nowState.classList.toggle("is-live", live);
  } else if (document.activeElement !== btnCapture) {
    nowTitle.textContent = t("ballWindow.idleTitle");
    nowName.textContent = t("ballWindow.idleSub");
    nowState.textContent = t("ballWindow.idleState");
    nowState.classList.remove("is-live");
  }

  // 用 class 而不是 hidden：位置照常占着，面板高度不会因为提示出现/消失而跳
  const candidate = tick.candidate;
  candidateBox.classList.toggle("is-off", !candidate);
  if (candidate) {
    candidateText.textContent = tick.active
      ? t("ballWindow.candidateSwitch", { name: candidate.processName })
      : t("ballWindow.candidateStart", { name: candidate.processName });
  }

  if (tick.autoFollow !== autoFollow) {
    autoFollow = tick.autoFollow;
    syncFollowButton();
  }
}

/* --------------------------------------------------------------- 交互 */

btnCapture.addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  syncCaptureButton();
  try {
    if (capturing) {
      const report = await api.stopCapture();
      applyStatus(await api.captureStatus());
      if (report) {
        flashHint(
          t("ballWindow.stopped", {
            name: report.processName,
            frames: report.totalFrames.toLocaleString(),
            seconds: (report.durationMs / 1000).toFixed(1),
            wav: report.wavPath ? t("ballWindow.stoppedWav", { path: report.wavPath }) : "",
          }),
        );
      }
    } else {
      const report = await api.startCaptureBest(false);
      applyStatus(await api.captureStatus());
      flashHint(
        t("ballWindow.started", {
          name: report.processName,
          rate: report.sampleRate || "?",
          channels: report.channels || "?",
        }),
      );
    }
  } catch (err) {
    flashHint(String(err));
    applyStatus(await api.captureStatus());
  } finally {
    busy = false;
    syncCaptureButton();
  }
});

btnFollow.addEventListener("click", async () => {
  autoFollow = !autoFollow;
  syncFollowButton();
  try {
    autoFollow = await api.setAutoFollow(autoFollow);
    await prefs.patch({ autoFollow });
  } catch (err) {
    flashHint(String(err));
  }
  syncFollowButton();
  flashHint(autoFollow ? t("follow.turnedOn") : t("follow.turnedOff"));
});

btnMain.addEventListener("click", () => {
  void api.showMainWindow().catch(() => {});
});

/* --------------------------------------------------------------- 启动 */

async function bootstrap() {
  // 先落地主题与语言，避免默认配色闪一下再换
  await prefs.load();
  applyI18n();

  visualizer.onRender = (rms, peak) => {
    const scale = Math.min(Math.pow(rms, 0.45), 1) * 100;
    meterFill.style.width = `${scale.toFixed(1)}%`;
    meterText.textContent = formatDb(rms);
    meterText.classList.toggle("is-hot", peak > 0.985);
  };

  await listen<AudioFrameEvent>(EVT_AUDIO, (event) => visualizer.push(event.payload));
  await listen<StopReport>(EVT_STOPPED, () => {
    applyStatus({
      active: false,
      pid: null,
      processName: null,
      totalFrames: 0,
      sampleRate: 0,
      channels: 0,
    });
  });
  await listen<MonitorTick>(EVT_MONITOR, (event) => onTick(event.payload));
  await listen<CaptureChanged>(EVT_CAPTURE_CHANGED, (event) => {
    flashHint(event.payload.message);
  });
  await prefs.subscribe((next) => {
    // 主题、律动样式与语言都可能变：重新读一次小球配色 / 样式，再用新语言重画当前画面
    visualizer.refreshLook(next.ballTheme);
    applyI18n();
    hint.textContent = t("follow.chip");
    if (lastTick) onTick(lastTick);
    else syncCaptureButton();
  });

  prefs.watchSystem(() => {
    if (prefs.get().themeMode !== "system") return;
    prefs.reapply();
    visualizer.refreshLook(prefs.get().ballTheme);
  });

  const status = await api.captureStatus();
  applyStatus(status);
  syncFollowButton();
}

void bootstrap();
