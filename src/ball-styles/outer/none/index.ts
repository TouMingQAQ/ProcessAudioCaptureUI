import { defineBallStyle, type BallStyleModule } from "../../types";
import { locale } from "./i18n";
import { renderer } from "./frontend";

export const module: BallStyleModule = defineBallStyle(
  "none", "outer", "adaptive", 0, locale, renderer,
);
