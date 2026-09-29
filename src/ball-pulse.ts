/**
 * 悬浮球随音频律动缩放的算法。
 *
 * 「跟着音乐点头」这件事拆成三段：
 *
 * 1. **触发** —— 什么时候点一下：低频能量的上升沿（鼓点落在这儿）／峰值越线／不触发；
 * 2. **回弹** —— 点完之后怎么回去：用一个二阶弹簧，刚度与阻尼决定是"轻点一下"还是
 *    "弹两下"，不用手写缓动曲线，过冲与余振都是算出来的；
 * 3. **量程** —— 缩放夹在 `min`..`max` 之间，音频大起大落时球也不会忽大忽小到失控。
 *
 * 每个算法都是一段**纯计算**：喂这一帧的数据与上一帧的状态，推进一格。之所以长成
 * 这个形状，是为了以后整体搬进采集内核 —— 那边没有 DOM、没有 canvas，内核每帧算
 * 一次，宿主只拿结果用来画，接口正好对得上。
 */

/** 一帧的输入。 */
export interface PulseInput {
  /** 整帧响度（0..1）。 */
  rms: number;
  /** 整帧峰值（0..1）。 */
  peak: number;
  /** 低频能量（0..1）：频谱最前面几柱的均值，鼓点主要落在这里。 */
  low: number;
  /** 采集是否在跑；不跑时各算法都该慢慢回到静止。 */
  live: boolean;
  /** 距上一帧的毫秒数。 */
  dt: number;
}

/** 算法自己的状态，每帧被推进一格。 */
export interface PulseState {
  /** 当前偏移量：0 = 原大小，负数 = 缩小，正数 = 放大。 */
  offset: number;
  /** 偏移量的变化速度，弹簧用。 */
  velocity: number;
  /** 平滑后的低频能量，用来判断"这一下是不是比最近更响"。 */
  lastLow: number;
  /** 冷却剩余毫秒数：一个鼓点只点一次，不然后半段会被反复触发。 */
  cooldown: number;
  /** 摆动相位。 */
  phase: number;
}

export interface PulseAlgorithm {
  id: string;
  /** 缩放系数下限（0.72 = 最小缩到七成）。 */
  min: number;
  /** 缩放系数上限（1.5 = 最大放到一倍半）。 */
  max: number;
  step(state: PulseState, input: PulseInput): void;
}

export function createPulseState(): PulseState {
  return { offset: 0, velocity: 0, lastLow: 0, cooldown: 0, phase: 0 };
}

/** 弹簧推进：半隐式欧拉，`dt` 夹在 33ms 以内，掉帧时不会炸开。 */
function spring(state: PulseState, stiffness: number, damping: number, dt: number): void {
  const step = Math.min(Math.max(dt, 0), 33) / 1000;
  if (step <= 0) return;
  const accel = -stiffness * state.offset - damping * state.velocity;
  state.velocity += accel * step;
  state.offset += state.velocity * step;
}

function lowerCooldown(state: PulseState, dt: number): void {
  state.cooldown = Math.max(0, state.cooldown - dt);
}

/* ------------------------------------------------------------------ 算法 */

/** 不缩放：球一直是原大小。 */
function stepNone(state: PulseState): void {
  state.offset = 0;
  state.velocity = 0;
}

/**
 * 点头：低频一冲击就往下压一下，然后自己弹回来。
 *
 * 判断的是"这一帧比最近明显更响"而不是"够响"—— 否则一段持续的低音会让球一直缩着
 * 不动。冷却时间保证一个鼓点只点一次。
 */
function stepNod(state: PulseState, input: PulseInput): void {
  lowerCooldown(state, input.dt);
  const rise = input.low - state.lastLow;
  // lastLow 跟得慢一点，rise 才代表"当前高出近期水平多少"
  state.lastLow += (input.low - state.lastLow) * 0.35;
  if (input.live && state.cooldown <= 0 && input.low > 0.16 && rise > 0.05) {
    state.velocity -= 2.6 + Math.min(1, input.low) * 2.4;
    state.cooldown = 110;
  }
  spring(state, 300, 30, input.dt);
}

/** 呼吸：跟着整体响度慢慢起伏，没有冲击感。 */
function stepBreathe(state: PulseState, input: PulseInput): void {
  const target = input.live ? Math.min(1, input.rms) * 0.42 : 0;
  state.offset += (target - state.offset) * 0.055;
  state.velocity = 0;
}

/** 脉冲：峰值越线时放大一下；阻尼小，所以会弹两下才停。 */
function stepPulse(state: PulseState, input: PulseInput): void {
  lowerCooldown(state, input.dt);
  if (input.live && state.cooldown <= 0 && input.peak > 0.6) {
    state.velocity += 6 + input.peak * 9;
    state.cooldown = 150;
  }
  spring(state, 190, 9, input.dt);
}

/** 摆动：低频越强摆得越快、幅度越大，像跟着节拍轻轻晃。 */
function stepSway(state: PulseState, input: PulseInput): void {
  const energy = input.live ? Math.min(1, input.low) : 0;
  const step = Math.min(Math.max(input.dt, 0), 33) / 1000;
  state.phase += step * (2.4 + energy * 6);
  const target = Math.sin(state.phase * Math.PI * 2) * energy * 0.18;
  state.offset += (target - state.offset) * 0.25;
  state.velocity = 0;
}

/* ------------------------------------------------------------------ 表 */

/**
 * 名字与说明在 `i18n.ts`（键名 `ballPulse.<id>` / `ballPulse.hint.<id>`），
 * 这里只留 id 与算法本身。
 */
export const BALL_PULSE_ALGORITHMS: PulseAlgorithm[] = [
  { id: "none", min: 1, max: 1, step: stepNone },
  { id: "nod", min: 0.72, max: 1.12, step: stepNod },
  { id: "breathe", min: 0.95, max: 1.5, step: stepBreathe },
  { id: "pulse", min: 0.85, max: 1.6, step: stepPulse },
  { id: "sway", min: 0.8, max: 1.25, step: stepSway },
];

export const DEFAULT_BALL_PULSE_ALGORITHM = "nod";

/** 幅度倍率的默认值（1 = 算法原本的幅度）。 */
export const DEFAULT_BALL_PULSE_AMOUNT = 1;

export function pulseAlgorithmById(id: string): PulseAlgorithm {
  return (
    BALL_PULSE_ALGORITHMS.find((algorithm) => algorithm.id === id) ?? BALL_PULSE_ALGORITHMS[1]
  );
}

/** 缩放系数的绝对上下限：倍率拉满时也不至于缩成一个点、或撑爆整个窗口。 */
const SCALE_FLOOR = 0.25;
const SCALE_CEIL = 2.5;

/**
 * 按倍率算这一帧的缩放量程。
 *
 * 倍率是把算法的**基准量程**整体拉开（`1 + (v - 1) * amount`），而不只是把偏移量乘大 ——
 * 否则动作几下就被原来的量程夹住，调了倍率却看不出差别。拉开的量程再夹在绝对上下限里，
 * 免得 3 倍之下球缩成一颗看不见的点。
 */
export function pulseRange(
  algorithm: PulseAlgorithm,
  amount: number,
): { min: number; max: number } {
  const grow = (value: number) => 1 + (value - 1) * amount;
  return {
    min: Math.max(SCALE_FLOOR, grow(algorithm.min)),
    max: Math.min(SCALE_CEIL, grow(algorithm.max)),
  };
}

/** 当前状态换算成缩放系数。`amount` 是设置里的幅度倍率（1~3）。 */
export function pulseScale(algorithm: PulseAlgorithm, state: PulseState, amount = 1): number {
  const { min, max } = pulseRange(algorithm, amount);
  const raw = 1 + state.offset * amount;
  return Math.min(max, Math.max(min, raw));
}
