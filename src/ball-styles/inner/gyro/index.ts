import { defineBallStyle } from "../../types";
import { locale } from "./i18n";
import { draw } from "./frontend";

export const module = defineBallStyle("gyro", "inner", "level", 3, locale, draw);
