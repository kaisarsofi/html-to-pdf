/**
 * The bundled Unicode fallback font (Noto Sans, SIL Open Font License; see
 * NOTICE). It covers Latin, Latin Extended (including the rupee sign), Greek, Cyrillic,
 * Devanagari and Vietnamese. It is imported lazily and only when some character
 * in the document cannot be drawn by the page's own fonts, so a document that
 * never needs it never loads it.
 */

import type { FontSource } from "../core/font-registry.js";
import { fontModules } from "./data/manifest.js";

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const NOTO_SUBSETS = [
  "latin",
  "latin-ext",
  "greek",
  "cyrillic",
  "devanagari",
  "vietnamese",
] as const;
const NOTO_WEIGHTS = [400, 700] as const;
const INTER_WEIGHTS = [300, 400, 500, 600, 700] as const;
const INTER_EXT_WEIGHTS = [400, 700] as const;

async function load(name: string): Promise<Uint8Array> {
  const loader = fontModules[name];
  if (!loader) throw new Error(`bundled font "${name}" is missing`);
  return base64ToBytes(await loader());
}

export async function loadBundledFallbackFonts(): Promise<FontSource[]> {
  const faces = NOTO_SUBSETS.flatMap((subset) =>
    NOTO_WEIGHTS.map((weight) => ({ subset, weight })),
  );
  const bytes = await Promise.all(
    faces.map((f) => load(`noto-sans-${f.subset}-${f.weight}`)),
  );
  return faces.map((f, i) => ({
    family: "Noto Sans",
    weight: f.weight,
    bytes: bytes[i]!,
  }));
}

/**
 * Inter (SIL Open Font License; see NOTICE), one static file per weight, so each
 * weight is drawn exactly. Pages that load Inter through `next/font` or Google Fonts only offer a
 * variable WOFF2 file, which cannot be embedded, so this is used for them. `fallbackFonts` carries
 * the rupee sign and other Latin Extended characters. Imported lazily, only when the page uses Inter.
 */
export async function loadBundledInter(): Promise<{
  fonts: FontSource[];
  fallbackFonts: FontSource[];
}> {
  const [latin, ext] = await Promise.all([
    Promise.all(INTER_WEIGHTS.map((w) => load(`inter-latin-${w}`))),
    Promise.all(INTER_EXT_WEIGHTS.map((w) => load(`inter-latin-ext-${w}`))),
  ]);
  return {
    fonts: latin.map((bytes, i) => ({
      family: "Inter",
      weight: INTER_WEIGHTS[i]!,
      bytes,
    })),
    fallbackFonts: ext.map((bytes, i) => ({
      family: "Inter",
      weight: INTER_EXT_WEIGHTS[i]!,
      bytes,
    })),
  };
}
