import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFArray, PDFDocument, PDFName, decodePDFRawStream } from "pdf-lib";
import {
  alphaOnlyBands,
  invertMatrix,
  matrixAbout,
  multiplyMatrix,
  parseBoxShadows,
  parseClipPath,
  parseTransformMatrix,
  parseTransformOrigin,
  shadowLayers,
} from "../dist/core/layout-math.js";
import { writeLayoutPdf } from "../dist/core/layout-writer.js";

const near = (a, b, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

test("transform: matrix() and matrix3d() are read, none is not", () => {
  assert.deepEqual(parseTransformMatrix("matrix(1, 0, 0, 1, 10, 20)"), [
    1, 0, 0, 1, 10, 20,
  ]);
  assert.deepEqual(
    parseTransformMatrix(
      "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 0, 1)",
    ),
    [1, 0, 0, 1, 5, 6],
  );
  assert.equal(parseTransformMatrix("none"), null);
  assert.equal(parseTransformMatrix("rotate(45deg)"), null);
});

test("transform: a rotation about the origin leaves the origin where it is", () => {
  const a = (-45 * Math.PI) / 180;
  const rot = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
  const m = matrixAbout(rot, 24, 24);
  const [x, y] = apply(m, 24, 24);
  near(x, 24);
  near(y, 24);
  const [px, py] = apply(m, 24 + 10, 24);
  near(px, 24 + 10 * Math.cos(a));
  near(py, 24 + 10 * Math.sin(a));
});

test("transform: invert and multiply round-trip", () => {
  const m = [2, 0.5, -0.3, 1.5, 12, -7];
  const inv = invertMatrix(m);
  const id = multiplyMatrix(m, inv);
  [1, 0, 0, 1, 0, 0].forEach((v, i) => near(id[i], v));
  assert.equal(invertMatrix([0, 0, 0, 0, 1, 1]), null);
});

test("transform-origin: computed px, keywords and percentages", () => {
  assert.deepEqual(parseTransformOrigin("36px 36px", 72, 72), { x: 36, y: 36 });
  assert.deepEqual(parseTransformOrigin("left top", 100, 50), { x: 0, y: 0 });
  assert.deepEqual(parseTransformOrigin("25% 50%", 200, 100), { x: 50, y: 50 });
});

test("clip-path: polygon with px and percentages becomes a closed path", () => {
  const shape = parseClipPath(
    "polygon(0px 0px, 100% 0px, 0px 100%)",
    72,
    72,
  );
  assert.deepEqual(shape.segments, [
    { op: "M", x: 0, y: 0 },
    { op: "L", x: 72, y: 0 },
    { op: "L", x: 0, y: 72 },
    { op: "Z" },
  ]);
  assert.equal(shape.evenOdd, false);
  assert.equal(
    parseClipPath("polygon(evenodd, 0 0, 10 0, 10 10)", 100, 100).evenOdd,
    true,
  );
});

test("clip-path: inset, circle and ellipse are read; none, url() and calc() are not", () => {
  const inset = parseClipPath("inset(10px 20px 10px 20px)", 200, 100);
  assert.deepEqual(inset.segments[0], { op: "M", x: 20, y: 10 });
  assert.deepEqual(inset.segments[2], { op: "L", x: 180, y: 90 });

  const circle = parseClipPath("circle(40px at 50% 50%)", 200, 100);
  assert.deepEqual(circle.segments[0], { op: "M", x: 140, y: 50 });
  assert.equal(circle.segments.filter((s) => s.op === "C").length, 4);

  const ellipse = parseClipPath("ellipse(50% 50% at 50% 50%)", 200, 100);
  assert.deepEqual(ellipse.segments[0], { op: "M", x: 200, y: 50 });

  assert.equal(parseClipPath("none", 10, 10), null);
  assert.equal(parseClipPath("url(#a)", 10, 10), null);
  assert.equal(parseClipPath("polygon(calc(1px + 2px) 0, 1px 1px, 0 1px)", 10, 10), null);
});

test("box-shadow: offsets, blur, spread, colour and inset are read from computed values", () => {
  const [a] = parseBoxShadows("rgba(15, 23, 42, 0.05) 0px 10px 32px 0px");
  assert.deepEqual(
    [a.dx, a.dy, a.blur, a.spread, a.inset],
    [0, 10, 32, 0, false],
  );
  near(a.color.a, 0.05);

  const list = parseBoxShadows(
    "rgba(0, 0, 0, 0.1) 0px 1px 2px 0px, rgb(255 255 255 / 0.7) 0px 0px 0px 2px",
  );
  assert.equal(list.length, 2);
  assert.equal(list[1].spread, 2);
  near(list[1].color.a, 0.7);

  assert.equal(
    parseBoxShadows("rgba(0, 0, 0, 0.2) 0px 0px 4px 0px inset")[0].inset,
    true,
  );
  assert.deepEqual(parseBoxShadows("none"), []);
});

const radii = (r) => ({
  tl: { x: r, y: r },
  tr: { x: r, y: r },
  br: { x: r, y: r },
  bl: { x: r, y: r },
});

async function pageOperators(bytes) {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPages()[0];
  const streams = (obj) => {
    const resolved = doc.context.lookup(obj);
    return resolved instanceof PDFArray
      ? resolved.asArray().flatMap(streams)
      : [resolved];
  };
  return streams(page.node.normalizedEntries().Contents)
    .map((stream) =>
      Buffer.from(
        typeof stream.getUnencodedContents === "function"
          ? stream.getUnencodedContents()
          : decodePDFRawStream(stream).decode(),
      ).toString("latin1"),
    )
    .join("\n");
}

test("writer: a transform becomes a cm matrix and a clip-path becomes a clip, each in balanced q/Q", async () => {
  const a = (-45 * Math.PI) / 180;
  const layout = {
    width: 200,
    height: 200,
    notes: [],
    avoid: [],
    prims: [
      {
        type: "transform-start",
        x: 0,
        y: 0,
        w: 72,
        h: 72,
        matrix: matrixAbout([Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0], 24, 24),
      },
      {
        type: "shape-clip-start",
        x: 0,
        y: 0,
        w: 72,
        h: 72,
        evenOdd: false,
        segments: [
          { op: "M", x: 0, y: 0 },
          { op: "L", x: 72, y: 0 },
          { op: "L", x: 0, y: 72 },
          { op: "Z" },
        ],
      },
      {
        type: "rect",
        x: 0,
        y: 0,
        w: 72,
        h: 72,
        radii: radii(0),
        color: { r: 0.8, g: 0.85, b: 0.9, a: 1 },
        alpha: 1,
      },
      { type: "shape-clip-end" },
      { type: "transform-end" },
    ],
  };
  const { bytes } = await writeLayoutPdf(layout, {
    pageWidthPt: 300,
    pageHeightPt: 300,
    marginTopPt: 0,
    marginBottomPt: 0,
    marginLeftPt: 0,
    cuts: [0, 200],
    scale: 0.75,
  });
  const ops = await pageOperators(bytes);
  assert.match(ops, /\bcm\b/);
  assert.match(ops, /\bW\b/);
  const pushes = (ops.match(/^q$/gm) ?? []).length;
  const pops = (ops.match(/^Q$/gm) ?? []).length;
  assert.equal(pushes, pops, "every saved graphics state is restored");
});

test("shadow layers: the stack adds up to roughly the shadow's opacity and fades outward", () => {
  const layers = shadowLayers(32, 0.5);
  assert.ok(layers.length >= 4, "a soft shadow uses several layers");
  const total = layers.reduce((sum, l) => sum + l.alpha, 0);
  assert.ok(total > 0.4 && total <= 0.5 + 1e-9, `total ${total}`);
  for (let i = 1; i < layers.length; i++)
    assert.ok(layers[i].grow > layers[i - 1].grow, "layers grow outward");
  assert.deepEqual(shadowLayers(0, 0.3), [{ grow: 0, alpha: 0.3 }]);
  assert.ok(shadowLayers(2, 0.04).length <= 3, "a hairline shadow stays cheap");
});

test("writer: a shadow is clipped around the element's box and stays vector (no images)", async () => {
  const layout = {
    width: 300,
    height: 200,
    notes: [],
    avoid: [],
    prims: [
      {
        type: "shadow",
        x: 50,
        y: 50,
        w: 200,
        h: 100,
        radii: radii(12),
        dx: 0,
        dy: 10,
        layers: shadowLayers(30, 1).map((l) => ({ ...l })),
        color: { r: 0.06, g: 0.09, b: 0.16, a: 1 },
        alpha: 0.2,
        cutout: true,
      },
    ],
  };
  const { bytes } = await writeLayoutPdf(layout, {
    pageWidthPt: 400,
    pageHeightPt: 300,
    marginTopPt: 0,
    marginBottomPt: 0,
    marginLeftPt: 0,
    cuts: [0, 200],
    scale: 0.75,
  });
  const ops = await pageOperators(bytes);
  assert.match(ops, /W\*/);
  const doc = await PDFDocument.load(bytes);
  let images = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj?.dict?.get?.(PDFName.of("Subtype"))?.toString() === "/Image") images++;
  }
  assert.equal(images, 0);
  const pushes = (ops.match(/^q$/gm) ?? []).length;
  const pops = (ops.match(/^Q$/gm) ?? []).length;
  assert.equal(pushes, pops);
});

const stop = (pos, r, g, b, a) => ({ pos, color: { r, g, b, a } });

test("alpha-only gradient: a single-colour fade becomes a few flat bands that fall off smoothly", () => {
  const flat = alphaOnlyBands([stop(0, 0, 0, 0, 0.6), stop(1, 0, 0, 0, 0)]);
  assert.ok(flat, "one colour, only opacity changes");
  assert.deepEqual(
    [flat.color.r, flat.color.g, flat.color.b, flat.color.a],
    [0, 0, 0, 1],
  );
  assert.ok(flat.bands.length >= 6 && flat.bands.length <= 48);
  for (let i = 1; i < flat.bands.length; i++)
    assert.ok(flat.bands[i].alpha <= flat.bands[i - 1].alpha + 1e-9);
  assert.equal(flat.bands[0].from, 0);
  assert.equal(flat.bands[flat.bands.length - 1].to, 1);
  near(flat.maxAlpha, 0.6);
});

test("alpha-only gradient: a hard edge stays a hard edge, and mixed colours are left to the bitmap path", () => {
  const edge = alphaOnlyBands([
    stop(0, 0.93, 0.95, 0.96, 1),
    stop(0.49, 0.93, 0.95, 0.96, 1),
    stop(0.5, 0.93, 0.95, 0.96, 0),
    stop(1, 0.93, 0.95, 0.96, 0),
  ]);
  assert.ok(edge.bands.length <= 4, `${edge.bands.length} bands`);
  assert.equal(edge.bands[0].alpha, 1);
  assert.equal(
    alphaOnlyBands([stop(0, 1, 0, 0, 0.5), stop(1, 0, 0, 1, 0.5)]),
    null,
  );
});

test("writer: an alpha-only gradient is flat vector bands inside a clip, with no images", async () => {
  const flat = alphaOnlyBands([stop(0, 0.06, 0.09, 0.16, 0.05), stop(1, 0.06, 0.09, 0.16, 0)]);
  const prim = (shape) => ({
    type: "alpha-gradient",
    x: 20,
    y: 20,
    w: 200,
    h: 120,
    radii: radii(10),
    alpha: 1,
    color: flat.color,
    shape,
    axis: { x0: 20, y0: 20, x1: 220, y1: 140 },
    bands: flat.bands,
  });
  for (const shape of ["linear", "radial"]) {
    const { bytes } = await writeLayoutPdf(
      { width: 260, height: 180, notes: [], avoid: [], prims: [prim(shape)] },
      {
        pageWidthPt: 400,
        pageHeightPt: 300,
        marginTopPt: 0,
        marginBottomPt: 0,
        marginLeftPt: 0,
        cuts: [0, 180],
        scale: 0.75,
      },
    );
    const ops = await pageOperators(bytes);
    assert.match(ops, /\bW\b/);
    const doc = await PDFDocument.load(bytes);
    let images = 0;
    for (const [, obj] of doc.context.enumerateIndirectObjects())
      if (obj?.dict?.get?.(PDFName.of("Subtype"))?.toString() === "/Image") images++;
    assert.equal(images, 0, shape);
    assert.equal((ops.match(/^q$/gm) ?? []).length, (ops.match(/^Q$/gm) ?? []).length);
  }
});

test("writer: the shadow of an opaque element is a ring (even-odd fill), not a clipped full fill", async () => {
  const layout = {
    width: 300,
    height: 200,
    notes: [],
    avoid: [],
    prims: [
      {
        type: "shadow",
        x: 50,
        y: 50,
        w: 200,
        h: 100,
        radii: radii(12),
        dx: 0,
        dy: 10,
        layers: shadowLayers(30, 1).map((l) => ({ ...l })),
        color: { r: 0.06, g: 0.09, b: 0.16, a: 1 },
        alpha: 0.2,
        cutout: false,
      },
    ],
  };
  const { bytes } = await writeLayoutPdf(layout, {
    pageWidthPt: 400,
    pageHeightPt: 300,
    marginTopPt: 0,
    marginBottomPt: 0,
    marginLeftPt: 0,
    cuts: [0, 200],
    scale: 0.75,
  });
  const ops = await pageOperators(bytes);
  assert.match(ops, /^f\*$/m);
  assert.doesNotMatch(ops, /W\*/);
});
