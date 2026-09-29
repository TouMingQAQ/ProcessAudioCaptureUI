import { listen } from "@tauri-apps/api/event";
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
  type Settings,
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
  // 面板的进出改变了可交互区域，重新报一次
  reportGeometry();
}

void listen<BallHover>(EVT_BALL_HOVER, (event) => applyHover(event.payload.hovered));

/* ------------------------------------------------------- 位置：拖动 / 记忆 */

/** 球心在窗口里的位置（0~1）。窗口铺满整屏，所以这也等于它在屏幕上的位置。 */
const position = { x: 0.92, y: 0.88 };

let dragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * 把球摆到某个百分比位置。
 *
 * 位置要夹一下：球自己有半径，太靠边就会露到屏幕外。边距按球的实际像素尺寸算，
 * 所以球调大之后能活动的范围会自然收窄。
 */
function moveOrb(x: number, y: number, report = true) {
  const width = orb.offsetWidth || 96;
  const height = orb.offsetHeight || 96;
  const marginX = width / 2 / Math.max(1, window.innerWidth);
  const marginY = height / 2 / Math.max(1, window.innerHeight);

  position.x = Math.min(1 - marginX, Math.max(marginX, clamp01(x)));
  position.y = Math.min(1 - marginY, Math.max(marginY, clamp01(y)));

  const root = document.documentElement;
  root.style.setProperty("--orb-cx", `${(position.x * 100).toFixed(3)}%`);
  root.style.setProperty("--orb-cy", `${(position.y * 100).toFixed(3)}%`);

  placePanel();
  if (report) reportGeometry();
}

/**
 * 把面板摆到球旁边。
 *
 * 横向 / 纵向各看一眼哪边更宽敞就往哪边展开，再把结果夹回窗口内 —— 球在左上角时
 * 面板落向右下，球贴着右边缘时面板落到左边，总之不会跑出屏幕。
 */
function placePanel() {
  const gap = 12;
  const margin = 8;
  // 用 offset* 而不是 getBoundingClientRect：后者会把"随音频律动缩放"也算进去，
  // 面板会跟着每一下鼓点抖。这里要的是球的**基准**外框。
  const size = orb.offsetWidth || 96;
  const left = orb.offsetLeft - size / 2;
  const top = orb.offsetTop - size / 2;
  const right = left + size;
  const bottom = top + size;
  const width = panel.offsetWidth || 300;
  const height = panel.offsetHeight || 320;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const rightRoom = vw - right - gap;
  const leftRoom = left - gap;
  const panelLeft =
    rightRoom >= leftRoom
      ? Math.min(right + gap, Math.max(margin, vw - margin - width))
      : Math.max(margin, left - gap - width);

  const downRoom = vh - bottom - gap;
  const upRoom = top - gap;
  const panelTop =
    downRoom >= upRoom
      ? Math.min(bottom + gap, Math.max(margin, vh - margin - height))
      : Math.max(margin, top - gap - height);

  panel.style.left = `${Math.round(panelLeft)}px`;
  panel.style.top = `${Math.round(panelTop)}px`;
}

/**
 * 把可交互区域报给后端。
 *
 * 窗口铺满整屏、收起时整窗鼠标穿透，后端只认这一块区域 —— 球在哪、多大、面板摆在
 * 哪边都是前端算的（球能缩放、面板还要躲屏幕边），那边照着一比就行。
 */
function reportGeometry() {
  // 用 offset* 而不是 getBoundingClientRect：前者不受 transform 影响，
  // 鼠标悬停在球上时那点放大不会让命中圈跟着抖
  const panelRect: [number, number, number, number] | null = expanded
    ? [
        panel.offsetLeft,
        panel.offsetTop,
        panel.offsetLeft + panel.offsetWidth,
        panel.offsetTop + panel.offsetHeight,
      ]
    : null;

  void api
    .setBallGeometry({
      orbX: orb.offsetLeft,
      orbY: orb.offsetTop,
      orbR: orb.offsetWidth / 2,
      panel: panelRect,
    })
    .catch(() => {});
}

orb.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  // 球心就是 offsetLeft / offsetTop（`left` / `top` 定位的就是它），
  // 这个取法跟律动缩放无关，抓到哪个位置就是哪个位置
  dragOffsetX = event.clientX - orb.offsetLeft;
  dragOffsetY = event.clientY - orb.offsetTop;
  dragging = true;
  orb.setPointerCapture(event.pointerId);
  stage.classList.add("is-dragging");
  // 拖动期间后端必须让窗口保持可交互，否则指针事件一断，球就卡在半路
  void api.setBallDragging(true).catch(() => {});
});

orb.addEventListener("pointermove", (event) => {
  if (!dragging) return;
  // 拖动中不回报几何：这段时间后端固定保持可交互，报了也用不上
  moveOrb(
    (event.clientX - dragOffsetX) / window.innerWidth,
    (event.clientY - dragOffsetY) / window.innerHeight,
    false,
  );
});

function endDrag(event: PointerEvent) {
  if (!dragging) return;
  dragging = false;
  if (orb.hasPointerCapture(event.pointerId)) orb.releasePointerCapture(event.pointerId);
  stage.classList.remove("is-dragging");
  void api.setBallDragging(false).catch(() => {});
  reportGeometry();
  placePanel();
  // 位置落盘：下次打开还在原地
  void prefs.patch({ ballPosX: position.x, ballPosY: position.y });
}

orb.addEventListener("pointerup", endDrag);
orb.addEventListener("pointercancel", endDrag);

// 分辨率或显示器变了，窗口尺寸跟着变，位置与命中区域都要重算
window.addEventListener("resize", () => moveOrb(position.x, position.y));

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

/** 把设置里的外观部分整个交给小球渲染器（颜色、内外样式、数据源、尺寸、缩放）。 */
function applyLook(settings: Settings): void {
  visualizer.refreshLook({
    colors: settings.ballColors,
    innerStyle: settings.ballInnerStyle,
    outerStyle: settings.ballOuterStyle,
    innerSource: settings.ballInnerSource,
    outerSource: settings.ballOuterSource,
    size: settings.ballSize,
    gain: settings.ballGain,
    pulse: settings.ballPulse,
    algorithm: settings.ballPulseAlgorithm,
    pulseAmount: settings.ballPulseAmount,
  });
}

async function bootstrap() {
  // 先落地主题与语言，避免默认配色闪一下再换
  const loaded = await prefs.load();
  applyLook(loaded);
  // 球摆到上次记住的位置（首次运行就是默认的右下角那一带）
  moveOrb(loaded.ballPosX, loaded.ballPosY);
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
    // 外观、数据源与语言都可能变：重新读一次外观，再用新语言重画当前画面
    applyLook(next);
    // 球可能被调大了，位置重新夹一下（免得半个球露到屏幕外）
    moveOrb(position.x, position.y);
    applyI18n();
    hint.textContent = t("follow.chip");
    if (lastTick) onTick(lastTick);
    else syncCaptureButton();
  });

  const status = await api.captureStatus();
  applyStatus(status);
  syncFollowButton();
}

void bootstrap();
