import { defineBallStyle, type BallStyleModule } from "../../types";
import { locale } from "./i18n";
import { renderer } from "./frontend";

export const module: BallStyleModule = defineBallStyle(
  "wave", "outer", "wave", 2, locale, renderer,
);
