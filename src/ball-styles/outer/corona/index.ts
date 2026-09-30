import { defineBallStyle } from "../../types";
import { locale } from "./i18n";
import { draw } from "./frontend";

export const module = defineBallStyle("corona", "outer", "spectrum", 3, locale, draw);
