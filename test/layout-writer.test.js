import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { writeLayoutPdf } from "../dist/core/layout-writer.js";
import { computePageBreaks } from "../dist/core/page-breaker.js";

// A 2x2 red PNG.
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP4z8DwHwyBNBAwQBkoAAB8CAj9d0eEPAAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const radii = (r) => ({
  tl: { x: r, y: r },
  tr: { x: r, y: r },
  br: { x: r, y: r },
  bl: { x: r, y: r },
});
const style = (extra = {}) => ({
  fontSizePt: 12,
  bold: false,
  italic: false,
  fontFamily: "sans-serif",
  fontWeight: "400",
  color: { r: 0, g: 0, b: 0, a: 1 },
  letterSpacingPt: 0,
  underline: false,
  ...extra,
});

export function sampleLayout() {
  return {
    width: 600,
    height: 1300,
    notes: [],
    avoid: [],
    prims: [
      {
        type: "rect",
        x: 0,
        y: 0,
        w: 600,
        h: 1300,
        radii: null,
        color: { r: 0.97, g: 0.96, b: 1, a: 1 },
        alpha: 1,
      },
      {
        type: "gradient",
        x: 20,
        y: 20,
        w: 560,
        h: 160,
        radii: radii(18),
        alpha: 1,
        axis: { x0: 20, y0: 20, x1: 580, y1: 180 },
        stops: [
          { pos: 0, color: { r: 0.36, g: 0.18, b: 0.77 } },
          { pos: 0.5, color: { r: 0.9, g: 0.3, b: 0.5 } },
          { pos: 1, color: { r: 1, g: 0.7, b: 0.2 } },
        ],
      },
      {
        type: "rect",
        x: 20,
        y: 100,
        w: 560,
        h: 80,
        radii: {
          tl: { x: 0, y: 0 },
          tr: { x: 0, y: 0 },
          br: { x: 18, y: 18 },
          bl: { x: 18, y: 18 },
        },
        color: { r: 0, g: 0, b: 0, a: 0.35 },
        alpha: 1,
      },
      {
        type: "text",
        text: "Kashmir Summer Escape",
        x: 40,
        y: 40,
        w: 300,
        h: 30,
        baseline: 62,
        alpha: 1,
        style: style({
          fontSizePt: 24,
          bold: true,
          color: { r: 1, g: 1, b: 1, a: 1 },
        }),
      },
      {
        type: "text",
        text: "Total ₹27,376 — per head",
        x: 40,
        y: 120,
        w: 300,
        h: 20,
        baseline: 135,
        alpha: 1,
        style: style({
          fontSizePt: 14,
          color: { r: 1, g: 1, b: 1, a: 1 },
          letterSpacingPt: 1,
        }),
      },
      {
        type: "rect",
        x: 20,
        y: 200,
        w: 270,
        h: 120,
        radii: radii(16),
        color: { r: 1, g: 1, b: 1, a: 1 },
        alpha: 1,
      },
      {
        type: "border",
        x: 20,
        y: 200,
        w: 270,
        h: 120,
        radii: radii(16),
        alpha: 1,
        sides: Array(4).fill({
          w: 2,
          kind: "solid",
          color: { r: 0.36, g: 0.18, b: 0.77, a: 1 },
        }),
      },
      {
        type: "border",
        x: 310,
        y: 200,
        w: 270,
        h: 120,
        radii: null,
        alpha: 1,
        sides: [
          { w: 0, kind: "none", color: { r: 0, g: 0, b: 0, a: 0 } },
          { w: 0, kind: "none", color: { r: 0, g: 0, b: 0, a: 0 } },
          { w: 3, kind: "solid", color: { r: 0.9, g: 0.3, b: 0.5, a: 1 } },
          { w: 0, kind: "none", color: { r: 0, g: 0, b: 0, a: 0 } },
        ],
      },
      { type: "clip-start", x: 310, y: 200, w: 270, h: 120, radii: radii(60) },
      {
        type: "image",
        x: 310,
        y: 200,
        w: 270,
        h: 120,
        radii: null,
        alpha: 1,
        bytes: PNG,
        naturalW: 2,
        naturalH: 2,
        fit: "cover",
        posX: 0.5,
        posY: 0.5,
      },
      { type: "clip-end" },
      {
        type: "text",
        text: "Inside a rounded card",
        x: 36,
        y: 215,
        w: 200,
        h: 20,
        baseline: 230,
        alpha: 1,
        style: style(),
      },
      {
        type: "vector",
        x: 500,
        y: 40,
        w: 48,
        h: 48,
        alpha: 1,
        userToPx: { sx: 2, sy: 2, tx: 500, ty: 40 },
        shapes: [
          {
            segments: [
              { op: "M", x: 12, y: 2 },
              { op: "C", x1: 17.5, y1: 2, x2: 22, y2: 6.5, x: 22, y: 12 },
              { op: "C", x1: 22, y1: 17.5, x2: 17.5, y2: 22, x: 12, y: 22 },
              { op: "Z" },
            ],
            matrix: [1, 0, 0, 1, 0, 0],
            fill: null,
            stroke: { r: 1, g: 1, b: 1, a: 1 },
            strokeWidth: 2,
            cap: "round",
            join: "round",
            evenOdd: false,
            dash: null,
            opacity: 1,
          },
          {
            segments: [
              { op: "M", x: 7, y: 12 },
              { op: "L", x: 11, y: 16 },
              { op: "L", x: 17, y: 8 },
            ],
            matrix: [1, 0, 0, 1, 0, 0],
            fill: { r: 1, g: 0.8, b: 0, a: 1 },
            stroke: { r: 0, g: 0, b: 0, a: 1 },
            strokeWidth: 1,
            cap: "butt",
            join: "miter",
            evenOdd: true,
            dash: [2, 1],
            opacity: 0.8,
          },
        ],
      },
      {
        type: "link",
        x: 36,
        y: 1180,
        w: 300,
        h: 20,
        href: "https://example.com/book",
        alpha: 1,
      },
      {
        type: "rect",
        x: 20,
        y: 1150,
        w: 560,
        h: 120,
        radii: radii(16),
        color: { r: 0.36, g: 0.18, b: 0.77, a: 1 },
        alpha: 0.5,
      },
      {
        type: "text",
        text: "A card that crosses the page cut",
        x: 36,
        y: 1180,
        w: 300,
        h: 20,
        baseline: 1195,
        alpha: 1,
        style: style({ underline: true }),
      },
    ],
  };
}

test("writeLayoutPdf draws every primitive type into a valid multi-page PDF", async () => {
  const layout = sampleLayout();
  const scale = (595.28 - 72) / layout.width;
  const cuts = computePageBreaks({
    totalHeight: layout.height,
    pageHeight: (841.89 - 72) / scale,
  });
  const { bytes, warnings } = await writeLayoutPdf(layout, {
    pageWidthPt: 595.28,
    pageHeightPt: 841.89,
    marginTopPt: 36,
    marginBottomPt: 36,
    marginLeftPt: 36,
    cuts,
    scale,
  });
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), "%PDF-");
  assert.ok(cuts.length >= 3, "the sample is taller than one page");
  assert.ok(bytes.length > 1500);
  // The rupee sign has no glyph in the standard fonts; the bundled Unicode font draws it, so nothing is left out.
  assert.deepEqual(warnings, []);
  globalThis.__layoutSamplePdf = bytes;
});

test("link primitives become clickable URI annotations on the right page", async () => {
  const layout = sampleLayout();
  const scale = (595.28 - 72) / layout.width;
  const cuts = computePageBreaks({
    totalHeight: layout.height,
    pageHeight: (841.89 - 72) / scale,
  });
  const { bytes } = await writeLayoutPdf(layout, {
    pageWidthPt: 595.28,
    pageHeightPt: 841.89,
    marginTopPt: 36,
    marginBottomPt: 36,
    marginLeftPt: 36,
    cuts,
    scale,
  });
  const doc = await PDFDocument.load(bytes);
  const annots = doc.getPages().map((p) => p.node.Annots()?.size() ?? 0);
  assert.equal(
    annots.reduce((a, b) => a + b, 0),
    1,
  );
  assert.equal(annots[0], 0, "the link sits below the first cut");
});
