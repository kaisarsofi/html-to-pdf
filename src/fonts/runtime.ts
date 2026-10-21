/**
 * Wires a font registry to everything it needs so no caller has to: fontkit is
 * loaded on demand (only when a custom font is actually embedded), and the
 * bundled Unicode fallback is offered for characters nothing else can draw.
 */

import type { PDFDocument } from "pdf-lib";
import {
  createFontRegistry,
  type FontRegistry,
  type FontSource,
} from "../core/font-registry.js";
import { loadBundledFallbackFonts } from "./bundled.js";

export type FontSetup = {
  /** Fonts to embed. Defaults to the ones the page already declares. */
  fonts?: FontSource[];
  /** Used, in order, for characters the page's fonts cannot draw. A bundled Unicode font follows these. */
  fallbackFonts?: FontSource[];
  /** The pdf-lib fontkit module. Loaded automatically when omitted. */
  fontkit?: unknown;
  /** Turn the bundled Unicode fallback off. */
  bundledFallback?: boolean;
};

export function createRegistry(
  pdfDoc: PDFDocument,
  setup: FontSetup = {},
): FontRegistry {
  let registered = false;
  return createFontRegistry(pdfDoc, {
    fonts: setup.fonts ?? [],
    fallbackFonts: setup.fallbackFonts ?? [],
    ensureFontkit: async () => {
      if (registered) return;
      registered = true;
      const mod = setup.fontkit ?? (await import("@pdf-lib/fontkit"));
      const fontkit = (mod as { default?: unknown }).default ?? mod;
      pdfDoc.registerFontkit(
        fontkit as Parameters<PDFDocument["registerFontkit"]>[0],
      );
    },
    ...(setup.bundledFallback === false
      ? {}
      : { loadBundledFallback: loadBundledFallbackFonts }),
  });
}
