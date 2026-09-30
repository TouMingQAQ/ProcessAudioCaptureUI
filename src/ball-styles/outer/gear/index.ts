import { defineBallStyle } from "../../types";
import { locale } from "./i18n";
import { draw } from "./frontend";

export const module = defineBallStyle("gear", "outer", "spectrum", 3, locale, draw);
