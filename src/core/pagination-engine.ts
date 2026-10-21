/**
 * pagination-engine.ts
 *
 * This is the piece that actually fixes the "big empty gap, then next page"
 * problem. It is deliberately environment-agnostic: it knows nothing about
 * the DOM, HTML, or PDF drawing. It only knows about a flat list of
 * pre-measured "boxes" (each with a real pixel/point height, already
 * computed by content-flow-analyzer.js) and decides which page each box
 * lands on.
 *
 * Why this kills empty space:
 * A page is only closed when the NEXT box genuinely does not fit in the
 * remaining space. We never cut at a fixed height and we never guess —
 * every decision is "does this box's real measured height fit in what's
 * left on this page?" So the worst-case leftover white space on any page
 * is strictly less than the height of the next box, not an arbitrary gap.
 *
 * Why this kills ugly mid-content cuts:
 * Boxes marked `atomic: true` are never split across pages — if an atomic
 * box doesn't fit, the WHOLE box moves to the next page. It is the caller's
 * job (content-flow-analyzer) to have already broken large content (e.g. a
 * paragraph) down into safely-splittable sub-boxes (e.g. one box per visual
 * line of text) *before* handing it to this engine, so nothing is ever cut
 * through the middle of a word, an image, or a table row.

 */

/** One pre-measured block of content, in PDF points (or any unit matching `pageHeight`). */
export type Box<C = unknown> = {
  /** stable id for debugging/traceability */
  id: string;
  /** measured height */
  height: number;
  /** space to reserve after this box before the next one */
  marginBottom?: number;
  /** if true, this box is never split across a page boundary */
  atomic?: boolean;
  /** if true, avoid leaving this box alone at the bottom of a page with nothing following it (e.g. a heading) */
  keepWithNext?: boolean;
  /** if true, this box may be drawn smaller than measured to fit a page (images only, never text) */
  scalable?: boolean;
  /** opaque payload the caller cares about (text run, image ref, table row, etc.); untouched by this engine */
  content?: C;
};

export type PlacedBox<C = unknown> = {
  box: Box<C>;
  /** 0-indexed page number */
  page: number;
  /** offset from the top of the content area on that page */
  y: number;
  /** 1 unless the box was shrunk to fit; the renderer must multiply the box's drawn size by this */
  scale: number;
  /** the height this box actually occupies on the page (box.height * scale) */
  height: number;
};

export type PaginationOptions = {
  /** full page height */
  pageHeight: number;
  marginTop?: number;
  marginBottom?: number;
  /** what to do with a `scalable` box taller than a whole page. Default 'scale'. */
  oversized?: "scale" | "overflow";
  /** in 'scale' mode, the smallest fraction of a full page a shrunk box may be reduced to in order to fill the space left on the current page. Default 0.4. */
  minFill?: number;
};

export function paginate<C = unknown>(
  boxes: Box<C>[],
  options: PaginationOptions,
): { pages: PlacedBox<C>[][]; warnings: string[] } {
  const marginTop = options.marginTop ?? 0;
  const marginBottom = options.marginBottom ?? 0;
  const oversizedMode = options.oversized ?? "scale";
  const minFill = options.minFill ?? 0.4;
  const availableHeight = options.pageHeight - marginTop - marginBottom;

  if (availableHeight <= 0) {
    throw new Error(
      `pagination-engine: pageHeight (${options.pageHeight}) minus margins leaves no usable space.`,
    );
  }

  const pages: PlacedBox<C>[][] = [[]];
  const warnings: string[] = [];
  let cursorY = 0; // used height on the current page

  const startNewPage = () => {
    pages.push([]);
    cursorY = 0;
  };

  const place = (box: Box<C>, scale = 1) => {
    pages[pages.length - 1]!.push({
      box,
      page: pages.length - 1,
      y: cursorY,
      scale,
      height: box.height * scale,
    });
    cursorY += box.height * scale + (box.marginBottom ?? 0);
  };

  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i]!;

    // A box taller than an entire page cannot be placed at its measured
    // size, and no amount of re-deciding page breaks changes that. There
    // are only two honest answers, and which one is right depends on the
    // content, so the caller picks:
    //
    //   'scale'    — shrink it to fit. Only valid for boxes the caller
    //                marked `scalable` (images), because shrinking text
    //                would silently change its size mid-document.
    //   'overflow' — place it at full size and let it run past the page
    //                bottom, with a warning. The old behaviour; correct
    //                when the caller would rather see the breakage than
    //                have the library quietly resize their content.
    //
    // In 'scale' mode we prefer to fill the space left on the CURRENT page
    // rather than starting a fresh one — otherwise the page before an
    // oversized image is left almost entirely blank, which is exactly the
    // unexplained white space this engine exists to avoid. The floor is
    // `minFill` (default 0.4): we will not shrink a box below that fraction
    // of a full page just to dodge a page break, because past that point the
    // reader loses more from the shrinking than from the gap. Above it, a
    // still-large image beats half a blank page.
    if (box.height > availableHeight) {
      const remaining = availableHeight - cursorY;

      if (oversizedMode === "scale" && box.scalable) {
        const fitsRemaining = remaining >= availableHeight * minFill;
        if (!fitsRemaining && cursorY > 0) startNewPage();
        const target = fitsRemaining ? remaining : availableHeight;
        const scale = target / box.height;
        warnings.push(
          `Box "${box.id}" (height ${box.height}) exceeds the usable page height ` +
            `(${availableHeight}); scaled to ${(scale * 100).toFixed(1)}% to fit. ` +
            `Pass oversized: 'overflow' to keep it at full size instead.`,
        );
        place(box, scale);
        continue;
      }

      if (cursorY > 0) startNewPage();
      warnings.push(
        `Box "${box.id}" (height ${box.height}) exceeds the usable page height ` +
          `(${availableHeight}) on its own and will overflow the page bottom. ` +
          `Consider splitting it into smaller sub-boxes upstream` +
          (box.scalable ? `, or use oversized: 'scale'.` : `.`),
      );
      place(box);
      continue;
    }

    const fitsOnCurrentPage = cursorY + box.height <= availableHeight;

    if (!fitsOnCurrentPage) {
      // Don't start a new page for an empty page (avoid infinite loop /
      // pointless blank pages) — but this branch is normally only reached
      // when cursorY > 0, since we already special-cased "taller than a
      // whole page" above.
      if (cursorY > 0) startNewPage();
    }

    // keepWithNext: if this box would end up as the very last thing on a
    // page, and there IS a next box, and that next box would immediately
    // overflow to the following page anyway, pull this box down too so a
    // heading doesn't get orphaned above an empty rest-of-page.
    if (box.keepWithNext && i + 1 < boxes.length) {
      const next = boxes[i + 1]!;
      const wouldBeLastOnPage =
        cursorY + box.height + next.height > availableHeight;
      if (wouldBeLastOnPage && cursorY > 0) {
        startNewPage();
      }
    }

    place(box);
  }

  return { pages, warnings };
}
