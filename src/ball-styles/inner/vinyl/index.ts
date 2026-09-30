import { defineBallStyle } from "../../types";
import { locale } from "./i18n";
import { draw } from "./frontend";

export const module = defineBallStyle("vinyl", "inner", "level", 3, locale, draw);
