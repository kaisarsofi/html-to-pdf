import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFamily } from "../dist/core/font-registry.js";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// Lora (a static serif) from the @fontsource devDependency, used as a custom test font.
const loraBytes = (weight) =>
  fs.readFileSync(
    path.join(
      path.dirname(
        createRequire(import.meta.url).resolve("@fontsource/lora/package.json"),
      ),
      "files",
      `lora-latin-${weight}-normal.woff`,
    ),
  );

test("generic families map onto the standard 14", () => {
  assert.equal(classifyFamily("Helvetica, Arial, sans-serif"), "sans");
  assert.equal(classifyFamily('Georgia, "Times New Roman", serif'), "serif");
  assert.equal(classifyFamily("ui-monospace, Menlo, monospace"), "mono");
});

test("sans-serif is not mistaken for serif", () => {
  // "sans-serif" contains the substring "serif". Testing serif first would
  // render every sans-serif document in Times.
  assert.equal(classifyFamily("sans-serif"), "sans");
  assert.equal(classifyFamily("system-ui, sans-serif"), "sans");
  assert.equal(classifyFamily("serif"), "serif");
});

test("monospace wins over a sans fallback in the same list", () => {
  // A code font list usually ends in a generic fallback; the monospace intent
  // is the one that matters.
  assert.equal(classifyFamily('Consolas, "Courier New", monospace'), "mono");
  assert.equal(
    classifyFamily("SFMono-Regular, Menlo, Monaco, monospace"),
    "mono",
  );
});

test("an unrecognised family falls back to sans rather than failing", () => {
  assert.equal(classifyFamily("Wingdings"), "sans");
  assert.equal(classifyFamily(""), "sans");
  assert.equal(classifyFamily(undefined), "sans");
  assert.equal(classifyFamily(null), "sans");
});

import { splitByCoverage } from "../dist/core/font-registry.js";

test("splitByCoverage separates characters a font cannot draw", () => {
  const winAnsi = (cp) => cp < 0x100;
  assert.deepEqual(splitByCoverage("Cost ₹38,000 total", winAnsi), [
    { text: "Cost ", ok: true },
    { text: "₹", ok: false },
    { text: "38,000 total", ok: true },
  ]);
});

test("splitByCoverage keeps fully drawable text as one segment", () => {
  assert.deepEqual(
    splitByCoverage("Hello", () => true),
    [{ text: "Hello", ok: true }],
  );
  assert.deepEqual(
    splitByCoverage("", () => true),
    [],
  );
});

test("splitByCoverage groups adjacent unsupported characters", () => {
  assert.deepEqual(
    splitByCoverage("a₹₹b", (cp) => cp < 0x100),
    [
      { text: "a", ok: true },
      { text: "₹₹", ok: false },
      { text: "b", ok: true },
    ],
  );
});

import fontkit from "@pdf-lib/fontkit";
import { PDFDocument } from "pdf-lib";
import { createFontRegistry } from "../dist/core/font-registry.js";

test("an embedded font that lacks a glyph is reported as unable to draw it", async () => {
  // fontkit does not throw for a missing glyph: it substitutes the .notdef box.
  // The registry has to ask the font for the real glyph or the box gets drawn.
  const bytes = loraBytes("400");
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const registry = createFontRegistry(doc, {
    fonts: [{ family: "Lora", weight: 400, bytes }],
  });
  const run = {
    fontFamily: "Lora, serif",
    fontWeight: "400",
    bold: false,
    italic: false,
  };
  await registry.prepareText([{ run, text: "A" }]);
  const lora = registry.resolve(run);
  assert.equal(registry.canDraw(lora, "A".codePointAt(0)), true);
  assert.equal(
    registry.canDraw(lora, 0x0e01),
    false,
    "a Thai letter is not in Lora",
  );
});

test("fonts are matched to the nearest weight, not just normal or bold", async () => {
  const bytes = loraBytes("400");
  const boldBytes = loraBytes("700");
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const registry = createFontRegistry(doc, {
    fonts: [
      { family: "Lora", weight: 400, bytes },
      { family: "Lora", weight: 700, bytes: boldBytes },
    ],
  });
  const at = (w) => ({
    fontFamily: "Lora, serif",
    fontWeight: String(w),
    bold: w >= 600,
    italic: false,
  });
  await registry.prepareText(
    [300, 500, 600, 700].map((w) => ({ run: at(w), text: "A" })),
  );
  assert.equal(
    registry.resolve(at(300)),
    registry.resolve(at(400)),
    "300 is nearest 400",
  );
  assert.equal(
    registry.resolve(at(500)),
    registry.resolve(at(400)),
    "500 is nearest 400",
  );
  assert.equal(
    registry.resolve(at(600)),
    registry.resolve(at(700)),
    "600 is nearest 700",
  );
  assert.notEqual(registry.resolve(at(400)), registry.resolve(at(700)));
});
