import { mix } from "../theme";
import type { LayerCtx } from "./types";

export const TAU = Math.PI * 2;
export const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
export function lighten(color: string, amount: number): string {
  return color.startsWith("#") ? mix(color, "#ffffff", amount) : color;
}
export function idleBand(i: number, time: number): number {
  return (0.5 + 0.5 * Math.sin(time / 760 + i * 0.4)) * 0.1;
}
export function energy(d: LayerCtx, index: number, count: number): number {
  const at = Math.round(index / Math.max(1, count - 1) * Math.max(0, d.bands.length - 1));
  return clamp01(d.live ? (d.bands[at] ?? 0) : idleBand(index, d.time));
}

/**
 * 「带惯性」的缓动：不直接跳到目标，而是按上针 / 回针两个速度朝它挪一部分 —— 真表针、
 * 电平弧就是这么荡过去的，音量突变时看着有惯性，不像电表那样一格一格地弹。
 *
 * 用法：样式在模块级 `const ease = createEasing()` 建一份，`draw` 里
 * `ease(ctx.canvas, 目标值, d.time, 上针速度, 回针速度)` 取这一帧该停在的值。
 *
 * 状态按**画布**记（同一块画布的前后帧连成一条曲线）。内外两圈共用一块画布，所以每个
 * 样式都得各自建一份 —— 各记各的针位，互不干扰。
 *
 * 按两帧之间**真实过了多久**算，所以帧率调高调低、掉帧了，快慢都不变；第一帧以及静态
 * 预览（`time` 一直是 0）直接到位，不会从起点慢慢晃上来。
 */
export function createEasing(): (
  canvas: HTMLCanvasElement,
  target: number,
  time: number,
  attack: number,
  release: number,
) => number {
  const states = new WeakMap<HTMLCanvasElement, { value: number; at: number }>();
  return (canvas, target, time, attack, release) => {
    let state = states.get(canvas);
    if (!state) {
      state = { value: target, at: -1 };
      states.set(canvas, state);
    }
    if (state.at < 0 || time <= 0) {
      state.value = target;
    } else {
      // 两帧隔太久（窗口刚露出来、掉帧）按上限算，免得值"瞬移"
      const dt = Math.min(0.25, Math.max(0, (time - state.at) / 1000));
      const rate = target > state.value ? attack : release;
      state.value += (target - state.value) * (1 - Math.exp(-rate * dt));
    }
    state.at = time;
    return state.value;
  };
}
