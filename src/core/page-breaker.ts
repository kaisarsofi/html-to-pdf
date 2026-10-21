/**
 * page-breaker.ts
 *
 * For the layout-preserving mode. The page is NOT re-flowed: every element keeps
 * the position it has on screen, and the document is simply cut into page-sized
 * slices. All the intelligence is in choosing where to cut: never through a line
 * of text, an image, or a block marked as unbreakable. Pure and DOM-free.
 */

export type AvoidBand = { top: number; bottom: number; soft?: boolean };

export type PageBreakInput = {
  totalHeight: number;
  pageHeight: number;
  avoid?: AvoidBand[];
  minFill?: number;
  softMaxRatio?: number;
};

/**
 * Heights are in the same unit (CSS px). `avoid` are vertical bands a cut
 *   must not land inside. `minFill` is the least fraction of a page a slice may
 *   be shortened to in order to dodge a band; past it, the band is cut anyway
 *   (a band taller than most of a page cannot be kept whole). A `soft` band (a
 *   card, say) is only protected while it is at most `softMaxRatio` of a page
 *   tall (default 0.35): a small card should stay whole, a huge section may split.
 * Returns cut positions including 0 and totalHeight; page i covers [cuts[i], cuts[i+1]).
 */
export function computePageBreaks({
  totalHeight,
  pageHeight,
  avoid = [],
  minFill = 0.5,
  softMaxRatio = 0.35,
}: PageBreakInput): number[] {
  if (!(pageHeight > 0))
    throw new Error("page-breaker: pageHeight must be positive.");
  const cuts = [0];
  const EPS = 0.5;
  const usable = avoid.filter((a) => {
    const h = a.bottom - a.top;
    return (
      h > 0 &&
      (a.soft ? h <= pageHeight * softMaxRatio : h < pageHeight * minFill * 2)
    );
  });
  let start = 0;

  while (totalHeight - start > pageHeight + EPS) {
    const target = start + pageHeight;
    let cut = target;

    for (let guard = 0; guard < 1000; guard++) {
      let moved: number | null = null;
      for (const band of usable) {
        if (band.top < cut - EPS && band.bottom > cut + EPS) {
          moved = moved === null ? band.top : Math.min(moved, band.top);
        }
      }
      if (moved === null) break;
      cut = moved;
      if (cut <= start + pageHeight * minFill) {
        cut = target;
        break;
      }
    }

    if (cut <= start + EPS) cut = target; // always make progress
    cuts.push(cut);
    start = cut;
  }

  cuts.push(Math.max(totalHeight, start));
  return cuts;
}
