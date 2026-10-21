/**
 * color.ts
 *
 * CSS colour -> { r, g, b, a } (each 0-1). The common `rgb()/rgba()/#hex`
 * forms are parsed directly, which keeps this usable in plain Node. Anything
 * else (`oklch()`, `color-mix()`, `lab()`, named colours, `color(display-p3 ..)`)
 * is handed to the browser's own canvas, which normalises every colour syntax
 * it understands to sRGB. That matters because `getComputedStyle` keeps modern
 * colour spaces as written, and a regex that only knows `rgb()` would turn every
 * such colour black.
 */

export type Rgba = { r: number; g: number; b: number; a: number };

const cache = new Map<string, Rgba>();
let probe: CanvasRenderingContext2D | undefined;

function fromRgbFunction(str: string): Rgba | null {
  const m = str.match(
    /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i,
  );
  if (!m) return null;
  const chan = (v: string) =>
    (v.endsWith("%") ? parseFloat(v) * 2.55 : parseFloat(v)) / 255;
  const alphaRaw = m[4];
  const alpha =
    alphaRaw === undefined
      ? 1
      : alphaRaw.endsWith("%")
        ? parseFloat(alphaRaw) / 100
        : parseFloat(alphaRaw);
  return {
    r: chan(m[1]!),
    g: chan(m[2]!),
    b: chan(m[3]!),
    a: Math.min(1, Math.max(0, alpha)),
  };
}

function fromHex(str: string): Rgba | null {
  const m = str.match(/^#([0-9a-f]{3,8})$/i);
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  if (h.length !== 6 && h.length !== 8) return null;
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
    a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
  };
}

function viaCanvas(str: string): Rgba | null {
  try {
    if (typeof document === "undefined") return null;
    probe ||=
      document
        .createElement("canvas")
        .getContext("2d", { willReadFrequently: true }) ?? undefined;
    if (!probe) return null;
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = "#000";
    probe.fillStyle = str; // an unparseable value leaves the previous one in place
    probe.fillRect(0, 0, 1, 1);
    const d = probe.getImageData(0, 0, 1, 1).data;
    // Un-premultiply: getImageData returns colour scaled by alpha.
    const a = d[3]! / 255;
    return a === 0
      ? { r: 0, g: 0, b: 0, a: 0 }
      : {
          r: Math.min(1, d[0]! / 255 / a),
          g: Math.min(1, d[1]! / 255 / a),
          b: Math.min(1, d[2]! / 255 / a),
          a,
        };
  } catch {
    return null;
  }
}

/** Parses any CSS colour into sRGB channels (0-1) plus alpha. */
export function parseCssColor(value: unknown): Rgba {
  const str = String(value ?? "").trim();
  if (!str) return { r: 0, g: 0, b: 0, a: 0 };
  const hit = cache.get(str);
  if (hit) return hit;

  const color: Rgba =
    str === "transparent"
      ? { r: 0, g: 0, b: 0, a: 0 }
      : (fromRgbFunction(str) ??
        fromHex(str) ??
        viaCanvas(str) ?? { r: 0, g: 0, b: 0, a: 1 });

  cache.set(str, color);
  return color;
}
