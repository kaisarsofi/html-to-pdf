import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSvgPath } from "../dist/core/svg-path.js";

const near = (a, b, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test("absolute and relative lines, horizontals and verticals", () => {
  const s = parseSvgPath("M10 10 L20 10 h5 v5 l-5 0 z");
  assert.deepEqual(
    s.map((x) => x.op),
    ["M", "L", "L", "L", "L", "Z"],
  );
  assert.deepEqual(s[2], { op: "L", x: 25, y: 10 });
  assert.deepEqual(s[3], { op: "L", x: 25, y: 15 });
  assert.deepEqual(s[4], { op: "L", x: 20, y: 15 });
});

test("a moveto with extra pairs means lineto; numbers may be packed", () => {
  const s = parseSvgPath("M1,2 3,4-5-6");
  assert.deepEqual(
    s.map((x) => x.op),
    ["M", "L", "L"],
  );
  assert.deepEqual(s[2], { op: "L", x: -5, y: -6 });
});

test("cubic curves, smooth cubics and quadratics become cubics", () => {
  const s = parseSvgPath("M0 0 C0 10 10 10 10 0 S20 -10 20 0 Q25 5 30 0 T40 0");
  assert.ok(s.slice(1).every((x) => x.op === "C"));
  // S reflects the previous second control point about the current point.
  assert.equal(s[2].x1, 10 + (10 - 10)); // reflect (10,10) about (10,0) -> (10,-10)
  assert.equal(s[2].y1, -10);
});

test("an arc ends exactly at its endpoint and stays on the circle", () => {
  const s = parseSvgPath("M10 0 A10 10 0 0 1 0 10");
  const last = s[s.length - 1];
  assert.equal(last.x, 0);
  assert.equal(last.y, 10);
  for (const seg of s.slice(1)) {
    near(Math.hypot(seg.x, seg.y), 10, 1e-6);
  }
});

test("a full circle drawn as two arcs is closed and circular", () => {
  const s = parseSvgPath("M12 2 a10 10 0 1 0 0 20 a10 10 0 1 0 0 -20 z");
  assert.ok(s.length > 4);
  const last = s[s.length - 2];
  near(last.x, 12);
  near(last.y, 2);
});

test("arc flags can be packed without separators", () => {
  const s = parseSvgPath("M0 0a1 1 0 011 1");
  assert.equal(s[s.length - 1].x, 1);
  assert.equal(s[s.length - 1].y, 1);
});

test("a zero-radius arc is a straight line", () => {
  assert.deepEqual(parseSvgPath("M0 0 A0 0 0 0 1 5 5")[1], {
    op: "L",
    x: 5,
    y: 5,
  });
});

test("malformed path data throws, so callers can fall back to a raster", () => {
  assert.throws(() => parseSvgPath("L 10"));
  assert.throws(() => parseSvgPath("M 1 2 X 3"));
});
