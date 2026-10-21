/**
 * image-embed.ts
 *
 * Fetches images and embeds them in the PDF, shared by both writers.
 *
 * Photos are re-sampled only when they are far larger than they will ever be
 * shown, so the file stays small without a visible loss: see `embedBlob`.
 */

import type { PDFDocument, PDFImage } from "pdf-lib";

export type ImageLoader = (
  src: string,
) => Promise<Blob | ArrayBuffer | Uint8Array | null>;

/** How photos are sized. `pixelRatio` is device pixels per drawn CSS pixel. */
export type ImageResolution = {
  /** Keep this many pixels per drawn CSS pixel (2 stays sharp on retina and when zoomed). Default 2. */
  pixelRatio: number;
  /** JPEG quality for re-sampled photos, 0-1. Default 0.95. */
  jpegQuality: number;
  /** Leave an image untouched unless it is more than this many times larger than needed. Default 1.5. */
  recompressAbove: number;
};

export const IMAGE_DEFAULTS: ImageResolution = {
  pixelRatio: 2,
  jpegQuality: 0.95,
  recompressAbove: 1.5,
};

export function sniffImageKind(bytes: Uint8Array): "jpg" | "png" | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "png";
  return null;
}

/** Fetches an image's bytes, falling back to the caller's loader when the browser blocks the read. */
export async function loadImageBlob(
  src: string,
  loader?: ImageLoader,
): Promise<Blob> {
  let blob: Blob | null = null;
  let failure: unknown = null;
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    blob = await res.blob();
  } catch (err) {
    failure = err;
  }
  // The browser blocks reading cross-origin images that lack CORS headers, even
  // though it happily displays them. A caller-supplied loader (typically a
  // same-origin proxy) is the way around that.
  if (!blob && loader) {
    const loaded = await loader(src);
    if (loaded)
      blob = loaded instanceof Blob ? loaded : new Blob([loaded as BlobPart]);
  }
  if (!blob) throw failure ?? new Error("image could not be loaded");
  return blob;
}

/** Draws a bitmap at width x height, halving step by step: a single big jump aliases and looks harsh. */
function resample(
  bitmap: ImageBitmap,
  width: number,
  height: number,
): HTMLCanvasElement {
  let source: CanvasImageSource = bitmap;
  let w = bitmap.width;
  let h = bitmap.height;
  while (w / 2 >= width) {
    w = Math.round(w / 2);
    h = Math.round(h / 2);
    const step = document.createElement("canvas");
    step.width = w;
    step.height = h;
    const sctx = step.getContext("2d")!;
    sctx.imageSmoothingQuality = "high";
    sctx.drawImage(source, 0, 0, w, h);
    source = step;
  }
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, width, height);
  return out;
}

function hasTransparency(canvas: HTMLCanvasElement): boolean {
  const data = canvas
    .getContext("2d")!
    .getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < data.length; i += 4) if (data[i]! < 255) return true;
  return false;
}

/**
 * Embeds an image, re-sampling it first only when it is far larger than it will
 * ever be shown. `requiredWidth` is the width, in device pixels, the largest use
 * of this image needs (drawn size x pixelRatio). An image within `recompressAbove`
 * times that is embedded byte-for-byte, never re-encoded; a larger one is reduced
 * with stepwise high-quality resampling and written as JPEG at high quality (or
 * PNG when it has transparency), and is never scaled UP.
 */
export async function embedBlob(
  pdfDoc: PDFDocument,
  blob: Blob,
  requiredWidth: number | undefined,
  config: ImageResolution | null,
): Promise<PDFImage> {
  const original = new Uint8Array(await blob.arrayBuffer());
  const kind = sniffImageKind(original);
  const canDecode =
    typeof createImageBitmap === "function" && typeof document !== "undefined";

  let bitmap: ImageBitmap | null = null;
  if (canDecode && (config || !kind)) {
    try {
      bitmap = await createImageBitmap(blob);
    } catch {
      bitmap = null;
    }
  }

  const oversized = !!(
    config &&
    bitmap &&
    requiredWidth &&
    bitmap.width > requiredWidth * config.recompressAbove
  );

  if (bitmap && (oversized || !kind)) {
    const width = oversized
      ? Math.max(1, Math.round(requiredWidth!))
      : bitmap.width;
    const height = Math.max(
      1,
      Math.round((bitmap.height * width) / bitmap.width),
    );
    let canvas: HTMLCanvasElement;
    if (oversized) {
      canvas = resample(bitmap, width, height);
    } else {
      canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    }
    const transparent = kind === "jpg" ? false : hasTransparency(canvas);
    const quality = config ? config.jpegQuality : 0.95;
    const encoded = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, transparent ? "image/png" : "image/jpeg", quality),
    );
    bitmap.close?.();
    if (encoded) {
      const bytes = new Uint8Array(await encoded.arrayBuffer());
      return transparent ? pdfDoc.embedPng(bytes) : pdfDoc.embedJpg(bytes);
    }
  }
  bitmap?.close?.();
  if (!kind) throw new Error("unsupported image format");
  return kind === "png" ? pdfDoc.embedPng(original) : pdfDoc.embedJpg(original);
}

/** An embedder with a cache and plain-language warnings, so one bad image never fails the document. */
export function createImageEmbedder(
  pdfDoc: PDFDocument,
  options: {
    loader?: ImageLoader;
    config: ImageResolution | null;
    warnings: string[];
  },
) {
  const cache = new Map<string, PDFImage | null>();
  const blocked: string[] = [];

  async function embed(
    src: string,
    requiredWidth?: number,
  ): Promise<PDFImage | null> {
    if (cache.has(src)) return cache.get(src)!;
    let embedded: PDFImage | null = null;
    try {
      embedded = await embedBlob(
        pdfDoc,
        await loadImageBlob(src, options.loader),
        requiredWidth,
        options.config,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (err instanceof TypeError) blocked.push(src);
      else
        options.warnings.push(
          `html-to-pdf: could not embed image "${src.slice(0, 80)}": ${reason}`,
        );
    }
    cache.set(src, embedded);
    return embedded;
  }

  /** Call after drawing: reports blocked images together, with the fix. */
  function finish() {
    if (!blocked.length) return;
    const hosts = [
      ...new Set(
        blocked.map((s) => {
          try {
            return new URL(s).origin;
          } catch {
            return s;
          }
        }),
      ),
    ];
    options.warnings.push(
      `html-to-pdf: ${blocked.length} image(s) were left out because the browser blocked reading them: ${hosts.join(", ")}. ` +
        `Allow this site's origin in that host's CORS settings (see the README, "Images from another domain"), or pass images.loader.`,
    );
  }

  return { embed, finish };
}
