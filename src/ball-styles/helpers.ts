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

/** VU 刻度的下限（dB）：响度低于它就算到底了。 */
export const VU_MIN_DB = 36;

/**
 * 响度 → VU 刻度位置（0..1）。
 *
 * 指针不吃线性音量：先把响度折成 dB（`-VU_MIN_DB` 在最左、0 dB 在最右），再掺两成线性量
 * —— 小音量也看得出在动，大声时才压到右边那一小段。跟真表的手感一致，纯线性映射会让指针
 * 老停在中间。
 *
 * 内外两圈的刻度都走这一份换算（表针和弧位置逐点对齐、红区落在同一个响度上），所以调
 * `VU_MIN_DB` 时两圈一起变。
 */
export function vuDeflection(level: number): number {
  const x = clamp01(level);
  if (x <= 1e-4) return 0;
  const byDb = clamp01((20 * Math.log10(x) + VU_MIN_DB) / VU_MIN_DB);
  return clamp01(byDb * 0.8 + x * 0.2);
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
