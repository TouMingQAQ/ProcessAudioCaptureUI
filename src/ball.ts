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
const nowFrames = $<HTMLSpanElement>("now-frames");
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

let capturing = false;
let autoFollow = false;
let busy = false;
let expanded = false;
let hintTimer = 0;

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
      return "正在播放";
    case "inactive":
      return "会话空闲";
    case "expired":
      return "会话已失效";
    default:
      return "无音频会话";
  }
}

/** SMTC 会话的播放状态怎么说给用户听。 */
function mediaLabel(media: MediaInfo): string {
  switch (media.status) {
    case "playing":
      return "正在播放";
    case "paused":
      return "已暂停";
    case "stopped":
    case "closed":
      return "已停止";
    default:
      return "媒体会话";
  }
}

function flashHint(text: string) {
  hint.textContent = text;
  window.clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => {
    hint.textContent = "自动跟随：当前窗口安静下来、别的窗口开始出声时，会自动切过去";
  }, 5200);
}

function syncCaptureButton() {
  if (busy) {
    btnCapture.textContent = capturing ? "停止中…" : "启动中…";
    btnCapture.disabled = true;
    return;
  }
  btnCapture.disabled = false;
  btnCapture.textContent = capturing ? "停止采集" : "开始采集";
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
    nowTitle.textContent = "还没有开始采集";
    nowName.textContent = "点下方按钮，小球会自动挑一个正在出声的窗口";
    nowState.textContent = "待机中";
    nowState.classList.remove("is-live");
    nowFrames.textContent = "—";
  } else {
    nowName.textContent = status.processName ?? `PID ${status.pid}`;
    nowFrames.textContent = `${status.totalFrames.toLocaleString()} 帧`;
  }
  syncCaptureButton();
}

/* --------------------------------------------------------------- 事件 */

function onTick(tick: MonitorTick) {
  capturing = tick.active;
  visualizer.setActive(tick.active);
  stage.classList.toggle("is-live", tick.active);
  syncCaptureButton();

  if (tick.active) {
    const name = tick.capturing?.processName ?? tick.processName ?? "未知进程";
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
      nowName.textContent = windowTitle ? name : "窗口已最小化，读不到标题";
    }

    let stateText = "采集中";
    let live = true;
    if (media) {
      stateText = mediaLabel(media);
      live = media.status === "playing";
    } else if (tick.capturing) {
      stateText = sessionLabel(tick.capturing);
    }
    nowState.textContent = stateText;
    nowState.classList.toggle("is-live", live);
    nowFrames.textContent = `${tick.totalFrames.toLocaleString()} 帧`;
  } else if (document.activeElement !== btnCapture) {
    nowTitle.textContent = "还没有开始采集";
    nowName.textContent = "点下方按钮，小球会自动挑一个正在出声的窗口";
    nowState.textContent = "待机中";
    nowState.classList.remove("is-live");
    nowFrames.textContent = "—";
  }

  // 用 class 而不是 hidden：位置照常占着，面板高度不会因为提示出现/消失而跳
  const candidate = tick.candidate;
  candidateBox.classList.toggle("is-off", !candidate);
  if (candidate) {
    candidateText.textContent = tick.active
      ? `「${candidate.processName}」也在出声，若当前窗口安静下来会自动切过去`
      : `「${candidate.processName}」正在出声，可以开始采集`;
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
        const seconds = (report.durationMs / 1000).toFixed(1);
        flashHint(
          `已停止：${report.processName} · ${report.totalFrames.toLocaleString()} 帧 / ${seconds}s${
            report.wavPath ? ` · WAV：${report.wavPath}` : ""
          }`,
        );
      }
    } else {
      const report = await api.startCaptureBest(false);
      applyStatus(await api.captureStatus());
      flashHint(
        `已开始采集 ${report.processName} · ${report.sampleRate || "?"} Hz / ${
          report.channels || "?"
        } 声道`,
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
  } catch (err) {
    flashHint(String(err));
  }
  syncFollowButton();
  flashHint(autoFollow ? "自动跟随已开启" : "自动跟随已关闭");
});

btnMain.addEventListener("click", () => {
  void api.showMainWindow().catch(() => {});
});

/* --------------------------------------------------------------- 启动 */

async function bootstrap() {
  visualizer.onRender = (rms, peak) => {
    const scale = Math.min(Math.pow(rms, 0.45), 1) * 100;
    meterFill.style.width = `${scale.toFixed(1)}%`;
    meterText.textContent = formatDb(rms);
    meterText.style.color = peak > 0.985 ? "#e0557f" : "";
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

  const status = await api.captureStatus();
  applyStatus(status);
  syncFollowButton();
}

void bootstrap();
