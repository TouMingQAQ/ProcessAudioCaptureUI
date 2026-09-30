import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";

// Point PLAYWRIGHT_MODULE at an external installation to keep app dependencies unchanged.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const output = process.env.ORB_QA_OUTPUT || path.join(process.env.TEMP || ".", "orb-style-qa", "results");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await page.goto(process.env.ORB_QA_URL || "http://127.0.0.1:5173/");
  const results = await page.evaluate(async () => {
    const { BALL_STYLE_MODULES } = await import("/src/ball-styles/index.ts");
    const { bandsForFrame, BALL_DATA_SOURCES } = await import("/src/ball-style.ts");
    const { renderOrb, renderStylePreview } = await import("/src/ball-render.ts");
    const { orbColorsFrom } = await import("/src/theme.ts");
    const { setLanguage, t } = await import("/src/i18n.ts");
    const innerIds = ["vinyl", "pixel", "gyro", "petal"];
    const outerIds = ["radar", "gear", "corona", "braid"];
    const styles = BALL_STYLE_MODULES.map(m => m.style);
    const find = (id, layer) => styles.find(s => s.id === id && s.layer === layer);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const assert = (ok, message) => { if (!ok) throw new Error(message); };
    const pixels = () => ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const differs = (a, b) => a.some((value, i) => value !== b[i]);
    let cases = 0;
    const colorsets = [["#29c8a8"], ["#29c8a8", "#ff6799", "#ffd166"]];
    const audio = { spectrum: Array.from({length: 48}, (_, i) => 0.3 + Math.sin(i * 0.7) ** 2 * 0.7), wave: Array.from({length: 48}, (_, i) => Math.abs(Math.sin(i * 0.4))), rms: 1, peak: 1 };
    const translations = {};
    for (const language of ["zh-CN", "en-US"]) {
      setLanguage(language);
      translations[language] = [];
      for (const id of [...innerIds, ...outerIds]) {
        const name = t("ballStyle." + id), hint = t("ballStyle.hint." + id);
        assert(!name.startsWith("ballStyle.") && !hint.startsWith("ballStyle."), "Missing locale: " + id);
        translations[language].push({ id, name, hint });
      }
    }
    for (const id of [...innerIds, ...outerIds, "laser"]) {
      const layer = outerIds.includes(id) ? "outer" : "inner";
      const style = find(id, layer);
      assert(style && style.layer === layer, "Wrong layer: " + id);
      for (const size of [40, 56, 96, 240]) for (const slots of colorsets) {
        canvas.width = canvas.height = size;
        const colors = orbColorsFrom(slots), unit = size / 96;
        const draw = (live, time, level, bands) => {
          ctx.clearRect(0, 0, size, size);
          ctx.save();
          style.draw(ctx, { center: size / 2, unit, size, breathe: 1, level, peak: level, live, time, bands, useWave: style.mode === "wave", colors });
          ctx.restore();
          return pixels();
        };
        const zeros = new Float32Array(48);
        const idle = draw(false, 0, 0, zeros);
        assert(idle.some(v => v > 0), "Blank idle: " + id);
        assert(differs(idle, draw(false, 1370, 0, zeros)), "Static idle: " + id);
        const silent = draw(true, 0, 0, zeros);
        assert(silent.some(v => v > 0), "Blank silence: " + id);
        const loud = draw(true, 0, 1, new Float32Array(48).fill(1));
        assert(differs(silent, loud), "No audio response: " + id);
        assert(differs(loud, draw(true, 1370, 1, new Float32Array(48).fill(1))), "Static live: " + id);
        if (id !== "laser") {
          const data = pixels();
          for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
            if (!data[(y * size + x) * 4 + 3]) continue;
            const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / unit;
            const tolerance = 1 / unit;
            assert(layer === "inner" ? r <= 23 + tolerance : r >= 27 - tolerance && r <= 44 + tolerance, "Bounds: " + id + " size " + size + " radius " + r);
          }
        }
        for (const source of BALL_DATA_SOURCES) {
          const frame = { inner: bandsForFrame(audio, source, 48), outer: bandsForFrame(audio, source, 48), level: 1, peak: 1, live: true, time: 900 };
          renderOrb(canvas, layer === "inner" ? style : find("none", "inner"), layer === "outer" ? style : find("none", "outer"), colors, frame, size, 1.5);
          assert(pixels().some(v => v > 0), "Blank source: " + id + source);
          cases++;
        }
        renderStylePreview(canvas, layer === "inner" ? style : find("none", "inner"), layer === "outer" ? style : find("none", "outer"), colors, size);
      }
    }
    document.body.replaceChildren();
    document.body.style.cssText = "margin:0;padding:24px;background:#17191c;color:white;font:14px Arial";
    const grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:repeat(4,1fr);gap:12px";
    document.body.append(grid);
    for (const inner of innerIds) for (const outer of outerIds) {
      const item = document.createElement("div"), c = document.createElement("canvas");
      item.style.cssText = "text-align:center;background:#222629;padding:8px";
      item.append(c, document.createElement("br"), inner + " + " + outer); grid.append(item);
      renderStylePreview(c, find(inner, "inner"), find(outer, "outer"), orbColorsFrom(colorsets[1]), 140);
      const shot = document.createElement("img");
      shot.src = c.toDataURL();
      shot.width = shot.height = 140;
      c.replaceWith(shot);
      cases++;
    }
    for (const [inner, outer] of [["laser","radar"], ["pulse","braid"], ["vu","radar"], ["vinyl","ring"], ["gyro","wave"]]) {
      renderStylePreview(canvas, find(inner, "inner"), find(outer, "outer"), orbColorsFrom(colorsets[1]), 96);
      assert(pixels().some(v => v > 0), "Blank mixed pair"); cases++;
    }
    return { cases, translations };
  });
  console.log(JSON.stringify(results, null, 2));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: path.join(output, "combinations.png"), fullPage: true });
  const settingsPage = await browser.newPage();
  await settingsPage.route("**/src/main.ts", route => route.abort());
  await settingsPage.goto(process.env.ORB_QA_URL || "http://127.0.0.1:5173/");
  await settingsPage.addStyleTag({ url: "/src/styles.css" });
  await settingsPage.evaluate(async () => {
    const { DEFAULT_SETTINGS } = await import("/src/settings.ts");
    const { createSettingsPanel } = await import("/src/settings-panel.ts");
    const { applyAppTheme } = await import("/src/theme.ts");
    const { setLanguage, applyI18n } = await import("/src/i18n.ts");
    const settings = { ...DEFAULT_SETTINGS, ballInnerStyle: "pulse", ballOuterStyle: "ring", ballColors: ["#29c8a8", "#ff6799", "#ffd166"] };
    applyAppTheme(settings.appTheme, "dark");
    const panel = createSettingsPanel({ prefs: { get: () => settings, patch: async patch => { Object.assign(settings, patch); panel.sync(settings); } }, reloadKernel: async () => null });
    window.qaLanguage = language => { setLanguage(language); applyI18n(); panel.relang(settings); };
    panel.open();
    document.querySelector('[data-tab="ball"]').click();
    document.querySelectorAll(".set-block.is-collapsible").forEach(block => block.dataset.collapsed = "false");
  });
  for (const width of [1100, 420]) for (const language of ["zh-CN", "en-US"]) {
    await settingsPage.setViewportSize({ width, height: 950 });
    await settingsPage.evaluate(language => window.qaLanguage(language), language);
    await settingsPage.locator(".style-card").first().scrollIntoViewIfNeeded();
    const check = await settingsPage.evaluate(() => {
      const cards = [...document.querySelectorAll(".style-card")];
      const problems = cards.filter(card => [...card.querySelectorAll(".style-card-name,.style-card-source")].some(el => el.scrollWidth > el.clientWidth + 1));
      const missing = cards.filter(card => {
        const canvas = card.querySelector("canvas");
        return !canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data.some(v => v > 0);
      });
      // Desynchronized canvas surfaces are absent from headless Edge screenshots.
      // Preserve the actual canvas bitmap in an image for visual inspection.
      for (const card of cards) {
        const canvas = card.querySelector("canvas"), image = document.createElement("img");
        image.className = canvas.className;
        image.src = canvas.toDataURL();
        canvas.replaceWith(image);
      }
      return { cards: cards.length, overflow: problems.map(c => c.dataset.styleId), missing: missing.map(c => c.dataset.styleId) };
    });
    if (check.cards !== 15 || check.overflow.length || check.missing.length) throw new Error("Settings layout: " + JSON.stringify(check));
    await settingsPage.screenshot({ path: path.join(output, "settings-" + width + "-" + language + ".png") });
  }
  console.log("Screenshots: " + output);
} finally {
  await browser.close();
}
