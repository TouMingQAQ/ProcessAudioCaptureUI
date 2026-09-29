import { defineBallStyle, type BallStyleModule } from "../../types";
import { locale } from "./i18n";
import { renderer } from "./frontend";

export const module: BallStyleModule = defineBallStyle(
  "laser", "inner", "wave", 2, locale, renderer,
);
