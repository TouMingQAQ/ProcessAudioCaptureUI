import { alpha, slotColor, slotRamp } from "../../../theme";
import { TAU, clamp01, lighten } from "../../helpers";
import type { LayerCtx } from "../../types";

function vuDeflection(level: number): number {
  const minDb = 36;
  const x = clamp01(level);
  if (x <= 1e-4) return 0;
  const byDb = clamp01((20 * Math.log10(x) + minDb) / minDb);
  return clamp01(byDb * 0.8 + x * 0.2);
}

export function draw(ctx: CanvasRenderingContext2D, d: LayerCtx) {
  const { center, unit, colors, level, live, time } = d;

  /*
   * ↓↓↓ 可调参数：想改刻度与指针的样子，动这几个数就行 ↓↓↓
   *
   * 长度一律按「单位数」算：1 单位 = 小球边长的 1/96，所以球放大缩小，比例都不变。
   */
  /** 刻度**端点半径**：两个端点离转轴（指针圆心）多远。管刻度整体离针尖多近。 */
  const SCALE_END_RADIUS = 16.5;
  /**
   * 刻度**弯曲半径**：中间那段曲线按多大半径弯。
   *
   * 等于端点半径（默认） = 以转轴为圆心的正圆弧，针尖始终贴着刻度；
   * 调大 → 中间的弧往转轴这边收，整条刻度越来越像一条稍微弯曲的曲线（无限大 = 直线）；
   * 调小 → 比正圆弧更拱。
   */
  const SCALE_BEND_RADIUS = 36.5;
  /** 刻度的**弧度范围**：两个端点相对转轴左右各偏多少度（决定刻度有多宽）。 */
  const SCALE_ARC_DEG = 65;
  /** 指针的**弧度范围**：指针左右各摆多少度（跟刻度各管各的，互不影响）。 */
  const NEEDLE_ARC_DEG = 65;
  /** 指针**转轴**落在球心下方多远。只管指针：转轴位置、指针往哪儿转。 */
  const NEEDLE_PIVOT_DROP = 6.5;
  /** 刻度**基准点**落在球心下方多远。只管刻度：端点 / 弯曲半径都是从这个点量起的。 */
  const SCALE_ORIGIN_DROP = 6.5;
  /** 针尖比端点半径还长出多少。大于 0 时针尖就会盖过刻度线。 */
  const NEEDLE_OVER = 2.2;
  /* ↑↑↑ 可调参数 ↑↑↑ */

  const pivotX = center;
  /*
   * 竖直方向上两个基准点是**分开**的：
   * * `pivotY` —— 指针的转轴（针从这儿转出去）；
   * * `scaleY` —— 刻度的基准点（端点半径、弯曲半径都从这儿量，改它整条刻度上下平移）。
   *
   * 都默认落在球心下一点（别贴到最下缘），刻度因此落在球体上半部。两个数改一个只动
   * 各自那一头：想让刻度离指针远一点 / 近一点，调 `SCALE_ORIGIN_DROP` 就行。
   */
  const pivotY = center + NEEDLE_PIVOT_DROP * unit;
  const scaleY = center + SCALE_ORIGIN_DROP * unit;

  const endR = SCALE_END_RADIUS * unit;
  const half = (SCALE_ARC_DEG * Math.PI) / 180;
  const needleHalf = (NEEDLE_ARC_DEG * Math.PI) / 180;

  /*
   * 刻度曲线的算法（端点半径 + 弯曲半径）：
   *
   * 两个端点钉在"离刻度基准点 `endR`、左右各偏 `half`"的位置上；中间那段按半径
   * `bendR` 弯过去 —— 弯曲圆的圆心落在基准点正下方，于是曲线左右对称、两端正好穿过
   * 那两个端点。
   */
  const bendR = Math.max(
    SCALE_BEND_RADIUS * unit,
    endR * Math.sin(half) + 0.5 * unit, // 弯曲半径至少要大于半弦长，否则这个圆画不出来
  );
  // 弯曲圆心相对刻度基准点的偏移量（`bendR === endR` 时正好是 0：圆心就是基准点本身）
  const bendOffsetY =
    Math.sqrt(Math.max(0, bendR * bendR - endR * endR * Math.sin(half) ** 2)) -
    endR * Math.cos(half);

  /** 刻度值（0..1）→ 相对刻度基准点的角度（0 = 正上方，正数偏右）。 */
  const scalePhi = (value: number) => (clamp01(value) * 2 - 1) * half;
  /** 刻度值（0..1）→ 指针相对转轴的角度。用的是另一份弧度范围，改它不会动到刻度。 */
  const needlePhi = (value: number) => (clamp01(value) * 2 - 1) * needleHalf;

  /**
   * 基准点上方、角度 `phi` 处的刻度点离基准点多远（射线与弯曲圆的交点）。
   *
   * 两端（`phi = ±half`）正好等于端点半径；`phi = 0` 是曲线最高的地方。
   */
  const scaleRadiusAt = (phi: number) =>
    -bendOffsetY * Math.cos(phi) +
    Math.sqrt(Math.max(0, bendR * bendR - bendOffsetY * bendOffsetY * Math.sin(phi) ** 2));

  /** 刻度点的画布坐标：角度 `phi`、离刻度基准点 `s`。 */
  const scalePoint = (phi: number, s: number) => ({
    x: pivotX + Math.sin(phi) * s,
    y: scaleY - Math.cos(phi) * s,
  });

  /** 刻度点 → 弯曲圆上的角度（`ctx.arc` 要的是这个）。 */
  const bendAngleAt = (phi: number) => {
    const point = scalePoint(phi, scaleRadiusAt(phi));
    return Math.atan2(point.y - (scaleY + bendOffsetY), point.x - pivotX);
  };

  // 表盘：一层很淡的亮面，刻度和指针才压得住外发光（尺寸跟球体走，不跟刻度弧走）
  const faceR = 19.6 * unit;
  const face = ctx.createRadialGradient(
    center - faceR * 0.5,
    center - faceR * 0.62,
    faceR * 0.12,
    center,
    center,
    faceR,
  );
  face.addColorStop(0, alpha(colors.core, 0.32));
  face.addColorStop(0.74, alpha(colors.coreEdge, 0.14));
  face.addColorStop(1, alpha(colors.coreEdge, 0));
  ctx.globalAlpha = 1;
  ctx.fillStyle = face;
  ctx.beginPath();
  ctx.arc(center, center, faceR, 0, TAU);
  ctx.fill();

  // 刻度曲线（按弯曲半径画的那段圆弧，两端正好落在两个端点上）
  const bendCx = pivotX;
  const bendCy = scaleY + bendOffsetY;
  ctx.globalAlpha = 0.55;
  ctx.strokeStyle = slotColor(colors, 0);
  ctx.lineWidth = Math.max(0.9, 1.0 * unit);
  ctx.beginPath();
  ctx.arc(bendCx, bendCy, bendR, bendAngleAt(-half), bendAngleAt(half));
  ctx.stroke();

  // 红区：最后两成半刻度换成暖色，一眼看得出"再往右就到头了"
  const hotAt = 0.75;
  ctx.globalAlpha = 0.8;
  ctx.strokeStyle = slotColor(colors, 2);
  ctx.lineWidth = Math.max(1.1, 1.3 * unit);
  ctx.beginPath();
  ctx.arc(bendCx, bendCy, bendR, bendAngleAt(scalePhi(hotAt)), bendAngleAt(half));
  ctx.stroke();

  /*
   * 刻度线：都画在曲线**外侧**（背离刻度基准点的那一侧，也就是轴的上方）。
   *
   * 数量跟着小球大小走 —— 球小就少画几根，免得挤成一条毛边；球大就多画几根，
   * 让刻度之间的间距始终在几像素上下。每 `per` 根里一根长的（两端也算长的）。
   */
  const per = unit < 1.4 ? 2 : unit < 2.4 ? 3 : unit < 3.6 ? 4 : 5;
  const steps = per * 5;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const phi = scalePhi(t);
    const s = scaleRadiusAt(phi);
    const long = i % per === 0;
    const onCurve = scalePoint(phi, s);
    const outward = scalePoint(phi, s + (long ? 3.4 : 1.9) * unit);
    ctx.globalAlpha = t >= hotAt ? 0.95 : 0.3 + t * 0.35;
    ctx.strokeStyle = t >= hotAt ? slotColor(colors, 2) : slotRamp(colors, t * 0.7);
    ctx.lineWidth = Math.max(0.8, (long ? 1.1 : 0.75) * unit);
    ctx.beginPath();
    ctx.moveTo(onCurve.x, onCurve.y);
    ctx.lineTo(outward.x, outward.y);
    ctx.stroke();
  }

  /**
   * 一根针：靠轴那头宽、往尖端收细（梯形而不是等宽线），从转轴指向刻度。
   *
   * `length` 是**像素**（调用方按 `unit` 折算），`baseHalf` 是**单位数**（针根半宽）。
   */
  const needle = (value: number, length: number, baseHalf: number, color: string, a: number) => {
    const phi = needlePhi(value);
    // 针的方向（从转轴指向刻度）与它的法线（用来把针根撑开、尖端收细）
    const dx = Math.sin(phi);
    const dy = -Math.cos(phi);
    const nx = Math.cos(phi);
    const ny = Math.sin(phi);
    const base = baseHalf * unit;
    const tip = Math.max(0.35, baseHalf * 0.3) * unit;
    ctx.globalAlpha = a;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(pivotX - nx * base, pivotY - ny * base);
    ctx.lineTo(pivotX + dx * length - nx * tip, pivotY + dy * length - ny * tip);
    ctx.lineTo(pivotX + dx * length + nx * tip, pivotY + dy * length + ny * tip);
    ctx.lineTo(pivotX + nx * base, pivotY + ny * base);
    ctx.closePath();
    ctx.fill();
  };

  // 待机时让指针在起点附近轻轻游走，别看着像断电了
  const value = live ? vuDeflection(level) : 0.03 + 0.032 * (0.5 + 0.5 * Math.sin(time / 1400));
  const needleColor = lighten(slotColor(colors, 1), 0.2);
  // 比端点半径长一截：针尖穿过刻度线，针和刻度叠在一起
  const tipLength = endR + NEEDLE_OVER * unit;
  needle(value, tipLength, 0.5, needleColor, 0.28);
  needle(value, tipLength, 0.5, needleColor, 0.95);
  // 针尖一点亮，细针才不至于在表盘上"看不见"
  // const tipPhi = needlePhi(value);
  // ctx.globalAlpha = 0.9;
  // ctx.fillStyle = lighten(needleColor, 0.45);
  // ctx.beginPath();
  // ctx.arc(
  //   pivotX + Math.sin(tipPhi) * tipLength,
  //   pivotY - Math.cos(tipPhi) * tipLength,
  //   Math.max(0.6, 0.7 * unit),
  //   0,
  //   TAU,
  // );
  // ctx.fill();

  // 转轴
  const hubR = 1.4 * unit;
  const hub = ctx.createRadialGradient(
    pivotX - hubR * 0.4,
    pivotY - hubR * 0.4,
    hubR * 0.1,
    pivotX,
    pivotY,
    hubR,
  );
  hub.addColorStop(0, lighten(slotColor(colors, 1), 0.55));
  hub.addColorStop(1, lighten(slotColor(colors, 0), 0.05));
  ctx.globalAlpha = 0.95;
  ctx.fillStyle = hub;
  ctx.beginPath();
  ctx.arc(pivotX, pivotY, hubR, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = slotColor(colors, 0);
  ctx.lineWidth = Math.max(0.6, 0.7 * unit);
  ctx.beginPath();
  ctx.arc(pivotX, pivotY, hubR, 0, TAU);
  ctx.stroke();
}
