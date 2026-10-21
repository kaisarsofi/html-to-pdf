/**
 * content-flow-analyzer.ts
 *
 * The DOM-facing half of the pipeline. Its only job is to walk a real,
 * already-rendered DOM subtree (in the user's own browser tab — not a
 * hidden/headless browser process) and produce a flat list of `Box`
 * objects with REAL measured heights for pagination-engine.js to consume.
 *
 * Two things make this different from the screenshot (html2canvas) or
 * browser-print (Puppeteer/window.print) approaches:
 *
 * 1. It measures actual layout via getBoundingClientRect() / Range rects,
 *    so heights are exact, not guessed or reconstructed from a raster
 *    image.
 * 2. It breaks text-bearing elements down to one Box PER VISUAL LINE
 *    (using the Range API), not one box per paragraph. That is what lets
 *    the pagination engine break a long paragraph between lines cleanly,
 *    instead of either (a) treating the whole paragraph as unsplittable
 *    and leaving a big gap, or (b) letting a screenshot slice cut straight
 *    through the middle of a line of text.
 *
 * Atomicity rules (what never gets split across a page boundary):
 *   - table rows (<tr>)
 *   - list items (<li>)
 *   - images, <figure> (image + caption stay together)
 *   - any element with `data-pdf-break="avoid"` or CSS `break-inside: avoid`
 *   - a single visual line of text (we never cut through a line's ascent/descent)
 */

import { parseCssColor } from "./color.js";
import type { Box } from "./pagination-engine.js";

/** The font and colour facts a run of text carries (sizes in PDF points). */
export type TextStyle = {
  fontSizePt: number;
  bold: boolean;
  italic: boolean;
  color: { r: number; g: number; b: number };
  fontFamily: string;
  fontWeight: string;
};

/** A stretch of same-styled text on one line, positioned relative to that line. */
export type FlowRun = TextStyle & {
  text: string;
  dx: number;
  baselineFromTop: number;
};

export type FlowLine = {
  top: number;
  left: number;
  height: number;
  runs: FlowRun[];
};

export type GroupItem =
  | { type: "text-line"; runs: FlowRun[]; dx: number; dy: number }
  | {
      type: "image";
      src: string;
      dx: number;
      dy: number;
      widthPt: number;
      heightPt: number;
    };

export type FlowContent =
  | { type: "text-line"; runs: FlowRun[] }
  | { type: "image"; src: string; widthPt: number; heightPt: number }
  | {
      type: "group";
      el: Element;
      items: GroupItem[];
      widthPt: number;
      heightPt: number;
    };

export type FlowBox = Box<FlowContent>;

let boxIdCounter = 0;
const nextId = (prefix: string) => `${prefix}-${boxIdCounter++}`;

// CSS px -> PDF points (96px = 1in = 72pt). Converting here, once, means
// every downstream consumer (pagination-engine, pdf-writer) works in a
// single consistent unit and never has to guess which unit a number is in.
const PX_TO_PT = 72 / 96;

function parseColor(value: string): { r: number; g: number; b: number } {
  const { r, g, b } = parseCssColor(value);
  return { r, g, b };
}

export function analyze(root: Element): FlowBox[] {
  boxIdCounter = 0;
  const boxes: FlowBox[] = [];
  walk(root, root, boxes);
  return boxes;
}

function isAtomicByAuthor(el: Element): boolean {
  if ((el as HTMLElement).dataset?.pdfBreak === "avoid") return true;
  const style = getComputedStyle(el);
  if (style.breakInside === "avoid" || style.pageBreakInside === "avoid") {
    return true;
  }
  return false;
}

const INHERENTLY_ATOMIC_TAGS = new Set(["TR", "LI", "IMG", "FIGURE", "HR"]);

/** `root` is the element pagination is relative to; `node` the one being walked. */
function walk(root: Element, node: Element, boxes: FlowBox[]): void {
  for (const child of Array.from(node.children)) {
    if (isSkippable(child)) continue;

    const tag = child.tagName;
    const authorAtomic = isAtomicByAuthor(child);

    if (INHERENTLY_ATOMIC_TAGS.has(tag) || authorAtomic) {
      pushWholeElementBox(root, child, boxes, { atomic: true });
      continue;
    }

    if (isTextLeaf(child)) {
      pushLineBoxes(root, child, boxes);
      continue;
    }

    // A generic container (div, section, etc.) — recurse into its children
    // rather than treating it as one big box, so pagination can break
    // between its children freely.
    walk(root, child, boxes);
  }
}

function isSkippable(el: Element): boolean {
  const style = getComputedStyle(el);
  return style.display === "none" || el.hasAttribute("data-pdf-skip");
}

/** A "text leaf" is an element whose children are only text / inline elements. */
function isTextLeaf(el: Element): boolean {
  if (el.children.length === 0) return el.textContent.trim().length > 0;
  return Array.from(el.children).every((c) =>
    ["SPAN", "A", "B", "I", "EM", "STRONG", "BR", "CODE"].includes(c.tagName),
  );
}

function marginBottomOf(el: Element): number {
  const style = getComputedStyle(el);
  return parseFloat(style.marginBottom) || 0;
}

function textStyleOf(el: Element): TextStyle {
  const style = getComputedStyle(el);
  return {
    fontSizePt: parseFloat(style.fontSize) * PX_TO_PT,
    bold: Number(style.fontWeight) >= 600 || style.fontWeight === "bold",
    italic: style.fontStyle === "italic",
    color: parseColor(style.color),
    // The full computed family list, e.g. `ui-monospace, Menlo, monospace`.
    // The writer decides what it can actually draw with; the analyzer's job
    // is only to report what the browser resolved.
    fontFamily: style.fontFamily,
    fontWeight: style.fontWeight,
  };
}

/**
 * Ascent (top of the font box down to the baseline), in CSS px, for an
 * element's computed font.
 *
 * A line can mix fonts — `<code>` at 13px inside a `<p>` at 15px — and those
 * runs share a BASELINE, not a top edge. Positioning each run by its own top
 * would leave the smaller one floating above the text it sits in. Range rects
 * give us tops and heights but never the baseline, so we get the ascent from
 * canvas text metrics and derive it.
 */
const ascentCache = new Map<string, number>();
let ascentCtx: CanvasRenderingContext2D | null = null;
function ascentOf(el: Element): number {
  const style = getComputedStyle(el);
  const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  if (ascentCache.has(font)) return ascentCache.get(font)!;

  const fontSize = parseFloat(style.fontSize);
  let ascent = fontSize * 0.8; // fallback if the browser withholds metrics
  try {
    const ctx = (ascentCtx ||= document
      .createElement("canvas")
      .getContext("2d"))!;
    ctx.font = font;
    const m = ctx.measureText("Hxg");
    ascent = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent ?? ascent;
  } catch {
    /* keep the fallback */
  }
  ascentCache.set(font, ascent);
  return ascent;
}

/**
 * Flattens an ATOMIC element (a <tr>, <li>, <figure>, or an author-marked
 * card) into the drawable pieces inside it, each positioned RELATIVE to that
 * element's own top-left corner.
 *
 * This is what makes atomicity more than a reservation of blank space: the
 * pagination engine still treats the element as one indivisible box and moves
 * it around as a unit, but the writer now knows what to actually draw inside
 * that box, and where. Offsets are relative rather than absolute precisely
 * because the engine is free to place the box at a different y — or on a
 * different page — than where it sits on screen.
 *
 * Text is extracted per text-leaf (per <td>, per <figcaption>), never across
 * the whole group at once, so two table cells that share a visual line stay
 * two separately-positioned strings instead of collapsing into one run at the
 * left-most x.
 */
function collectGroupItems(el: Element): GroupItem[] {
  const base = el.getBoundingClientRect();
  const items: GroupItem[] = [];

  const pushText = (target: Element) => {
    for (const line of extractLines(target)) {
      items.push({
        type: "text-line",
        runs: line.runs,
        dx: (line.left - base.left) * PX_TO_PT,
        dy: (line.top - base.top) * PX_TO_PT,
      });
    }
  };

  const visit = (node: Element) => {
    for (const child of Array.from(node.children)) {
      if (isSkippable(child)) continue;

      if (child.tagName === "IMG") {
        const r = child.getBoundingClientRect();
        items.push({
          type: "image",
          src: (child as HTMLImageElement).src,
          dx: (r.left - base.left) * PX_TO_PT,
          dy: (r.top - base.top) * PX_TO_PT,
          widthPt: r.width * PX_TO_PT,
          heightPt: r.height * PX_TO_PT,
        });
        continue;
      }

      if (isTextLeaf(child)) {
        pushText(child);
        continue;
      }

      visit(child);
    }
  };

  if (isTextLeaf(el)) pushText(el);
  else visit(el);

  return items;
}

function pushWholeElementBox(
  root: Element,
  el: Element,
  boxes: FlowBox[],
  extra: Partial<FlowBox> = {},
): void {
  const rect = el.getBoundingClientRect();
  const isImage = el.tagName === "IMG";
  boxes.push({
    id: nextId(el.tagName.toLowerCase()),
    height: rect.height * PX_TO_PT,
    marginBottom: marginBottomOf(el) * PX_TO_PT,
    atomic: true,
    keepWithNext: el.tagName.match(/^H[1-6]$/) ? true : false,
    // Only a bare image is safe to shrink to fit a page: it stays legible
    // and its aspect ratio is preserved. Text and mixed groups are not
    // marked scalable — silently changing type size mid-document would be
    // a worse outcome than the page break it avoids.
    scalable: isImage,
    content: isImage
      ? {
          type: "image",
          src: (el as HTMLImageElement).src,
          widthPt: rect.width * PX_TO_PT,
          heightPt: rect.height * PX_TO_PT,
        }
      : {
          type: "group",
          el,
          items: collectGroupItems(el),
          widthPt: rect.width * PX_TO_PT,
          heightPt: rect.height * PX_TO_PT,
        },
    ...extra,
  });
}

/**
 * Splits a text-bearing element into one Box per visual line, using the
 * Range API so the height/position of each line is measured exactly as
 * the browser laid it out — this is the same technique word processors
 * and PDF paginators use to avoid ever slicing through a line's glyphs.
 */
function pushLineBoxes(root: Element, el: Element, boxes: FlowBox[]): void {
  const lines = extractLines(el);

  if (lines.length === 0) {
    // Empty or non-text content that still counts as a leaf — fall back to
    // treating the whole element as one box.
    pushWholeElementBox(root, el, boxes, {
      atomic: false,
      keepWithNext: el.tagName.match(/^H[1-6]$/) ? true : false,
    });
    return;
  }

  lines.forEach((line, idx) => {
    const isLast = idx === lines.length - 1;
    boxes.push({
      id: nextId(`${el.tagName.toLowerCase()}-line`),
      height: line.height * PX_TO_PT,
      marginBottom: isLast ? marginBottomOf(el) * PX_TO_PT : 0,
      // A line of text is atomic (never sliced mid-glyph). The element it
      // belongs to is not atomic as a whole, since we already split it here.
      atomic: true,
      // Headings should stick to whatever follows them.
      keepWithNext: isLast && el.tagName.match(/^H[1-6]$/) ? true : false,
      content: { type: "text-line", runs: line.runs },
    });
  });
}

/**
 * Splits `el` into visual lines, and each line into styled RUNS.
 *
 * Two words belong to the same line when their vertical midpoints fall inside
 * the same band — not when their `rect.top` values match exactly. Exact-top
 * matching looks correct until a line mixes font sizes: a `<code>` span inside
 * a paragraph has a shorter font box and therefore a different top, so it
 * would start a spurious new line and fragment the paragraph around it. Its
 * midpoint, however, still sits inside the line it belongs to.
 *
 * A line then holds one run per contiguous stretch of same-styled words, each
 * with its own x offset, font and baseline. That is what lets a line carry a
 * `<code>` span at its real size and colour instead of flattening the whole
 * line to the parent's style — the fidelity that a "merge everything into one
 * string" fix would have cost.
 *
 * Returns `[{ top, left, height, runs: [{ text, dx, baselineFromTop, ...style }] }]`,
 * all in CSS px except the run styles, which are already in points.
 *
 * This is O(words) Range measurements, which is fine for typical document
 * lengths; for very large documents a caller can batch/virtualize input.
 */
type RawRun = { styleEl: Element; text: string; left: number; top: number };
type RawLine = { top: number; left: number; height: number; runs: RawRun[] };

function extractLines(el: Element): FlowLine[] {
  const doc = el.ownerDocument;
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const words: {
    node: Text;
    start: number;
    end: number;
    text: string;
    styleEl: Element;
  }[] = [];
  let textNode: Node | null;
  while ((textNode = walker.nextNode())) {
    const text = textNode.textContent ?? "";
    const styleEl = textNode.parentElement || el;
    const wordRegex = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = wordRegex.exec(text))) {
      words.push({
        node: textNode as Text,
        start: m.index,
        end: m.index + m[0].length,
        text: m[0],
        styleEl,
      });
    }
  }

  const range = doc.createRange();
  const raw: RawLine[] = [];

  for (const w of words) {
    range.setStart(w.node, w.start);
    range.setEnd(w.node, w.end);
    const rect = range.getBoundingClientRect();
    if (rect.height === 0 && rect.width === 0) continue;

    const midY = rect.top + rect.height / 2;
    let line: RawLine | undefined = raw[raw.length - 1];

    // Same line if this word's middle sits within the band the line occupies.
    if (!line || midY < line.top || midY > line.top + line.height) {
      line = { top: rect.top, left: rect.left, height: rect.height, runs: [] };
      raw.push(line);
    } else {
      const bottom = Math.max(line.top + line.height, rect.bottom);
      line.top = Math.min(line.top, rect.top);
      line.height = bottom - line.top;
      line.left = Math.min(line.left, rect.left);
    }

    const lastRun = line.runs[line.runs.length - 1];
    if (lastRun && lastRun.styleEl === w.styleEl) {
      lastRun.text += " " + w.text;
    } else {
      line.runs.push({
        styleEl: w.styleEl,
        text: w.text,
        left: rect.left,
        top: rect.top,
      });
    }
  }

  // Resolve each run's style now that its line's box is final.
  //
  // The baseline is computed ONCE per line, not once per run. CSS puts every
  // run on a line on the same baseline (`vertical-align: baseline`), so a
  // per-run estimate cannot be more accurate — it can only scatter the error
  // in each font's reported metrics across the line, which shows up as runs
  // sitting a fraction of a point above or below their neighbours. We take the
  // estimate from the run with the largest font, since that run's metrics are
  // what set the height of the line box in the first place.
  const lines: FlowLine[] = raw.map((line) => {
    const dominant = line.runs.reduce((a, b) =>
      parseFloat(getComputedStyle(b.styleEl).fontSize) >
      parseFloat(getComputedStyle(a.styleEl).fontSize)
        ? b
        : a,
    );
    const baselineFromTop =
      (dominant.top + ascentOf(dominant.styleEl) - line.top) * PX_TO_PT;

    return {
      top: line.top,
      left: line.left,
      height: line.height,
      runs: line.runs.map((run) => ({
        text: run.text,
        dx: (run.left - line.left) * PX_TO_PT,
        baselineFromTop,
        ...textStyleOf(run.styleEl),
      })),
    };
  });

  return lines;
}
