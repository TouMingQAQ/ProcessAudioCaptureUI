import { defineBallStyle, type BallStyleModule } from "../../types";
import { locale } from "./i18n";
import { draw } from "./frontend";

export const module: BallStyleModule = defineBallStyle(
  "laser", "inner", "wave", 2, locale, draw, "visible", true,
);
