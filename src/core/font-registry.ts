/**
 * font-registry.ts
 *
 * Decides which PDF font actually draws each run of text, and what draws the
 * characters that font cannot.
 *
 * Three levels, each only used when the one before cannot do the job:
 *
 * 1. **The standard 14.** Every PDF reader has Helvetica, Times and Courier
 *    built in. Mapping a run's computed `font-family` onto the right one costs
 *    nothing: no downloads, no embedded bytes.
 *
 * 2. **The page's own fonts.** `discoverWebFonts()` reads the `@font-face` rules
 *    the page already declared (static TTF, OTF and WOFF files) and embeds them,
 *    subsetted to the glyphs actually used. WOFF2 and variable fonts cannot be
 *    embedded; the caller is told once and can pass static files instead. A face whose
 *    `unicode-range` does not cover basic Latin (next/font splits Latin-ext and
 *    Cyrillic into their own files) is kept as that family's fallback, used for
 *    exactly the characters the main face lacks.
 *
 * 3. **Fallback fonts**, for characters no face of the family can draw (the rupee
 *    sign is the usual one: the standard 14 stop at WinAnsi). The caller's own
 *    `fallbackFonts` come first, then a bundled Unicode font that is loaded only
 *    if some character really needs it.
 *
 * Nothing here throws for a missing font or glyph. A document that cannot get
 * its exact face still gets a readable PDF, with a warning.
 */

import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";

export type FontSource = {
  /** CSS family name to match, e.g. 'Inter'. */
  family: string;
  /** 400, 'bold', or a range like "100 900" for a variable font. */
  weight?: number | string;
  style?: "normal" | "italic" | string;
  /** Where to fetch the font file (ttf, otf or woff; not woff2). */
  url?: string;
  /** The font file itself, if already in hand. */
  bytes?: ArrayBuffer | Uint8Array;
  /** The `unicode-range` the face was declared with, if any. */
  unicodeRange?: string;
};

/** The fields of a styled text run the registry reads. */
export type RunStyle = {
  fontFamily: string;
  fontWeight?: string | number;
  bold: boolean;
  italic: boolean;
};

type FontkitFontLike = {
  glyphForCodePoint(codePoint: number): { id: number };
};

type Entry = {
  src: FontSource;
  key: string;
  min: number;
  max: number;
  italic: boolean;
  /** true when the face declares a unicode-range that does not include basic Latin */
  extra: boolean;
};

export type FontRegistryOptions = {
  /** Explicit sources; the page's own fonts when discovered. */
  fonts?: FontSource[];
  /** Tried, in order, for characters no face of the run's family can draw. */
  fallbackFonts?: FontSource[];
  /** Loads the bundled Unicode font; called at most once, only if a character needs it. */
  loadBundledFallback?: () => Promise<FontSource[]>;
  /** Makes embedding custom fonts possible (registers fontkit); called before the first embed. */
  ensureFontkit?: () => Promise<void>;
};

const STANDARD = {
  sans: {
    regular: StandardFonts.Helvetica,
    bold: StandardFonts.HelveticaBold,
    italic: StandardFonts.HelveticaOblique,
    boldItalic: StandardFonts.HelveticaBoldOblique,
  },
  serif: {
    regular: StandardFonts.TimesRoman,
    bold: StandardFonts.TimesRomanBold,
    italic: StandardFonts.TimesRomanItalic,
    boldItalic: StandardFonts.TimesRomanBoldItalic,
  },
  mono: {
    regular: StandardFonts.Courier,
    bold: StandardFonts.CourierBold,
    italic: StandardFonts.CourierOblique,
    boldItalic: StandardFonts.CourierBoldOblique,
  },
} as const;

type StandardKind = keyof typeof STANDARD;

/**
 * Maps a computed `font-family` list onto one of the three generic families
 * the standard 14 can represent.
 *
 * Order matters: `sans-serif` contains the substring `serif`, so the sans
 * test has to run first or every sans-serif document comes out in Times.
 */
export function classifyFamily(
  familyList: string | null | undefined,
): StandardKind {
  const f = String(familyList || "").toLowerCase();
  if (/mono|courier|menlo|consolas|monaco|inconsolata|source code/.test(f))
    return "mono";
  if (
    /sans-serif|system-ui|helvetica|arial|inter|roboto|segoe|verdana|tahoma/.test(
      f,
    )
  )
    return "sans";
  if (/serif|times|georgia|garamond|cambria|palatino|book antiqua/.test(f))
    return "serif";
  return "sans";
}

const styleKey = (bold: boolean, italic: boolean) =>
  bold && italic ? "boldItalic" : bold ? "bold" : italic ? "italic" : "regular";

/** First family name in a computed list, unquoted: `"Inter", sans-serif` -> `inter`. */
function primaryFamily(familyList: string): string {
  const first = String(familyList || "").split(",")[0] || "";
  return first
    .trim()
    .replace(/^["']|["']$/g, "")
    .toLowerCase();
}

/** CSS weight -> {min, max}. `bold` is 700; a range like "100 900" is a variable font. */
function weightRange(w: unknown): { min: number; max: number } {
  const text = String(w ?? "")
    .trim()
    .toLowerCase();
  if (text === "bold") return { min: 700, max: 700 };
  if (text === "normal" || text === "") return { min: 400, max: 400 };
  const nums = text.split(/\s+/).map(Number).filter(Number.isFinite);
  if (nums.length === 0) return { min: 400, max: 400 };
  return { min: Math.min(...nums), max: Math.max(...nums) };
}

const weightNumber = (w: unknown): number => {
  const { min, max } = weightRange(w);
  return min === max ? min : 400;
};

const isBoldWeight = (w: unknown): boolean => weightNumber(w) >= 600;

/** Whether a CSS `unicode-range` descriptor includes a code point. No range means every code point. */
export function unicodeRangeCovers(
  range: string | undefined,
  codePoint: number,
): boolean {
  if (!range) return true;
  for (const part of range.split(",")) {
    const m = part.trim().match(/^U\+([0-9A-F?]+)(?:-([0-9A-F]+))?$/i);
    if (!m) continue;
    if (m[1]!.includes("?")) {
      const lo = parseInt(m[1]!.replace(/\?/g, "0"), 16);
      const hi = parseInt(m[1]!.replace(/\?/g, "F"), 16);
      if (codePoint >= lo && codePoint <= hi) return true;
    } else {
      const lo = parseInt(m[1]!, 16);
      const hi = m[2] ? parseInt(m[2], 16) : lo;
      if (codePoint >= lo && codePoint <= hi) return true;
    }
  }
  return false;
}

/**
 * Reads the `@font-face` rules the page already declared and turns them into
 * font sources: the page has already told the browser where its fonts live, so
 * ask the page rather than making the caller repeat itself.
 *
 * Cross-origin stylesheets throw on `.cssRules` access; those are skipped, and
 * a caller can always pass the font explicitly instead.
 */
export function discoverWebFonts(doc: Document = document): FontSource[] {
  const found: FontSource[] = [];
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin stylesheet: not readable, not an error
    }
    for (const rule of Array.from(rules)) {
      if (rule.type !== CSSRule.FONT_FACE_RULE) continue;
      const style = (rule as CSSFontFaceRule).style;
      const family = style
        .getPropertyValue("font-family")
        .replace(/^["']|["']$/g, "");
      const url = matchFontUrl(style.getPropertyValue("src"));
      if (!family || !url) continue;
      const range = style.getPropertyValue("unicode-range").trim();
      found.push({
        family,
        weight: style.getPropertyValue("font-weight") || 400,
        style: style.getPropertyValue("font-style") || "normal",
        url: new URL(url, (sheet as CSSStyleSheet).href || doc.baseURI).href,
        ...(range ? { unicodeRange: range } : {}),
      });
    }
  }
  return found;
}

/**
 * TTF/OTF, then WOFF. WOFF2 is deliberately not matched: pdf-lib's font subsetter
 * cannot read it (it fails asynchronously, which would hang the export), and most
 * web fonts that are WOFF2-only (next/font, Google Fonts) are variable fonts too.
 * See `fontWarnings` for what a caller is told.
 */
function matchFontUrl(src: string): string | null {
  const candidates = [
    ...String(src || "").matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g),
  ].map((m) => m[1]!);
  return (
    candidates.find((u) => /\.(ttf|otf)(\?|#|$)/i.test(u)) ??
    candidates.find((u) => /\.woff(\?|#|$)/i.test(u)) ??
    null
  );
}

/**
 * What the page declares that cannot be embedded, so the caller can be told once
 * how to get exact text instead of a silent substitution.
 */
export function discoverUnembeddableFonts(doc: Document = document): string[] {
  const families = new Set<string>();
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (rule.type !== CSSRule.FONT_FACE_RULE) continue;
      const style = (rule as CSSFontFaceRule).style;
      const family = style
        .getPropertyValue("font-family")
        .replace(/^["']|["']$/g, "");
      const src = style.getPropertyValue("src");
      if (family && /url\(/i.test(src) && !matchFontUrl(src))
        families.add(family);
    }
  }
  return [...families];
}

/**
 * Splits text into runs of characters a font can / cannot draw. Pure, so it is
 * unit-testable without a PDF: callers pass a predicate for "can draw this code
 * point". Adjacent characters with the same answer stay in one segment.
 */
export function splitByCoverage(
  text: string,
  canDraw: (codePoint: number) => boolean,
): { text: string; ok: boolean }[] {
  const segments: { text: string; ok: boolean }[] = [];
  for (const ch of text) {
    const ok = canDraw(ch.codePointAt(0)!);
    const last = segments[segments.length - 1];
    if (last && last.ok === ok) last.text += ch;
    else segments.push({ text: ch, ok });
  }
  return segments;
}

const FONT_EMBED_TIMEOUT_MS = 8000;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export type FontRegistry = ReturnType<typeof createFontRegistry>;

export function createFontRegistry(
  pdfDoc: PDFDocument,
  options: FontRegistryOptions = {},
) {
  const {
    fonts: sources = [],
    fallbackFonts = [],
    loadBundledFallback,
    ensureFontkit,
  } = options;
  const standardCache = new Map<string, PDFFont>();
  const customCache = new Map<string, PDFFont | null>();
  const warnings: string[] = [];

  // Explicit sources by family, so a run is matched to the NEAREST weight: a page
  // that uses 300, 500 and 600 should draw those, not collapse to normal or bold.
  const byFamily = new Map<string, Entry[]>();
  sources.forEach((src, i) => {
    const family = src.family.toLowerCase();
    const { min, max } = weightRange(src.weight);
    if (min !== max) {
      // One file for every weight. It cannot be embedded at the weight the page uses,
      // so using it would draw every weight as the default one.
      warnings.push(
        `html-to-pdf: "${src.family}" is a variable font (weights ${min}-${max}), which cannot be embedded at a given weight, so a standard font is used for it. ` +
          `Pass static files for each weight in the "fonts" option for exact text.`,
      );
      return;
    }
    const italic = (src.style ?? "normal") === "italic";
    const extra =
      !!src.unicodeRange && !unicodeRangeCovers(src.unicodeRange, 0x41);
    const list = byFamily.get(family) ?? [];
    list.push({
      src,
      key: `${family}|${min}|${italic ? "i" : "n"}|${i}`,
      min,
      max,
      italic,
      extra,
    });
    byFamily.set(family, list);
  });

  const runWeight = (run: RunStyle): number => {
    const n = Number(run.fontWeight);
    return Number.isFinite(n) &&
      run.fontWeight !== undefined &&
      run.fontWeight !== ""
      ? n
      : run.bold
        ? 700
        : 400;
  };

  const distance = (entry: Entry, want: number, italic: boolean) =>
    (want < entry.min
      ? entry.min - want
      : want > entry.max
        ? want - entry.max
        : 0) + (entry.italic === italic ? 0 : 1000);

  /** The main face for a run: the nearest weight among faces that cover basic Latin. */
  const pickEntry = (run: RunStyle): Entry | null => {
    const list = byFamily.get(primaryFamily(run.fontFamily));
    if (!list) return null;
    const pool = list.filter((e) => !e.extra);
    const candidates = pool.length ? pool : list;
    const want = runWeight(run);
    let best: Entry | null = null;
    let bestScore = Infinity;
    for (const e of candidates) {
      const score = distance(e, want, Boolean(run.italic));
      if (score < bestScore) {
        best = e;
        bestScore = score;
      }
    }
    return best;
  };

  let fontkitReady: Promise<void> | null = null;
  const embedStandard = async (name: StandardFonts) => {
    if (!standardCache.has(name))
      standardCache.set(name, await pdfDoc.embedFont(name));
    return standardCache.get(name)!;
  };

  const embedCustom = async (
    src: FontSource,
    key: string,
  ): Promise<PDFFont | null> => {
    if (customCache.has(key)) return customCache.get(key)!;
    try {
      if (ensureFontkit) await (fontkitReady ??= ensureFontkit());
      const bytes =
        src.bytes ??
        new Uint8Array(await (await fetch(src.url!)).arrayBuffer());
      // `subset: true` keeps only the glyphs actually used: a few KB per face, not hundreds.
      // pdf-lib's subsetter can fail inside a background timer, which leaves this promise
      // pending forever; the timeout turns that into a warning instead of a hung export.
      const embedded = await withTimeout(
        pdfDoc.embedFont(bytes, { subset: true }),
        FONT_EMBED_TIMEOUT_MS,
        "embedding timed out (the font file may be unsupported)",
      );
      customCache.set(key, embedded);
      return embedded;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warnings.push(
        `html-to-pdf: could not embed font "${src.family}" (${src.url ?? "inline bytes"}): ${reason}. A standard font is used instead.`,
      );
      customCache.set(key, null);
      return null;
    }
  };

  // Fallback faces in the order given (configured first, bundled appended later).
  // A bold run prefers a bold fallback.
  const fallbackFaces: { font: PDFFont; bold: boolean }[] = [];
  let configuredFallbacksReady = false;
  let bundledLoaded = false;

  const addFallbacks = async (list: FontSource[], tag: string) => {
    for (let i = 0; i < list.length; i++) {
      const src = list[i]!;
      const font = await embedCustom(src, `fallback|${tag}|${i}`);
      if (font)
        fallbackFaces.push({ font, bold: isBoldWeight(src.weight ?? 400) });
    }
  };

  const parsedOf = (font: PDFFont): FontkitFontLike | undefined =>
    (font as unknown as { embedder?: { font?: FontkitFontLike } }).embedder
      ?.font;

  // Whether a face can encode a character. An embedded (fontkit) font does NOT
  // throw for a character it lacks: it silently substitutes glyph 0, the
  // ".notdef" box, so ask the font for the real glyph. The standard 14 are the
  // opposite: they throw, so try encoding.
  const supportCache = new WeakMap<PDFFont, Map<number, boolean>>();
  const canDraw = (font: PDFFont, codePoint: number): boolean => {
    let perFont = supportCache.get(font);
    if (!perFont) supportCache.set(font, (perFont = new Map()));
    const hit = perFont.get(codePoint);
    if (hit !== undefined) return hit;
    let ok = true;
    const parsed = parsedOf(font);
    if (parsed && typeof parsed.glyphForCodePoint === "function") {
      try {
        ok = parsed.glyphForCodePoint(codePoint).id !== 0;
      } catch {
        ok = false;
      }
    } else {
      try {
        font.encodeText(String.fromCodePoint(codePoint));
      } catch {
        ok = false;
      }
    }
    perFont.set(codePoint, ok);
    return ok;
  };

  /** Synchronous: everything it can return was already embedded by prepareText(). */
  const resolve = (run: RunStyle): PDFFont => {
    const entry = pickEntry(run);
    const custom = entry ? customCache.get(entry.key) : null;
    if (custom) return custom;
    return standardCache.get(
      STANDARD[classifyFamily(run.fontFamily)][styleKey(run.bold, run.italic)],
    )!;
  };

  /** The face to draw one character the run's main face cannot: its family's other-range faces, then the fallbacks. */
  const fallbackFor = (run: RunStyle, codePoint: number): PDFFont | null => {
    const list = byFamily.get(primaryFamily(run.fontFamily)) ?? [];
    const want = runWeight(run);
    const extras = list
      .filter(
        (e) => e.extra && unicodeRangeCovers(e.src.unicodeRange, codePoint),
      )
      .sort(
        (a, b) =>
          distance(a, want, Boolean(run.italic)) -
          distance(b, want, Boolean(run.italic)),
      );
    for (const e of extras) {
      const font = customCache.get(e.key);
      if (font && canDraw(font, codePoint)) return font;
    }
    const ordered = [...fallbackFaces].sort(
      (a, b) =>
        Number(b.bold === Boolean(run.bold)) -
        Number(a.bold === Boolean(run.bold)),
    );
    for (const { font } of ordered) if (canDraw(font, codePoint)) return font;
    return null;
  };

  /**
   * Embeds everything the given text needs, once each: the main face of every
   * run, any of the family's other-range faces for characters the main face
   * lacks, and the configured fallbacks. The bundled Unicode font is loaded
   * only if some character still has no face.
   */
  const prepareText = async (
    items: { run: RunStyle; text: string }[],
  ): Promise<void> => {
    if (!configuredFallbacksReady) {
      configuredFallbacksReady = true;
      await addFallbacks(fallbackFonts, "configured");
    }

    const mains = new Map<string, { run: RunStyle; entry: Entry | null }>();
    for (const { run } of items) {
      const entry = pickEntry(run);
      const key = entry
        ? entry.key
        : `std|${classifyFamily(run.fontFamily)}|${styleKey(run.bold, run.italic)}`;
      if (!mains.has(key)) mains.set(key, { run, entry });
    }
    for (const { run, entry } of mains.values()) {
      if (entry) await embedCustom(entry.src, entry.key);
      await embedStandard(
        STANDARD[classifyFamily(run.fontFamily)][
          styleKey(run.bold, run.italic)
        ],
      );
    }

    // Characters the main face lacks: embed the family's matching other-range faces.
    let stillMissing = false;
    for (const { run, text } of items) {
      const main = resolve(run);
      for (const ch of text) {
        const cp = ch.codePointAt(0)!;
        if (canDraw(main, cp)) continue;
        const list = byFamily.get(primaryFamily(run.fontFamily)) ?? [];
        for (const e of list) {
          if (e.extra && unicodeRangeCovers(e.src.unicodeRange, cp))
            await embedCustom(e.src, e.key);
        }
        if (!fallbackFor(run, cp)) stillMissing = true;
      }
    }

    if (stillMissing && !bundledLoaded && loadBundledFallback) {
      bundledLoaded = true;
      try {
        await addFallbacks(await loadBundledFallback(), "bundled");
      } catch (err) {
        warnings.push(
          `html-to-pdf: the bundled fallback font could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };

  /** Prepares the paginated 'flow' document's runs (text-line boxes and groups). */
  const prepare = async (
    pages: { box: { content?: FlowContent } }[][],
  ): Promise<void> => {
    const items: { run: RunStyle & { text: string }; text: string }[] = [];
    const take = (runs: (RunStyle & { text: string })[]) =>
      runs.forEach((run) => items.push({ run, text: run.text }));
    for (const page of pages) {
      for (const { box } of page) {
        const content = box.content;
        if (!content) continue;
        if (content.type === "text-line" && content.runs) take(content.runs);
        else if (content.type === "group" && content.items) {
          for (const item of content.items) if (item.runs) take(item.runs);
        }
      }
    }
    await prepareText(items);
  };

  return { prepare, prepareText, resolve, fallbackFor, canDraw, warnings };
}

/** The slice of a flow-mode box's content that `prepare` reads. */
type FlowContent = {
  type: string;
  runs?: (RunStyle & { text: string })[];
  items?: { type?: string; runs?: (RunStyle & { text: string })[] }[];
};
