import type { BallStyleModule } from "./types";
import { module as pulse } from "./inner/pulse";
import { module as vu } from "./inner/vu";
import { module as laser } from "./inner/laser";
import { module as innerNone } from "./inner/none";
import { module as ring } from "./outer/ring";
import { module as wave } from "./outer/wave";
import { module as outerNone } from "./outer/none";
export const BALL_STYLE_MODULES: BallStyleModule[] = [pulse, vu, laser, innerNone, ring, wave, outerNone];
