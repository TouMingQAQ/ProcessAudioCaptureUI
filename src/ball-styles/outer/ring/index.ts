import { defineBallStyle, type BallStyleModule } from "../../types";
import { locale } from "./i18n";
import { draw } from "./frontend";

export const module: BallStyleModule = defineBallStyle(
  "ring", "outer", "spectrum", 3, locale, draw, "visible", false,
);
