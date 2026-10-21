import { test } from "node:test";
import assert from "node:assert/strict";
import { paginate } from "../dist/core/pagination-engine.js";

function makeBoxes(heights, opts = {}) {
  return heights.map((h, i) => ({
    id: `box-${i}`,
    height: h,
    marginBottom: opts.marginBottom ?? 0,
    atomic: opts.atomic ?? false,
  }));
}

test("never leaves more empty space than the height of the next box", () => {
  // Page usable height 100. Boxes sized so a naive "fixed height slice"
  // approach would leave a big gap; this engine should instead pack pages
  // tightly and only roll over when something truly doesn't fit.
  const boxes = makeBoxes([40, 40, 40, 10, 10]);
  const { pages } = paginate(boxes, {
    pageHeight: 100,
    marginTop: 0,
    marginBottom: 0,
  });

  for (const page of pages) {
    const used = page.reduce(
      (sum, p) => sum + p.box.height + (p.box.marginBottom ?? 0),
      0,
    );
    const leftover = 100 - used;
    // leftover must be less than the height of whatever box would have
    // come next (if there was one) -- i.e. we didn't leave slack we didn't
    // have to.
    assert.ok(
      leftover < 40 + 1e-9,
      `leftover ${leftover} should be small, page had ${page.length} boxes`,
    );
  }
});

test("atomic boxes are never split across pages", () => {
  const boxes = [
    { id: "a", height: 30, atomic: true },
    { id: "b", height: 80, atomic: true }, // won't fit after 'a' in a 100pt page
    { id: "c", height: 10, atomic: true },
  ];
  const { pages } = paginate(boxes, { pageHeight: 100 });

  // 'b' must appear whole, on exactly one page, never fragmented.
  const flatIds = pages.flat().map((p) => p.box.id);
  assert.deepEqual(flatIds, ["a", "b", "c"]);
  assert.equal(
    pages[0].some((p) => p.box.id === "b"),
    false,
    "b should not fit on page 0 with a",
  );
  assert.equal(pages[1][0].box.id, "b");
});

test("a box taller than a whole page is still placed (with a warning), not silently dropped", () => {
  const boxes = [{ id: "huge", height: 500, atomic: true }];
  const { pages, warnings } = paginate(boxes, { pageHeight: 100 });

  assert.equal(pages.flat().length, 1);
  assert.ok(warnings.length > 0);
});

test("keepWithNext avoids orphaning a heading alone at the bottom of a page", () => {
  const boxes = [
    { id: "filler", height: 90 },
    { id: "heading", height: 8, keepWithNext: true },
    { id: "paragraph-line-1", height: 12 },
  ];
  const { pages } = paginate(boxes, { pageHeight: 100 });

  const headingPage = pages.findIndex((p) =>
    p.some((b) => b.box.id === "heading"),
  );
  const paraPage = pages.findIndex((p) =>
    p.some((b) => b.box.id === "paragraph-line-1"),
  );
  assert.equal(
    headingPage,
    paraPage,
    "heading and the text that follows it should land on the same page",
  );
});

test("empty pages are never created", () => {
  const boxes = makeBoxes([50, 50, 50]);
  const { pages } = paginate(boxes, { pageHeight: 100 });
  for (const page of pages) {
    assert.ok(page.length > 0, "no page should be empty");
  }
});

test("an oversized scalable box is shrunk to fill the current page, not banished to a blank one", () => {
  // 20pt of content, then an image measured at 500pt on a 100pt page. The
  // old behaviour pushed the image to its own page and left 80% of page 0
  // empty. It should instead fill the 80pt that remain.
  const boxes = [
    { id: "intro", height: 20 },
    { id: "huge-image", height: 500, atomic: true, scalable: true },
  ];
  const { pages, warnings } = paginate(boxes, { pageHeight: 100 });

  assert.equal(pages.length, 1, "both boxes should share one page");
  const placed = pages[0][1];
  assert.equal(placed.box.id, "huge-image");
  assert.equal(
    placed.height,
    80,
    "image should be scaled to exactly the remaining space",
  );
  assert.ok(placed.scale < 1);
  assert.ok(warnings.some((w) => w.includes("scaled")));
});

test("scaling never shrinks a box below minFill of a page just to avoid a page break", () => {
  // Only 10pt left on the page — filling it would shrink the image to 10%
  // of a page, which is worse for the reader than the page break. It should
  // take a fresh page and scale to the full usable height instead.
  const boxes = [
    { id: "filler", height: 90 },
    { id: "huge-image", height: 500, atomic: true, scalable: true },
  ];
  const { pages } = paginate(boxes, { pageHeight: 100, minFill: 0.6 });

  assert.equal(pages.length, 2);
  assert.equal(pages[1][0].height, 100, "image should fill the fresh page");
});

test("non-scalable oversized content still overflows with a warning rather than being resized", () => {
  // Text must never be silently resized: a 500pt block of text on a 100pt
  // page keeps its size and reports the problem.
  const boxes = [{ id: "huge-text", height: 500, atomic: true }];
  const { pages, warnings } = paginate(boxes, { pageHeight: 100 });

  assert.equal(pages[0][0].scale, 1);
  assert.equal(pages[0][0].height, 500);
  assert.ok(warnings.some((w) => w.includes("overflow")));
});

test("oversized: 'overflow' opts out of scaling entirely", () => {
  const boxes = [
    { id: "huge-image", height: 500, atomic: true, scalable: true },
  ];
  const { pages, warnings } = paginate(boxes, {
    pageHeight: 100,
    oversized: "overflow",
  });

  assert.equal(pages[0][0].scale, 1);
  assert.ok(warnings.some((w) => w.includes("oversized: 'scale'")));
});
