/**
 * html-to-pdf
 *
 *   import { downloadPdf } from 'html-to-pdf';
 *   await downloadPdf(element, 'quote.pdf');
 *
 * That is the whole setup. The element is laid out in a hidden desktop-width frame in the
 * light theme, measured, and drawn as a real vector PDF (selectable text, clickable links,
 * backgrounds, gradients, rounded corners, images) across A4 pages, broken where no line,
 * row or card is crossing. Everything is configurable through an optional config object;
 * `page.mode: 'continuous'` gives one tall page instead.
 */

import { analyze } from "./core/content-flow-analyzer.js";
import {
  discoverUnembeddableFonts,
  discoverWebFonts,
  type FontSource,
} from "./core/font-registry.js";
import { analyzeLayout } from "./core/layout-extractor.js";
import { writeLayoutPdf } from "./core/layout-writer.js";
import { computePageBreaks } from "./core/page-breaker.js";
import { paginate } from "./core/pagination-engine.js";
import { writePdf } from "./core/pdf-writer.js";
import {
  resolveConfig,
  type PdfConfig,
  type PdfResult,
  type ResolvedConfig,
} from "./config.js";
import { loadBundledInter } from "./fonts/bundled.js";
import {
  createDesktopRender,
  type DesktopRender,
} from "./render/desktop-frame.js";

export type {
  FlowConfig,
  ImagesConfig,
  PageConfig,
  PageMargin,
  PageSize,
  PdfConfig,
  PdfResult,
  RenderConfig,
} from "./config.js";
export type { FontSource } from "./core/font-registry.js";
export type { ImageLoader } from "./core/image-embed.js";
export { PAGE_SIZES } from "./config.js";
export { discoverWebFonts, classifyFamily } from "./core/font-registry.js";

const MAX_PAGE_PT = 14400; // PDF's practical page-size limit (200 in)
const PX_TO_PT = 72 / 96;

function resolveSource(source: Element | string): Element {
  if (typeof source !== "string") {
    if (!source) throw new Error("html-to-pdf: no element was given.");
    return source;
  }
  const found = document.querySelector(source);
  if (!found) throw new Error(`html-to-pdf: no element matches "${source}".`);
  return found;
}

function fontsFor(cfg: ResolvedConfig, doc: Document): FontSource[] {
  return cfg.fonts === "auto" ? discoverWebFonts(doc) : cfg.fonts;
}

/** True when `fonts` has a static (embeddable) face of the family. */
function hasStaticFace(fonts: FontSource[], family: string): boolean {
  return fonts.some(
    (f) =>
      f.family.toLowerCase() === family &&
      !/\s/.test(String(f.weight ?? "").trim()),
  );
}

/**
 * The page's fonts plus, when the text uses Inter and no embeddable Inter was supplied, the bundled
 * Inter. `inter` reports whether the bundle was added (so the "cannot be embedded" warning is dropped).
 */
async function withBundledInter(
  cfg: ResolvedConfig,
  doc: Document,
  used: Set<string>,
) {
  const fonts = fontsFor(cfg, doc);
  const fallbackFonts = cfg.fallbackFonts;
  if (
    !cfg.bundledInter ||
    !used.has("inter") ||
    hasStaticFace(fonts, "inter")
  ) {
    return { fonts, fallbackFonts, inter: false };
  }
  try {
    const bundle = await loadBundledInter();
    return {
      fonts: [...fonts, ...bundle.fonts],
      fallbackFonts: [...fallbackFonts, ...bundle.fallbackFonts],
      inter: true,
    };
  } catch {
    return { fonts, fallbackFonts, inter: false };
  }
}

/**
 * With automatic fonts, tells the caller once if text on the page uses a font that
 * cannot be embedded (WOFF2 or variable), instead of silently substituting.
 */
function unembeddableFontWarning(
  cfg: ResolvedConfig,
  doc: Document,
  usedFamilies: Set<string>,
  interBundled = false,
): string[] {
  if (cfg.fonts !== "auto") return [];
  const blocked = discoverUnembeddableFonts(doc).filter(
    (family) =>
      usedFamilies.has(family.toLowerCase()) &&
      !(interBundled && family.toLowerCase() === "inter"),
  );
  if (!blocked.length) return [];
  return [
    `html-to-pdf: the page's font ${blocked.map((f) => `"${f}"`).join(", ")} is WOFF2 or a variable font, which cannot be embedded, so a standard font is used instead. ` +
      `For exact text, pass static TTF or WOFF files in the "fonts" option (see the README, "Fonts").`,
  ];
}

function familiesUsed(layout: {
  prims: { type: string; style?: { fontFamily: string } }[];
}): Set<string> {
  const used = new Set<string>();
  for (const p of layout.prims) {
    if (p.type !== "text" || !p.style) continue;
    used.add(
      (p.style.fontFamily.split(",")[0] ?? "")
        .trim()
        .replace(/^["']|["']$/g, "")
        .toLowerCase(),
    );
  }
  return used;
}

/** 'preserve': every element where the browser put it, drawn with its backgrounds, borders and images. */
async function generatePreserved(
  root: Element,
  cfg: ResolvedConfig,
  doc: Document,
): Promise<PdfResult> {
  const layout = await analyzeLayout(
    root,
    cfg.render ? { skip: cfg.render.skip } : {},
  );
  if (!layout.width || !layout.height) {
    throw new Error(
      "html-to-pdf: the element has no size. Is it rendered and visible?",
    );
  }
  if (!cfg.links) layout.prims = layout.prims.filter((p) => p.type !== "link");

  const { size, margin } = cfg.page;
  const warnings: string[] = [];
  let pageWidthPt = size.width;
  let pageHeightPt = size.height;
  let scale: number;
  let cuts: number[];

  const continuousHeightPt =
    layout.height * PX_TO_PT + margin.top + margin.bottom;
  const limit = Math.min(MAX_PAGE_PT, cfg.page.maxHeight ?? Infinity);
  if (cfg.page.mode === "continuous" && continuousHeightPt <= limit) {
    // One page the exact size of the document at 1 CSS px = 0.75pt: nothing to cut.
    scale = PX_TO_PT;
    pageWidthPt = layout.width * PX_TO_PT + margin.left * 2;
    pageHeightPt = continuousHeightPt;
    cuts = [0, layout.height];
  } else if (cfg.page.mode === "continuous") {
    // Too tall for one page (the PDF limit, or the caller's maxHeight): equally wide, tall pages,
    // cut at safe lines, still drawn at the document's own scale.
    if (continuousHeightPt > MAX_PAGE_PT && !cfg.page.maxHeight) {
      warnings.push(
        "the document is too tall for one PDF page, so it was split into tall pages.",
      );
    }
    scale = PX_TO_PT;
    pageWidthPt = layout.width * PX_TO_PT + margin.left * 2;
    pageHeightPt = Math.min(limit, MAX_PAGE_PT);
    const pageHeightPx = (pageHeightPt - margin.top - margin.bottom) / scale;
    cuts = computePageBreaks({
      totalHeight: layout.height,
      pageHeight: pageHeightPx,
      avoid: layout.avoid,
    });
  } else {
    // Fit the document's width to the page's content width; the height follows.
    scale = (size.width - margin.left * 2) / layout.width;
    const pageHeightPx = (size.height - margin.top - margin.bottom) / scale;
    cuts = computePageBreaks({
      totalHeight: layout.height,
      pageHeight: pageHeightPx,
      avoid: layout.avoid,
    });
  }

  const used = familiesUsed(layout);
  const setup = await withBundledInter(cfg, doc, used);
  const written = await writeLayoutPdf(layout, {
    pageWidthPt,
    pageHeightPt,
    marginTopPt: margin.top,
    marginBottomPt: margin.bottom,
    marginLeftPt: margin.left,
    cuts,
    scale,
    fonts: setup.fonts,
    fallbackFonts: setup.fallbackFonts,
    bundledFallback: cfg.bundledFallbackFont,
    fontkit: cfg.fontkit,
    ...(cfg.images.loader ? { imageLoader: cfg.images.loader } : {}),
    imageResolution: cfg.images.resolution ?? false,
    pageBackground: cfg.page.background,
  });

  return {
    bytes: written.bytes,
    pageCount: written.pageCount,
    warnings: [
      ...warnings,
      ...unembeddableFontWarning(cfg, doc, used, setup.inter),
      ...written.warnings,
    ],
    notes: layout.notes,
  };
}

/** 'flow': re-stacks text, images and table rows into pages. */
async function generateFlow(
  root: Element,
  cfg: ResolvedConfig,
  doc: Document,
): Promise<PdfResult> {
  const { size, margin } = cfg.page;
  const boxes = analyze(root);
  const { pages, warnings } = paginate(boxes, {
    pageHeight: size.height,
    marginTop: margin.top,
    marginBottom: margin.bottom,
    oversized: cfg.flow.oversized,
    minFill: cfg.flow.minFill,
  });
  const written = await writePdf(pages, {
    pageWidthPt: size.width,
    pageHeightPt: size.height,
    marginLeftPt: margin.left,
    marginTopPt: margin.top,
    fonts: fontsFor(cfg, doc),
    fallbackFonts: cfg.fallbackFonts,
    bundledFallback: cfg.bundledFallbackFont,
    fontkit: cfg.fontkit,
    ...(cfg.images.loader ? { imageLoader: cfg.images.loader } : {}),
    imageResolution: cfg.images.resolution,
  });
  return {
    bytes: written.bytes,
    pageCount: pages.length,
    warnings: [...warnings, ...written.warnings],
    notes: [],
  };
}

/**
 * Generates a PDF from an element (or a CSS selector) and returns its bytes.
 * Never throws for a missing font, glyph or image; those become `warnings`.
 */
export async function generatePdf(
  source: Element | string,
  config: PdfConfig = {},
): Promise<PdfResult> {
  const cfg = resolveConfig(config);
  const element = resolveSource(source);
  const doc = element.ownerDocument;

  let render: DesktopRender | null = null;
  try {
    let root: Element = element;
    if (cfg.render) {
      render = await createDesktopRender(element, cfg.render);
      root = render.root;
    }
    const result =
      cfg.layout === "flow"
        ? await generateFlow(root, cfg, doc)
        : await generatePreserved(root, cfg, doc);
    if (cfg.logWarnings && result.warnings.length)
      console.warn("[html-to-pdf]", ...result.warnings);
    return result;
  } finally {
    render?.dispose();
  }
}

/** Generates a PDF and saves it in the browser. */
export async function downloadPdf(
  source: Element | string,
  filename = "document.pdf",
  config: PdfConfig = {},
): Promise<PdfResult> {
  const result = await generatePdf(source, config);

  const blob = new Blob([result.bytes as BlobPart], {
    type: "application/pdf",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".pdf") ? filename : `${filename}.pdf`;
  a.click();
  // Revoke after the browser has had time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);

  return result;
}
