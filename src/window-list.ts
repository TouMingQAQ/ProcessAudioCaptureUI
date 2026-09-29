/**
 * 窗口名单（白 / 黑名单）的前端判定。
 *
 * Rust 侧有一份对应的实现（`src-tauri/src/filter.rs`），两边规则必须一致：后端管"能不能
 * 被自动选中"（自动跟随、悬浮球的一次挑），前端管"要不要列出来"。前者拿的是 `AppState`
 * 里的名单快照，后者直接读设置对象。
 *
 * 本应用自己的进程名从后端取一次（`self_process_name`）。它在判定里永远算黑名单成员 ——
 * 这是前后端共同的硬规则，不用等用户在设置里配，也删不掉。
 */

import { api, type AudioWindowInfo, type Settings } from "./api";

let selfName = "";

/** 取一次本应用的进程名。启动时调一次就够。 */
export async function loadSelfName(): Promise<string> {
  try {
    selfName = (await api.selfProcessName()).trim().toLowerCase();
  } catch {
    // 取不到就退化成纯设置判定：列表里可能多出自己一条，但采集仍会被后端挡住
    selfName = "";
  }
  return selfName;
}

/** 本应用的进程名（小写）；还没取到时是空串。 */
export function getSelfName(): string {
  return selfName;
}

/** 这个窗口该不该出现在检测结果里（列表过滤与后端挑选用的是同一套规则）。 */
export function isWindowAllowed(window: AudioWindowInfo, settings: Settings): boolean {
  const name = window.processName.trim().toLowerCase();
  if (!name) return false;
  // 黑名单（含本应用自己）优先：白名单里写了也救不回来
  if (name === selfName || settings.windowBlocklist.includes(name)) return false;
  return settings.windowAllowlist.length === 0 || settings.windowAllowlist.includes(name);
}
