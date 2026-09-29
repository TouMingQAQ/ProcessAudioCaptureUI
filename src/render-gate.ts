/**
 * 「这个窗口现在该不该画」——主界面与悬浮球各跑一份。
 *
 * 两个 WebView 是**互相独立**的：主界面点 × 只是把窗口藏起来（进程还在托盘里、悬浮球
 * 照常在跳），所以"藏起来就别画了"这件事必须只作用于被藏的那个窗口。这里有两个坑：
 *
 * * Tauri 的 `emit_to` 对**没指定 target 的监听者不隔离**：`listen()` 默认注册成
 *   `EventTarget::Any`，而定向投递的过滤是"Any 一律放行"（见 `api.ts` 里 `EVT_VISIBILITY`
 *   的说明）。所以事件名按窗口分开，注册时也显式带上 target —— 两道锁。
 * * 窗口可见性有两路信号：`pac://window-visibility:<窗口标签>`（后端把窗口藏起来 /
 *   露出来时定向发的）和浏览器自己的 `visibilitychange`（最小化 / 被完全遮住时会变
 *   hidden）。两路都只属于本窗口。
 *
 * 另外三个刻意的选择：
 *
 * 1. **后端说了算**。窗口是后端自己藏 / 露的，它最清楚；`visibilitychange` 只当补充。
 * 2. **启动时不当"隐藏"看**。窗口刚建好那会儿浏览器给的可见性可能是过时的（悬浮球窗口
 *    甚至是先建好、再由后端 show 出来的），照着它判会把小球直接冻住 —— 所以默认按可见
 *    起跑，之后只认"变化"。
 * 3. 恢复的路子多于停下的路子：后端说露出来了、窗口拿到焦点、浏览器说可见，任一条成立
 *    就继续画。少画几帧不疼，白画一整天很疼；反过来"该画却不画"才是真毛病。
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { EVT_VISIBILITY, type VisibilityPayload } from "./api";

/** 本窗口专属的可见性事件名（后端按同样的规则拼，见 `lib::emit_visibility`）。 */
function visibilityEventFor(label: string): string {
  return `${EVT_VISIBILITY}:${label}`;
}

/**
 * 盯着本窗口的可见性，每次变化回调一次（回调里带的是"现在能不能画"）。
 *
 * 返回值是一个取消订阅的函数（页面卸载时用）。
 */
export function bindRenderGate(onChange: (visible: boolean) => void): () => void {
  const currentWindow = getCurrentWindow();
  const label = currentWindow.label;
  /** 后端说的：它有没有把我们藏起来。 */
  let shown = true;
  /** 浏览器说的：文档是不是可见的。 */
  let documentVisible = true;
  /** 原生窗口说的：窗口是不是最小化了。 */
  let minimized = false;
  let lastApplied: boolean | undefined;
  let closed = false;
  let pollInFlight = false;
  const minimizePoll = window.setInterval(() => {
    if (closed || !shown || !documentVisible || pollInFlight) return;
    pollInFlight = true;
    void currentWindow
      .isMinimized()
      .then((value) => {
        if (closed) return;
        minimized = value;
        apply();
      })
      .catch(() => {})
      .finally(() => {
        pollInFlight = false;
      });
  }, 350);
  const pending: Promise<UnlistenFn>[] = [];

  const apply = () => {
    const visible = shown && documentVisible && !minimized;
    if (visible === lastApplied) return;
    lastApplied = visible;
    document.documentElement.dataset.rendering = visible ? "visible" : "hidden";
    onChange(visible);
  };

  /** 记一条订阅，顺便处理"订阅还没落地页面就卸了"。 */
  const track = (subscription: Promise<UnlistenFn>) => {
    pending.push(subscription);
    void subscription
      .then((fn) => {
        if (closed) fn();
      })
      .catch(() => {});
  };

  /** 后端 / 焦点这两条"露出来了"的消息：以它们为准，别被过时的文档状态挡住。 */
  const reveal = () => {
    shown = true;
    documentVisible = true;
    minimized = false;
    apply();
  };

  track(
    // 事件名 + target 都按本窗口来：任何一道锁失效都不会串到另一个窗口去
    listen<VisibilityPayload>(
      visibilityEventFor(label),
      (event) => {
        if (event.payload.visible) reveal();
        else {
          shown = false;
          apply();
        }
      },
      { target: label },
    ),
  );

  const onVisibility = () => {
    documentVisible = document.visibilityState !== "hidden";
    apply();
  };
  document.addEventListener("visibilitychange", onVisibility);

  // 兜底：能拿到焦点的窗口一定露着。万一有哪一路消息没送到，还能从这儿恢复，
  // 不至于让界面永远停在一帧上。
  track(
    currentWindow.onFocusChanged(({ payload }) => {
      if (payload) reveal();
    }),
  );

  const stop = () => {
    if (closed) return;
    closed = true;
    window.clearInterval(minimizePoll);
    lastApplied = false;
    document.documentElement.dataset.rendering = "hidden";
    onChange(false);
    pending.forEach((subscription) => void subscription.then((fn) => fn()).catch(() => {}));
    pending.length = 0;
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", stop);
    window.removeEventListener("beforeunload", stop);
  };

  window.addEventListener("pagehide", stop);
  window.addEventListener("beforeunload", stop);

  apply();

  return stop;
}
