/**
 * config.ts
 *
 * Everything a user can change, and what it defaults to. Every field is
 * optional: `downloadPdf(element)` with no config produces the exact desktop
 * layout of the element across A4 pages.
 */

import type { FontSource } from "./core/font-registry.js";
import type { ImageLoader } from "./core/image-embed.js";
import { IMAGE_DEFAULTS } from "./core/image-embed.js";

export const PAGE_SIZES = {
  A4: { width: 595.28, height: 841.89 },
  LETTER: { width: 612, height: 792 },
} as const;

export type PageSize =
  | keyof typeof PAGE_SIZES
  | { width: number; height: number };

export type PageMargin =
  | number
  | { top?: number; bottom?: number; left?: number };

export type PageConfig = {
  /** Page size in PDF points, or a name. Default 'A4'. Only matters when `mode` is 'paginated'. */
  size?: PageSize;
  /**
   * 'paginated' (default): regular pages of `size`, cut between lines of text, images and small
   * cards, so a page never ends mid-row and never closes early. 'continuous': one tall page exactly
   * as long as the document, for something that will only ever be read on a screen.
   */
  mode?: "continuous" | "paginated";
  /**
   * 'continuous' only: split a document taller than this many points into several equally wide, tall pages,
   * cut between lines of text, images and small cards. Some viewers draw a very long single page in one go
   * and scroll jerkily; several pages are drawn lazily. Default: no limit (always one page).
   */
  maxHeight?: number;
  /** Page margin in points. Default 36 for 'paginated', 0 for 'continuous'. */
  margin?: PageMargin;
  /** Colour behind each page. Default none (white). */
  background?: { r: number; g: number; b: number } | null;
};

export type RenderConfig = {
  /**
   * Which layout the PDF copies. 'desktop' (default) always uses the desktop layout. 'responsive'
   * follows the device that downloads: a phone gets the page's mobile layout at `phoneWidth`
   * (readable without zooming), anything wider gets the desktop layout.
   */
  view?: "desktop" | "responsive";
  /** 'responsive' only: screens at or below this width (CSS px) count as a phone. Default 767. */
  phoneBreakpoint?: number;
  /** 'responsive' only: width of the mobile layout in CSS px. Default 430. */
  phoneWidth?: number;
  /** Width of the viewport the copy is laid out in, so desktop breakpoints apply. Default 1440. */
  viewportWidth?: number;
  /**
   * Width of the document in CSS px. 'auto' (default) measures the element on the page and keeps the
   * result between `minContentWidth` and `maxContentWidth`, so a phone still gets a desktop-width document.
   */
  contentWidth?: number | "auto";
  /** Lower bound for 'auto'. Default 900. */
  minContentWidth?: number;
  /** Upper bound for 'auto'. Default 1200. */
  maxContentWidth?: number;
  /** 'light' (default) forces the light theme; 'dark' forces dark; 'auto' keeps the page's current theme. */
  theme?: "light" | "dark" | "auto";
  /** Elements matching this selector are removed from the PDF. Default '[data-pdf-hide]'. */
  hide?: string;
  /** Elements matching this selector (and their contents) are skipped. Default '[data-pdf-skip]'. */
  skip?: string;
};

export type ImagesConfig = {
  /** Keep this many pixels per drawn CSS pixel. 2 (default) stays sharp on retina screens and when zoomed. */
  pixelRatio?: number;
  /** JPEG quality, 0-1, for photos that are reduced. Default 0.95. */
  quality?: number;
  /** Leave an image untouched unless it is more than this many times larger than needed. Default 1.5. */
  recompressAbove?: number;
  /** Set false to embed every image exactly as fetched. Default true. */
  resample?: boolean;
  /** Called for an image the browser will not let the page read (no CORS headers). Return its bytes. */
  loader?: ImageLoader;
};

export type FlowConfig = {
  /** What to do with an image taller than a whole page. Default 'scale'. */
  oversized?: "scale" | "overflow";
  /** Smallest fraction of a page a shrunk image may be reduced to. Default 0.4. */
  minFill?: number;
};

export type PdfConfig = {
  /**
   * 'preserve' (default): an exact copy of the on-screen layout, with backgrounds, gradients, borders,
   * rounded corners, images, icons, links and text. 'flow': re-stacks the content as plain text, images
   * and tables, which suits document-like pages but loses designed layouts.
   */
  layout?: "preserve" | "flow";
  page?: PageConfig;
  /**
   * Lay the element out in a hidden desktop-width frame in the light theme, so the PDF never depends on
   * the size of the user's window. Set false to draw the element exactly as it is on screen.
   */
  render?: false | RenderConfig;
  /** Fonts to embed. 'auto' (default) uses the page's own `@font-face` rules. */
  fonts?: FontSource[] | "auto";
  /** Used, in order, for characters the page's fonts cannot draw. */
  fallbackFonts?: FontSource[];
  /** Use the bundled Unicode font for characters nothing else can draw (covers the rupee sign). Default true. */
  bundledFallbackFont?: boolean;
  /**
   * Use the bundled Inter (all weights, with ₹) when the page uses Inter but its own copy cannot be
   * embedded (a variable WOFF2 from next/font or Google Fonts). Default true.
   */
  bundledInter?: boolean;
  /** Overrides the automatically loaded fontkit. */
  fontkit?: unknown;
  images?: ImagesConfig;
  /** Make links clickable. Default true. */
  links?: boolean;
  /** Options for the 'flow' layout. */
  flow?: FlowConfig;
  /** Print warnings (blocked images, missing fonts) to the console. Default true. */
  logWarnings?: boolean;
};

export type PdfResult = {
  bytes: Uint8Array;
  pageCount: number;
  /** Things worth fixing: images the browser blocked, fonts that failed to load. */
  warnings: string[];
  /** Effects the page uses that are not drawn (box-shadow, transforms...). Informational. */
  notes: string[];
};

export type ResolvedRender = Required<
  Omit<RenderConfig, "contentWidth" | "view" | "phoneBreakpoint" | "phoneWidth">
> & { contentWidth: number | "auto" };

export type ResolvedConfig = {
  layout: "preserve" | "flow";
  page: {
    size: { width: number; height: number };
    mode: "continuous" | "paginated";
    maxHeight: number | null;
    margin: { top: number; bottom: number; left: number };
    background: { r: number; g: number; b: number } | null;
  };
  render: ResolvedRender | null;
  fonts: FontSource[] | "auto";
  fallbackFonts: FontSource[];
  bundledFallbackFont: boolean;
  bundledInter: boolean;
  fontkit: unknown;
  images: {
    resolution: {
      pixelRatio: number;
      jpegQuality: number;
      recompressAbove: number;
    } | null;
    loader: ImageLoader | undefined;
  };
  links: boolean;
  flow: { oversized: "scale" | "overflow"; minFill: number };
  logWarnings: boolean;
};

const PHONE_DEFAULTS = { breakpoint: 767, width: 430 };

/** Applies `render.view`: on a phone, 'responsive' lays the copy out at phone width. */
function resolveRender(render: RenderConfig = {}): ResolvedRender {
  const { view, phoneBreakpoint, phoneWidth, ...rest } = render;
  const resolved: ResolvedRender = { ...RENDER_DEFAULTS, ...rest };
  if (
    view === "responsive" &&
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
  ) {
    const isPhone = window.matchMedia(
      `(max-width: ${phoneBreakpoint ?? PHONE_DEFAULTS.breakpoint}px)`,
    ).matches;
    if (isPhone) {
      const width = phoneWidth ?? PHONE_DEFAULTS.width;
      resolved.viewportWidth = width;
      resolved.contentWidth = width;
    }
  }
  return resolved;
}

export const RENDER_DEFAULTS: ResolvedRender = {
  viewportWidth: 1440,
  contentWidth: "auto",
  minContentWidth: 900,
  maxContentWidth: 1200,
  theme: "light",
  hide: "[data-pdf-hide]",
  skip: "[data-pdf-skip]",
};

export function resolveConfig(config: PdfConfig = {}): ResolvedConfig {
  const mode = config.page?.mode ?? "paginated";
  const size =
    typeof config.page?.size === "object"
      ? config.page.size
      : (PAGE_SIZES[config.page?.size ?? "A4"] ?? PAGE_SIZES.A4);
  const defaultMargin = mode === "continuous" ? 0 : 36;
  const m = config.page?.margin;
  const margin =
    typeof m === "number"
      ? { top: m, bottom: m, left: m }
      : {
          top: m?.top ?? defaultMargin,
          bottom: m?.bottom ?? m?.top ?? defaultMargin,
          left: m?.left ?? defaultMargin,
        };

  const images = config.images ?? {};
  return {
    layout: config.layout ?? "preserve",
    page: {
      size: { width: size.width, height: size.height },
      mode,
      maxHeight:
        config.page?.maxHeight && config.page.maxHeight > 0
          ? config.page.maxHeight
          : null,
      margin,
      background: config.page?.background ?? null,
    },
    render: config.render === false ? null : resolveRender(config.render),
    fonts: config.fonts ?? "auto",
    fallbackFonts: config.fallbackFonts ?? [],
    bundledFallbackFont: config.bundledFallbackFont ?? true,
    bundledInter: config.bundledInter ?? true,
    fontkit: config.fontkit,
    images: {
      resolution:
        images.resample === false
          ? null
          : {
              pixelRatio: images.pixelRatio ?? IMAGE_DEFAULTS.pixelRatio,
              jpegQuality: images.quality ?? IMAGE_DEFAULTS.jpegQuality,
              recompressAbove:
                images.recompressAbove ?? IMAGE_DEFAULTS.recompressAbove,
            },
      loader: images.loader,
    },
    links: config.links ?? true,
    flow: {
      oversized: config.flow?.oversized ?? "scale",
      minFill: config.flow?.minFill ?? 0.4,
    },
    logWarnings: config.logWarnings ?? true,
  };
}
