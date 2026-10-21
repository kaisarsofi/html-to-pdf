import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCssColor } from "../dist/core/color.js";
import {
  fitImage,
  gradientAxis,
  insetRadii,
  parseGradient,
  resolveRadii,
  resolveStops,
  splitFragmentsByLine,
  splitTopLevel,
} from "../dist/core/layout-math.js";
import { computePageBreaks } from "../dist/core/page-breaker.js";

const near = (a, b, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test("colours: rgb, rgba, hex and transparent parse without a browser", () => {
  assert.deepEqual(parseCssColor("rgb(255, 0, 0)"), { r: 1, g: 0, b: 0, a: 1 });
  near(parseCssColor("rgba(0, 0, 0, 0.5)").a, 0.5);
  assert.deepEqual(parseCssColor("rgb(0 128 255 / 25%)").a, 0.25);
  assert.deepEqual(parseCssColor("#fff"), { r: 1, g: 1, b: 1, a: 1 });
  near(parseCssColor("#ff000080").a, 128 / 255);
  assert.equal(parseCssColor("transparent").a, 0);
  assert.equal(parseCssColor("").a, 0);
});

test("splitTopLevel ignores commas inside parentheses and quotes", () => {
  assert.deepEqual(splitTopLevel("rgb(1, 2, 3) 10%, rgb(4, 5, 6)"), [
    "rgb(1, 2, 3) 10%",
    "rgb(4, 5, 6)",
  ]);
  assert.deepEqual(
    splitTopLevel('url("a,b.png"), linear-gradient(red, blue)'),
    ['url("a,b.png")', "linear-gradient(red, blue)"],
  );
});

test("parseGradient reads angle, corner and stops from a computed value", () => {
  const g = parseGradient(
    "linear-gradient(135deg, rgb(238, 241, 245) 0%, rgb(212, 218, 227) 100%)",
  );
  assert.equal(g.kind, "linear");
  assert.equal(g.angleDeg, 135);
  assert.equal(g.stops.length, 2);
  assert.equal(g.stops[1].pos, 100);

  const c = parseGradient(
    "linear-gradient(to bottom right, rgb(1, 2, 3), rgb(4, 5, 6))",
  );
  assert.deepEqual(c.corner, { sx: 1, sy: 1 });
  assert.equal(c.stops[0].pos, null);

  assert.equal(
    parseGradient("linear-gradient(rgb(1, 2, 3), rgb(4, 5, 6))").angleDeg,
    180,
  );
  assert.equal(parseGradient("linear-gradient(to top, red, blue)").angleDeg, 0);
  assert.equal(parseGradient("none"), null);
  assert.equal(parseGradient('url("x.png")'), null);
});

test("parseGradient drops a colour-interpolation hint and keeps nested colour functions", () => {
  const g = parseGradient(
    "linear-gradient(to right in oklab, color-mix(in srgb, red 50%, blue) 0%, rgb(0, 0, 0) 100%)",
  );
  assert.equal(g.stops.length, 2);
  assert.equal(g.angleDeg, 90);
});

test("resolveStops fills unpositioned stops evenly and keeps order", () => {
  const stops = parseGradient("linear-gradient(red, lime, blue)").stops;
  const r = resolveStops(stops, 100);
  assert.deepEqual(
    r.map((s) => s.pos),
    [0, 0.5, 1],
  );

  const hard = resolveStops(
    parseGradient("linear-gradient(red 50%, blue 40%)").stops,
    100,
  );
  assert.ok(hard[1].pos >= hard[0].pos);
});

test("a transparent stop borrows its neighbour so the fade does not go dark", () => {
  const stops = resolveStops(
    parseGradient(
      "linear-gradient(to bottom, rgba(0, 0, 0, 0), rgb(255, 0, 0))",
    ).stops,
    100,
  );
  assert.equal(stops[0].color.a, 0);
  assert.equal(stops[0].color.r, 1);
});

test("gradientAxis: 180deg runs top to bottom, 90deg left to right", () => {
  const down = gradientAxis(200, 100, { angleDeg: 180 });
  near(down.x0, 100);
  near(down.y0, 0);
  near(down.x1, 100);
  near(down.y1, 100);
  const right = gradientAxis(200, 100, { angleDeg: 90 });
  near(right.x0, 0);
  near(right.x1, 200);
  near(right.y0, 50);
});

test("gradientAxis: a corner gradient reaches both opposite corners", () => {
  const a = gradientAxis(200, 100, { corner: { sx: 1, sy: 1 } });
  // The 0% colour sits on the top-left corner and the 100% colour on the bottom-right.
  const t0 =
    (0 * (a.x1 - a.x0) +
      0 * (a.y1 - a.y0) -
      (a.x0 * (a.x1 - a.x0) + a.y0 * (a.y1 - a.y0))) /
    a.length ** 2;
  const t1 =
    (200 * (a.x1 - a.x0) +
      100 * (a.y1 - a.y0) -
      (a.x0 * (a.x1 - a.x0) + a.y0 * (a.y1 - a.y0))) /
    a.length ** 2;
  near(t0, 0);
  near(t1, 1);
});

test("resolveRadii handles px, percent and overlap scaling", () => {
  const r = resolveRadii(["12px", "12px", "12px", "12px"], 200, 100);
  assert.deepEqual(r.tl, { x: 12, y: 12 });
  const circle = resolveRadii(["50%", "50%", "50%", "50%"], 40, 40);
  assert.deepEqual(circle.tl, { x: 20, y: 20 });
  const big = resolveRadii(["9999px", "9999px", "9999px", "9999px"], 100, 40);
  assert.ok(big.tl.x + big.tr.x <= 100.0001 && big.tl.y + big.bl.y <= 40.0001);
});

test("insetRadii never goes negative", () => {
  const r = insetRadii(
    resolveRadii(["4px", "4px", "4px", "4px"], 100, 100),
    10,
    10,
    10,
    10,
  );
  assert.deepEqual(r.tl, { x: 0, y: 0 });
});

test("fitImage: cover fills the box and crops, contain fits inside", () => {
  const cover = fitImage(200, 100, 100, 100, "cover");
  assert.equal(cover.h, 100);
  assert.equal(cover.w, 200);
  assert.equal(cover.x, -50);
  const contain = fitImage(200, 100, 100, 100, "contain");
  assert.equal(contain.w, 100);
  assert.equal(contain.h, 50);
  assert.equal(contain.y, 25);
  assert.deepEqual(fitImage(200, 100, 80, 60, "fill"), {
    x: 0,
    y: 0,
    w: 80,
    h: 60,
  });
});

test("page breaks: content that fits stays on one page", () => {
  assert.deepEqual(
    computePageBreaks({ totalHeight: 500, pageHeight: 1000 }),
    [0, 500],
  );
});

test("page breaks: a cut never lands inside a protected band", () => {
  const cuts = computePageBreaks({
    totalHeight: 2500,
    pageHeight: 1000,
    avoid: [{ top: 950, bottom: 1010 }],
  });
  assert.equal(cuts[1], 950);
  for (const cut of cuts.slice(1, -1)) assert.ok(!(cut > 950 && cut < 1010));
  assert.equal(cuts.at(-1), 2500);
});

test("page breaks: a band too tall to keep whole is cut rather than leaving a near-empty page", () => {
  const cuts = computePageBreaks({
    totalHeight: 3000,
    pageHeight: 1000,
    avoid: [{ top: 100, bottom: 1500 }],
  });
  assert.equal(cuts[1], 1000);
});

test("page breaks: always progresses and ends at the total height", () => {
  const avoid = Array.from({ length: 200 }, (_, i) => ({
    top: i * 50,
    bottom: i * 50 + 49,
  }));
  const cuts = computePageBreaks({
    totalHeight: 10000,
    pageHeight: 1000,
    avoid,
  });
  for (let i = 1; i < cuts.length; i++) assert.ok(cuts[i] > cuts[i - 1]);
  assert.equal(cuts.at(-1), 10000);
});

test("page breaks: a small soft band stays whole, a large one may split", () => {
  const small = computePageBreaks({
    totalHeight: 2500,
    pageHeight: 1000,
    avoid: [{ top: 800, bottom: 1100, soft: true }],
  });
  assert.equal(small[1], 800);
  const large = computePageBreaks({
    totalHeight: 2500,
    pageHeight: 1000,
    avoid: [{ top: 300, bottom: 1500, soft: true }],
  });
  assert.equal(large[1], 1000);
});

test("a word wrapped across two lines becomes one fragment per line", () => {
  // "check-out" wrapped after the hyphen: "check-" on the first line, "out" on the next.
  const box = (ch, left, top) => ({
    ch,
    left,
    right: left + 8,
    top,
    bottom: top + 20,
  });
  const chars = [
    ...[..."check-"].map((ch, i) => box(ch, 300 + i * 8, 100)),
    ...[..."out"].map((ch, i) => box(ch, 16 + i * 8, 140)),
  ];
  const frags = splitFragmentsByLine(chars);
  assert.deepEqual(
    frags.map((f) => f.text),
    ["check-", "out"],
  );
  assert.equal(frags[0].left, 300);
  assert.equal(frags[1].left, 16);
  assert.equal(frags[1].top, 140);
});

test("a word on one line stays one fragment", () => {
  const chars = [..."hello"].map((ch, i) => ({
    ch,
    left: i * 8,
    right: i * 8 + 8,
    top: 0,
    bottom: 20,
  }));
  assert.equal(splitFragmentsByLine(chars).length, 1);
});
