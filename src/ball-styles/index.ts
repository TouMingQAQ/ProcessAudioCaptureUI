import type { BallStyleModule } from "./types";
import { module as pulse } from "./inner/pulse";
import { module as vu } from "./inner/vu";
import { module as laser } from "./inner/laser";
import { module as innerNone } from "./inner/none";
import { module as ring } from "./outer/ring";
import { module as wave } from "./outer/wave";
import { module as outerNone } from "./outer/none";
import { module as vinyl } from "./inner/vinyl";
import { module as pixel } from "./inner/pixel";
import { module as gyro } from "./inner/gyro";
import { module as petal } from "./inner/petal";
import { module as radar } from "./outer/radar";
import { module as gear } from "./outer/gear";
import { module as corona } from "./outer/corona";
import { module as braid } from "./outer/braid";
export const BALL_STYLE_MODULES: BallStyleModule[] = [
  pulse, vu, laser, vinyl, pixel, gyro, petal, innerNone,
  ring, wave, radar, gear, corona, braid, outerNone,
];
