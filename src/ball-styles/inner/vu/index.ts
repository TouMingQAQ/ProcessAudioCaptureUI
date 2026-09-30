import { defineBallStyle, type BallStyleModule } from "../../types";
import { locale } from "./i18n";
import { draw } from "./frontend";

export const module: BallStyleModule = defineBallStyle(
  "vu", "inner", "level", 3, locale, draw, "dim", true,
);
