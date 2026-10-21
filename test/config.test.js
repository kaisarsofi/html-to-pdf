import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { resolveConfig, RENDER_DEFAULTS } from "../dist/config.js";
import { unicodeRangeCovers } from "../dist/core/font-registry.js";
import { createRegistry } from "../dist/fonts/runtime.js";

test("no config at all gives the zero-setup defaults", () => {
  const c = resolveConfig();
  assert.equal(c.layout, "preserve");
  assert.equal(c.page.mode, "continuous");
  assert.deepEqual(c.page.margin, { top: 0, bottom: 0, left: 0 });
  assert.equal(c.fonts, "auto");
  assert.equal(c.links, true);
  assert.equal(c.bundledFallbackFont, true);
  assert.deepEqual(c.render, RENDER_DEFAULTS);
  assert.equal(c.render.viewportWidth, 1440);
  assert.equal(c.render.theme, "light");
  assert.equal(c.render.contentWidth, "auto");
  assert.deepEqual(c.images.resolution, {
    pixelRatio: 2,
    jpegQuality: 0.95,
    recompressAbove: 1.5,
  });
});

test("paginated pages default to a 36pt margin and A4", () => {
  const c = resolveConfig({ page: { mode: "paginated" } });
  assert.deepEqual(c.page.margin, { top: 36, bottom: 36, left: 36 });
  assert.equal(c.page.size.width, 595.28);
});

test("a single margin number applies to every side, and named sizes resolve", () => {
  const c = resolveConfig({ page: { margin: 12, size: "LETTER" } });
  assert.deepEqual(c.page.margin, { top: 12, bottom: 12, left: 12 });
  assert.equal(c.page.size.width, 612);
});

test("user settings override only what they name", () => {
  const c = resolveConfig({
    render: { viewportWidth: 1280, theme: "auto" },
    images: { quality: 0.8 },
    links: false,
  });
  assert.equal(c.render.viewportWidth, 1280);
  assert.equal(c.render.theme, "auto");
  assert.equal(c.render.hide, "[data-pdf-hide]");
  assert.equal(c.images.resolution.jpegQuality, 0.8);
  assert.equal(c.images.resolution.pixelRatio, 2);
  assert.equal(c.links, false);
});

test("render:false and resample:false switch those stages off", () => {
  assert.equal(resolveConfig({ render: false }).render, null);
  assert.equal(
    resolveConfig({ images: { resample: false } }).images.resolution,
    null,
  );
});

test("unicode-range matching handles ranges, single points and wildcards", () => {
  const latin = "U+0000-00FF, U+0131, U+0152-0153, U+2000-206F";
  assert.equal(unicodeRangeCovers(latin, 0x41), true);
  assert.equal(unicodeRangeCovers(latin, 0x131), true);
  assert.equal(unicodeRangeCovers(latin, 0x20b9), false);
  assert.equal(unicodeRangeCovers("U+25??", 0x2550), true);
  assert.equal(unicodeRangeCovers("U+25??", 0x2650), false);
  assert.equal(
    unicodeRangeCovers(undefined, 0x20b9),
    true,
    "no range means every character",
  );
});

test("the bundled Unicode font is loaded only when a character needs it", async () => {
  const run = {
    fontFamily: "Arial, sans-serif",
    fontWeight: "400",
    bold: false,
    italic: false,
  };

  const plain = await PDFDocument.create();
  const reg1 = createRegistry(plain);
  await reg1.prepareText([{ run, text: "Hello" }]);
  assert.equal(
    reg1.fallbackFor(run, 0x20b9),
    null,
    "nothing was needed, so nothing was loaded",
  );

  const rupee = await PDFDocument.create();
  const reg2 = createRegistry(rupee);
  await reg2.prepareText([{ run, text: "Cost ₹500" }]);
  const face = reg2.fallbackFor(run, 0x20b9);
  assert.ok(face, "the bundled font now covers the rupee sign");
  assert.equal(reg2.canDraw(face, 0x20b9), true);
  assert.deepEqual(reg2.warnings, []);
});

test("with the bundled fallback off, an undrawable character is reported, not thrown", async () => {
  const run = {
    fontFamily: "Arial, sans-serif",
    fontWeight: "400",
    bold: false,
    italic: false,
  };
  const doc = await PDFDocument.create();
  const reg = createRegistry(doc, { bundledFallback: false });
  await reg.prepareText([{ run, text: "₹" }]);
  assert.equal(reg.fallbackFor(run, 0x20b9), null);
});

test("a variable font is skipped with a warning instead of being embedded at the wrong weight", async () => {
  const doc = await PDFDocument.create();
  const reg = createRegistry(doc, {
    fonts: [
      { family: "Inter", weight: "100 900", bytes: new Uint8Array([1, 2, 3]) },
    ],
    bundledFallback: false,
  });
  const run = {
    fontFamily: "Inter, sans-serif",
    fontWeight: "700",
    bold: true,
    italic: false,
  };
  await reg.prepareText([{ run, text: "Hello" }]);
  assert.ok(reg.warnings.some((w) => w.includes("variable font")));
  assert.ok(reg.canDraw(reg.resolve(run), 72), "a standard font drew it");
});

test("a corrupt font file becomes a warning, never a thrown error or a hang", async () => {
  const doc = await PDFDocument.create();
  const reg = createRegistry(doc, {
    fonts: [
      {
        family: "Broken",
        weight: 400,
        bytes: new Uint8Array([0, 1, 2, 3, 4, 5]),
      },
    ],
    bundledFallback: false,
  });
  const run = {
    fontFamily: "Broken, sans-serif",
    fontWeight: "400",
    bold: false,
    italic: false,
  };
  await reg.prepareText([{ run, text: "Hello" }]);
  assert.ok(
    reg.warnings.some((w) => w.includes('could not embed font "Broken"')),
  );
  assert.ok(reg.canDraw(reg.resolve(run), 72));
});

test("page.maxHeight defaults to no limit and accepts a positive number", () => {
  assert.equal(resolveConfig().page.maxHeight, null);
  assert.equal(
    resolveConfig({ page: { maxHeight: 1600 } }).page.maxHeight,
    1600,
  );
  assert.equal(resolveConfig({ page: { maxHeight: 0 } }).page.maxHeight, null);
});
