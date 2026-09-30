import { defineBallStyle, type BallStyleModule } from "../../types";
import { locale } from "./i18n";
import { draw } from "./frontend";

export const module: BallStyleModule = defineBallStyle(
  "none", "inner", "adaptive", 0, locale, draw, "dim", false,
);
