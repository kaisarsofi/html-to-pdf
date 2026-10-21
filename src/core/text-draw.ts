/**
 * text-draw.ts
 *
 * Draws one styled run of text onto a PDF page. Shared by both writers.
 *
 * It never throws on a character the run's font cannot draw: such a character
 * goes to a face that can (the family's other-range faces, then the fallbacks),
 * and only if none can does it become '?' with a warning.
 */

import { rgb, setCharacterSpacing, type PDFFont, type PDFPage } from "pdf-lib";
import type { FontRegistry, RunStyle } from "./font-registry.js";

export type DrawRun = RunStyle & {
  text: string;
  fontSizePt: number;
  color: { r: number; g: number; b: number };
};

export type DrawExtras = {
  opacity?: number;
  letterSpacingPt?: number;
  /** The width the browser gave this text; letter spacing is adjusted so the text fills it. */
  targetWidthPt?: number;
};

/**
 * @param x left edge, PDF points
 * @param y baseline, PDF points (origin bottom-left)
 */
export function drawRunText(
  page: PDFPage,
  fonts: FontRegistry,
  run: DrawRun,
  x: number,
  y: number,
  extras: DrawExtras = {},
): void {
  const main = fonts.resolve(run);
  const color = rgb(run.color.r, run.color.g, run.color.b);
  let spacing = extras.letterSpacingPt || 0;

  // Group consecutive characters by the face that draws them.
  const parts: { font: PDFFont; text: string }[] = [];
  const push = (font: PDFFont, ch: string) => {
    const last = parts[parts.length - 1];
    if (last && last.font === font) last.text += ch;
    else parts.push({ font, text: ch });
  };
  for (const ch of run.text) {
    const cp = ch.codePointAt(0)!;
    if (fonts.canDraw(main, cp)) {
      push(main, ch);
      continue;
    }
    const other = fonts.fallbackFor(run, cp);
    if (other) {
      push(other, ch);
    } else {
      fonts.warnings.push(
        `html-to-pdf: no font can draw "${ch}" (U+${cp.toString(16).toUpperCase()}); drew "?" instead.`,
      );
      push(main, "?");
    }
  }

  // Width fitting. The PDF font is rarely the page's own font, so the same word
  // comes out a little wider or narrower than on screen. When the caller knows
  // the width the browser gave this text, spread the difference across its
  // letters so every word still fills exactly its on-screen box. Skipped when
  // the difference is large (a different script, say), where it would distort.
  const chars = parts.reduce((n, part) => n + [...part.text].length, 0);
  if (extras.targetWidthPt && chars > 1) {
    const natural =
      parts.reduce(
        (w, part) => w + part.font.widthOfTextAtSize(part.text, run.fontSizePt),
        0,
      ) +
      spacing * chars;
    const ratio = natural / extras.targetWidthPt;
    if (
      ratio > 0.7 &&
      ratio < 1.4 &&
      Math.abs(natural - extras.targetWidthPt) > 0.2
    ) {
      spacing += (extras.targetWidthPt - natural) / chars;
    }
  }

  if (spacing) page.pushOperators(setCharacterSpacing(spacing));
  for (const { font, text } of parts) {
    page.drawText(text, {
      x,
      y,
      size: run.fontSizePt,
      font,
      color,
      ...(extras.opacity !== undefined && extras.opacity < 1
        ? { opacity: extras.opacity }
        : {}),
    });
    x +=
      font.widthOfTextAtSize(text, run.fontSizePt) + spacing * [...text].length;
  }
  if (spacing) page.pushOperators(setCharacterSpacing(0));
}
