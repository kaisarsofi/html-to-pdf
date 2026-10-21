/**
 * layout-math.ts
 *
 * Pure helpers for the layout-preserving mode: parsing CSS gradients and radii,
 * and the geometry of a CSS gradient line. No DOM and no PDF, so all of it is
 * unit-tested in plain Node.
 */

import { parseCssColor, type Rgba } from "./color.js";
import type { PathSegment } from "./svg-path.js";

export type GradientKind = "linear" | "radial" | "conic";
export type GradientStop = {
  color: Rgba;
  pos: number | null;
  posUnit: "%" | "px" | null;
};
export type Gradient = {
  kind: GradientKind;
  angleDeg: number | null;
  corner: { sx: number; sy: number } | null;
  stops: GradientStop[];
};
export type ResolvedStop = { color: Rgba; pos: number };
export type GradientAxis = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  length: number;
};
export type Radius = { x: number; y: number };
export type Radii = { tl: Radius; tr: Radius; br: Radius; bl: Radius };
export type ImageFit =
  | "fill"
  | "cover"
  | "contain"
  | "none"
  | "scale-down"
  | string;
export type Placement = { x: number; y: number; w: number; h: number };
export type CharBox = {
  ch: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
};
export type Fragment = {
  text: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
};

/** Splits on a separator that is not inside parentheses or quotes. */
export function splitTopLevel(str: string, sep = ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (const ch of str) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === sep && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** Reads a leading CSS colour token (which may itself contain parentheses). */
function takeColor(part: string): { color: string; rest: string } | null {
  const fn = part.match(/^([a-z-]+)\(/i);
  if (fn) {
    let depth = 0;
    for (let i = 0; i < part.length; i++) {
      if (part[i] === "(") depth++;
      else if (part[i] === ")" && --depth === 0) {
        return { color: part.slice(0, i + 1), rest: part.slice(i + 1).trim() };
      }
    }
  }
  const m = part.match(/^(\S+)\s*(.*)$/);
  return m ? { color: m[1]!, rest: m[2]! } : null;
}

/** Parses a computed `background-image` layer into a gradient, or null if it is not one. */
export function parseGradient(value: string): Gradient | null {
  const m = String(value)
    .trim()
    .match(/^(repeating-)?(linear|radial|conic)-gradient\((.*)\)$/is);
  if (!m) return null;
  const kind = m[2]!.toLowerCase() as GradientKind;
  const args = splitTopLevel(m[3]!);
  if (args.length < 2) return null;

  let angleDeg: number | null = null;
  let corner: { sx: number; sy: number } | null = null;
  const first = args[0]!.replace(/\s+in\s+[a-z0-9 -]+$/i, "").trim();

  const isDirection =
    kind === "linear" &&
    (/^-?[\d.]+(deg|grad|rad|turn)$/i.test(first) || /^to\s/i.test(first));
  const isShape =
    kind !== "linear" &&
    /^(circle|ellipse|closest|farthest|from|at\s|[\d.]+(px|%))/i.test(first);

  if (isDirection) {
    args.shift();
    const a = first.match(/^(-?[\d.]+)(deg|grad|rad|turn)$/i);
    if (a) {
      const n = parseFloat(a[1]!);
      const unit = a[2]!.toLowerCase();
      angleDeg =
        unit === "deg"
          ? n
          : unit === "grad"
            ? n * 0.9
            : unit === "rad"
              ? (n * 180) / Math.PI
              : n * 360;
    } else {
      const words = first.toLowerCase().split(/\s+/).slice(1);
      const sx = words.includes("right") ? 1 : words.includes("left") ? -1 : 0;
      const sy = words.includes("bottom") ? 1 : words.includes("top") ? -1 : 0;
      if (sx && sy) corner = { sx, sy };
      else angleDeg = sy === -1 ? 0 : sx === 1 ? 90 : sy === 1 ? 180 : 270;
    }
  } else if (isShape) {
    args.shift();
  }
  if (kind === "linear" && angleDeg === null && !corner) angleDeg = 180;

  const stops: GradientStop[] = [];
  for (const arg of args) {
    const taken = takeColor(arg);
    if (!taken) continue;
    const color = parseCssColor(taken.color);
    const pos = taken.rest.match(/^(-?[\d.]+)(%|px)/);
    stops.push({
      color,
      pos: pos ? parseFloat(pos[1]!) : null,
      posUnit: pos ? (pos[2] as "%" | "px") : null,
    });
  }
  if (stops.length < 2) return null;
  return { kind, angleDeg, corner, stops };
}

/**
 * Turns parsed stops into positions along the gradient line (0-1), filling in
 * unpositioned stops the way CSS does and keeping positions non-decreasing.
 * A fully transparent stop borrows the RGB of its neighbour so the fade does
 * not pass through a dark band (canvas and PDF interpolate un-premultiplied).
 */
export function resolveStops(
  stops: GradientStop[],
  lineLength: number,
): ResolvedStop[] {
  const out: { color: Rgba; pos: number | null }[] = stops.map((s) => ({
    color: { ...s.color },
    pos:
      s.pos === null
        ? null
        : s.posUnit === "px"
          ? s.pos / lineLength
          : s.pos / 100,
  }));
  if (out[0]!.pos === null) out[0]!.pos = 0;
  if (out[out.length - 1]!.pos === null) out[out.length - 1]!.pos = 1;

  let i = 0;
  while (i < out.length) {
    if (out[i]!.pos !== null) {
      i++;
      continue;
    }
    let j = i;
    while (out[j]!.pos === null) j++;
    const start = out[i - 1]!.pos as number;
    const end = out[j]!.pos as number;
    for (let k = i; k < j; k++)
      out[k]!.pos = start + ((end - start) * (k - i + 1)) / (j - i + 1);
    i = j;
  }

  for (let k = 1; k < out.length; k++)
    out[k]!.pos = Math.max(out[k]!.pos as number, out[k - 1]!.pos as number);

  out.forEach((s, k) => {
    if (
      s.color.a === 0 &&
      s.color.r === 0 &&
      s.color.g === 0 &&
      s.color.b === 0
    ) {
      const neighbour = out[k + 1] ?? out[k - 1];
      if (neighbour && neighbour.color.a > 0) {
        s.color = {
          r: neighbour.color.r,
          g: neighbour.color.g,
          b: neighbour.color.b,
          a: 0,
        };
      }
    }
  });
  return out as ResolvedStop[];
}

/**
 * The CSS gradient line for a box of size w x h, in box-local px (y down).
 * `angleDeg` is CSS's: 0 points up, 90 right. A corner direction ("to bottom
 * right") is the direction perpendicular to the diagonal that the 50% colour
 * line passes through.
 */
export function gradientAxis(
  w: number,
  h: number,
  {
    angleDeg = 180,
    corner = null,
  }: { angleDeg?: number; corner?: { sx: number; sy: number } | null } = {},
): GradientAxis {
  let dx: number;
  let dy: number;
  if (corner) {
    const norm = Math.hypot(w, h) || 1;
    dx = (corner.sx * h) / norm;
    dy = (corner.sy * w) / norm;
  } else {
    const rad = (angleDeg * Math.PI) / 180;
    dx = Math.sin(rad);
    dy = -Math.cos(rad);
  }
  const length = Math.abs(w * dx) + Math.abs(h * dy);
  const cx = w / 2;
  const cy = h / 2;
  return {
    x0: cx - (dx * length) / 2,
    y0: cy - (dy * length) / 2,
    x1: cx + (dx * length) / 2,
    y1: cy + (dy * length) / 2,
    length,
  };
}

/**
 * Four corner radii {x, y} (top-left, top-right, bottom-right, bottom-left)
 * from computed values like "12px", "50%" or "12px 24px", scaled down when
 * they would overlap, as CSS requires.
 */
export function resolveRadii(
  values: (string | null | undefined)[],
  w: number,
  h: number,
): Radii {
  const one = (value: string | null | undefined): Radius => {
    const parts = String(value ?? "0")
      .trim()
      .split(/\s+/);
    const first = parts[0] ?? "0";
    const toPx = (p: string, basis: number) =>
      p.endsWith("%") ? (parseFloat(p) / 100) * basis : parseFloat(p) || 0;
    const x = toPx(first, w);
    const second = parts[1];
    const y =
      second !== undefined
        ? toPx(second, h)
        : first.endsWith("%")
          ? toPx(first, h)
          : x;
    return { x: Math.max(0, x), y: Math.max(0, y) };
  };
  const [tl, tr, br, bl] = values.map(one) as [Radius, Radius, Radius, Radius];
  const f = Math.min(
    1,
    tl.x + tr.x > 0 ? w / (tl.x + tr.x) : 1,
    bl.x + br.x > 0 ? w / (bl.x + br.x) : 1,
    tl.y + bl.y > 0 ? h / (tl.y + bl.y) : 1,
    tr.y + br.y > 0 ? h / (tr.y + br.y) : 1,
  );
  const scale = (r: Radius): Radius => ({ x: r.x * f, y: r.y * f });
  return { tl: scale(tl), tr: scale(tr), br: scale(br), bl: scale(bl) };
}

export const hasRadius = (radii: Radii | null | undefined): boolean =>
  !!radii && Object.values(radii).some((r) => r.x > 0.01 || r.y > 0.01);

/** Shrinks radii by a border width, for the inner edge of a border. */
export function insetRadii(
  radii: Radii,
  top: number,
  right: number,
  bottom: number,
  left: number,
): Radii {
  const cut = (r: Radius, dx: number, dy: number): Radius => ({
    x: Math.max(0, r.x - dx),
    y: Math.max(0, r.y - dy),
  });
  return {
    tl: cut(radii.tl, left, top),
    tr: cut(radii.tr, right, top),
    br: cut(radii.br, right, bottom),
    bl: cut(radii.bl, left, bottom),
  };
}

/**
 * Where an image of natural size nw x nh sits inside a w x h box for a CSS
 * `object-fit` / `background-size` value, plus an `object-position`-style
 * offset. Returns the drawn rectangle relative to the box (it may overflow
 * the box for `cover`; the caller clips).
 */
export function fitImage(
  nw: number | undefined,
  nh: number | undefined,
  w: number,
  h: number,
  fit: ImageFit = "fill",
  posX = 0.5,
  posY = 0.5,
): Placement {
  if (!nw || !nh) return { x: 0, y: 0, w, h };
  let dw = w;
  let dh = h;
  if (fit === "cover" || fit === "contain") {
    const s =
      fit === "cover" ? Math.max(w / nw, h / nh) : Math.min(w / nw, h / nh);
    dw = nw * s;
    dh = nh * s;
  } else if (fit === "none") {
    dw = nw;
    dh = nh;
  } else if (fit === "scale-down") {
    const s = Math.min(1, w / nw, h / nh);
    dw = nw * s;
    dh = nh * s;
  }
  return { x: (w - dw) * posX, y: (h - dh) * posY, w: dw, h: dh };
}

/**
 * Splits a word that the browser wrapped across lines (at a hyphen, or an
 * over-long word breaking) into one fragment per visual line. The browser gives
 * such a word ONE bounding box covering both lines, so drawing it whole would
 * land every letter on the first line's left edge.
 *
 * `chars` are the per-character boxes in reading order. Characters belong to
 * the same line when their vertical midpoints sit inside the band of the
 * fragment started so far.
 *
 */
export function splitFragmentsByLine(chars: CharBox[]): Fragment[] {
  const fragments: Fragment[] = [];
  for (const c of chars) {
    if (c.right - c.left <= 0 && c.bottom - c.top <= 0) continue;
    const mid = (c.top + c.bottom) / 2;
    const last = fragments[fragments.length - 1];
    if (last && mid >= last.top && mid <= last.bottom) {
      last.text += c.ch;
      last.left = Math.min(last.left, c.left);
      last.right = Math.max(last.right, c.right);
      last.top = Math.min(last.top, c.top);
      last.bottom = Math.max(last.bottom, c.bottom);
    } else {
      fragments.push({
        text: c.ch,
        left: c.left,
        right: c.right,
        top: c.top,
        bottom: c.bottom,
      });
    }
  }
  return fragments;
}

/* ---------------------------------------------------------------------------------------------
 * Transforms, clip-path and box-shadow. Pure string / number maths, no DOM, so it is unit-testable.
 * ------------------------------------------------------------------------------------------- */

/** [a, b, c, d, e, f]: x' = a*x + c*y + e, y' = b*x + d*y + f. */
export type Matrix2D = [number, number, number, number, number, number];

/** Reads a computed `transform` (`matrix()` or `matrix3d()`); null for `none` or anything unreadable. */
export function parseTransformMatrix(value: string): Matrix2D | null {
  const v = String(value ?? "").trim();
  const m2 = v.match(/^matrix\(([^)]*)\)$/);
  if (m2) {
    const n = m2[1]!.split(",").map((t) => parseFloat(t));
    return n.length === 6 && n.every(Number.isFinite) ? (n as Matrix2D) : null;
  }
  const m3 = v.match(/^matrix3d\(([^)]*)\)$/);
  if (m3) {
    const n = m3[1]!.split(",").map((t) => parseFloat(t));
    if (n.length !== 16 || !n.every(Number.isFinite)) return null;
    return [n[0]!, n[1]!, n[4]!, n[5]!, n[12]!, n[13]!];
  }
  return null;
}

/** `translate(o) * m * translate(-o)`: the matrix that applies `m` around the point (ox, oy). */
export function matrixAbout(m: Matrix2D, ox: number, oy: number): Matrix2D {
  const [a, b, c, d, e, f] = m;
  return [
    a,
    b,
    c,
    d,
    e + ox - (a * ox + c * oy),
    f + oy - (b * ox + d * oy),
  ];
}

export function multiplyMatrix(p: Matrix2D, c: Matrix2D): Matrix2D {
  return [
    p[0] * c[0] + p[2] * c[1],
    p[1] * c[0] + p[3] * c[1],
    p[0] * c[2] + p[2] * c[3],
    p[1] * c[2] + p[3] * c[3],
    p[0] * c[4] + p[2] * c[5] + p[4],
    p[1] * c[4] + p[3] * c[5] + p[5],
  ];
}

export function invertMatrix(m: Matrix2D): Matrix2D | null {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return null;
  return [
    d / det,
    -b / det,
    -c / det,
    a / det,
    (c * f - d * e) / det,
    (b * e - a * f) / det,
  ];
}

/** A CSS length or percentage as px; NaN for anything else (calc(), var(), ...). */
function lengthPx(token: string | undefined, basis: number): number {
  const t = String(token ?? "").trim();
  if (!t) return NaN;
  if (t.endsWith("%")) return (parseFloat(t) / 100) * basis;
  if (/^-?(\d+\.?\d*|\.\d+)(px)?$/.test(t)) return parseFloat(t);
  return NaN;
}

/** `transform-origin` (computed values are px; keywords and percentages are accepted too). */
export function parseTransformOrigin(
  value: string,
  w: number,
  h: number,
): { x: number; y: number } {
  const parts = String(value || "")
    .trim()
    .split(/\s+/);
  const axis = (token: string | undefined, basis: number, fallback: number) => {
    if (token === undefined) return fallback;
    if (token === "left" || token === "top") return 0;
    if (token === "right" || token === "bottom") return basis;
    if (token === "center") return basis / 2;
    const px = lengthPx(token, basis);
    return Number.isFinite(px) ? px : fallback;
  };
  return { x: axis(parts[0], w, w / 2), y: axis(parts[1], h, h / 2) };
}

export type ClipShape = { segments: PathSegment[]; evenOdd: boolean };

const KAPPA = 0.5522847498;

function ellipsePath(cx: number, cy: number, rx: number, ry: number) {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  const segments: PathSegment[] = [
    { op: "M", x: cx + rx, y: cy },
    { op: "C", x1: cx + rx, y1: cy + ky, x2: cx + kx, y2: cy + ry, x: cx, y: cy + ry },
    { op: "C", x1: cx - kx, y1: cy + ry, x2: cx - rx, y2: cy + ky, x: cx - rx, y: cy },
    { op: "C", x1: cx - rx, y1: cy - ky, x2: cx - kx, y2: cy - ry, x: cx, y: cy - ry },
    { op: "C", x1: cx + kx, y1: cy - ry, x2: cx + rx, y2: cy - ky, x: cx + rx, y: cy },
    { op: "Z" },
  ];
  return segments;
}

function roundedRectPath(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: Radii | null,
): PathSegment[] {
  if (!r || !hasRadius(r)) {
    return [
      { op: "M", x: x0, y: y0 },
      { op: "L", x: x1, y: y0 },
      { op: "L", x: x1, y: y1 },
      { op: "L", x: x0, y: y1 },
      { op: "Z" },
    ];
  }
  const { tl, tr, br, bl } = r;
  return [
    { op: "M", x: x0 + tl.x, y: y0 },
    { op: "L", x: x1 - tr.x, y: y0 },
    { op: "C", x1: x1 - tr.x + tr.x * KAPPA, y1: y0, x2: x1, y2: y0 + tr.y - tr.y * KAPPA, x: x1, y: y0 + tr.y },
    { op: "L", x: x1, y: y1 - br.y },
    { op: "C", x1: x1, y1: y1 - br.y + br.y * KAPPA, x2: x1 - br.x + br.x * KAPPA, y2: y1, x: x1 - br.x, y: y1 },
    { op: "L", x: x0 + bl.x, y: y1 },
    { op: "C", x1: x0 + bl.x - bl.x * KAPPA, y1: y1, x2: x0, y2: y1 - bl.y + bl.y * KAPPA, x: x0, y: y1 - bl.y },
    { op: "L", x: x0, y: y0 + tl.y },
    { op: "C", x1: x0, y1: y0 + tl.y - tl.y * KAPPA, x2: x0 + tl.x - tl.x * KAPPA, y2: y0, x: x0 + tl.x, y: y0 },
    { op: "Z" },
  ];
}

/** CSS shorthand order (top, right, bottom, left) from one to four values. */
function boxValues(tokens: string[]): [string, string, string, string] {
  const [a, b = a, c = a, d = b] = tokens as [string, ...string[]];
  return [a, b, c, d];
}

/** A shape position like `50% 50%` or `left top`, as px inside a w x h box. */
function parsePoint(
  tokens: string[],
  w: number,
  h: number,
): { x: number; y: number } {
  const one = (t: string | undefined, basis: number, fallback: number) => {
    if (t === undefined) return fallback;
    if (t === "left" || t === "top") return 0;
    if (t === "right" || t === "bottom") return basis;
    if (t === "center") return basis / 2;
    const v = lengthPx(t, basis);
    return Number.isFinite(v) ? v : fallback;
  };
  // "top left" style keyword order is swapped relative to x y.
  const swap =
    (tokens[0] === "top" || tokens[0] === "bottom") &&
    (tokens[1] === "left" || tokens[1] === "right" || tokens[1] === "center");
  const [tx, ty] = swap ? [tokens[1], tokens[0]] : [tokens[0], tokens[1]];
  return { x: one(tx, w, w / 2), y: one(ty, h, h / 2) };
}

/**
 * A CSS `clip-path` basic shape (polygon, inset, circle, ellipse) as a path in px relative to the
 * element's own border box. Null for `none`, `url()`, `path()` and anything with calc()/var().
 */
export function parseClipPath(
  value: string,
  w: number,
  h: number,
): ClipShape | null {
  const v = String(value ?? "")
    .trim()
    .replace(
      /\s+(border-box|padding-box|content-box|margin-box|fill-box|stroke-box|view-box)$/,
      "",
    );
  const m = v.match(/^(polygon|inset|circle|ellipse)\(([\s\S]*)\)$/);
  if (!m) return null;
  const kind = m[1]!;
  const inner = m[2]!.trim();

  if (kind === "polygon") {
    const args = splitTopLevel(inner);
    let evenOdd = false;
    if (args[0] === "evenodd" || args[0] === "nonzero") {
      evenOdd = args.shift() === "evenodd";
    }
    const points = args.map((arg) => {
      const [x, y] = arg.split(/\s+/);
      return { x: lengthPx(x, w), y: lengthPx(y, h) };
    });
    if (
      points.length < 3 ||
      points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))
    )
      return null;
    const segments: PathSegment[] = points.map((p, i) =>
      i === 0 ? { op: "M", x: p.x, y: p.y } : { op: "L", x: p.x, y: p.y },
    );
    segments.push({ op: "Z" });
    return { segments, evenOdd };
  }

  if (kind === "inset") {
    const [edges = "", rounding = ""] = inner.split(/\s+round\s+/);
    const tokens = edges.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length || tokens.length > 4) return null;
    const [t, r, b, l] = boxValues(tokens);
    const top = lengthPx(t, h);
    const right = lengthPx(r, w);
    const bottom = lengthPx(b, h);
    const left = lengthPx(l, w);
    if (![top, right, bottom, left].every(Number.isFinite)) return null;
    const x0 = left;
    const y0 = top;
    const x1 = w - right;
    const y1 = h - bottom;
    if (x1 <= x0 || y1 <= y0) return null;
    let radii: Radii | null = null;
    if (rounding.trim()) {
      const corners = rounding.split("/")[0]!.trim().split(/\s+/);
      const [tl, tr, br, bl] = boxValues(corners);
      radii = resolveRadii([tl, tr, br, bl], x1 - x0, y1 - y0);
    }
    return { segments: roundedRectPath(x0, y0, x1, y1, radii), evenOdd: false };
  }

  const [shapePart = "", atPart = ""] = inner.split(/\s+at\s+/);
  const center = parsePoint(atPart.trim().split(/\s+/).filter(Boolean), w, h);
  const radiusTokens = shapePart.trim().split(/\s+/).filter(Boolean);

  if (kind === "circle") {
    const token = radiusTokens[0];
    const ref = Math.sqrt((w * w + h * h) / 2);
    let r: number;
    if (token === undefined || token === "closest-side") {
      r = Math.min(center.x, w - center.x, center.y, h - center.y);
    } else if (token === "farthest-side") {
      r = Math.max(center.x, w - center.x, center.y, h - center.y);
    } else {
      r = lengthPx(token, ref);
    }
    if (!Number.isFinite(r) || r <= 0) return null;
    return { segments: ellipsePath(center.x, center.y, r, r), evenOdd: false };
  }

  const axisRadius = (token: string | undefined, basis: number, side: number) => {
    if (token === undefined || token === "closest-side") return side;
    if (token === "farthest-side") return basis - side;
    return lengthPx(token, basis);
  };
  const rx = axisRadius(
    radiusTokens[0],
    w,
    Math.min(center.x, w - center.x),
  );
  const ry = axisRadius(
    radiusTokens[1],
    h,
    Math.min(center.y, h - center.y),
  );
  if (!Number.isFinite(rx) || !Number.isFinite(ry) || rx <= 0 || ry <= 0)
    return null;
  return { segments: ellipsePath(center.x, center.y, rx, ry), evenOdd: false };
}

export type ShadowSpec = {
  color: Rgba;
  dx: number;
  dy: number;
  blur: number;
  spread: number;
  inset: boolean;
};

/** A computed `box-shadow` list (`rgba(...) 0px 10px 32px 0px`, `inset` allowed), first shadow topmost. */
export function parseBoxShadows(value: string): ShadowSpec[] {
  const v = String(value ?? "").trim();
  if (!v || v === "none") return [];
  const out: ShadowSpec[] = [];
  for (const part of splitTopLevel(v)) {
    let rest = part.trim();
    let inset = false;
    if (/^inset\s/.test(rest)) {
      inset = true;
      rest = rest.replace(/^inset\s+/, "");
    }
    if (/\sinset$/.test(rest)) {
      inset = true;
      rest = rest.replace(/\s+inset$/, "");
    }
    let color = parseCssColor("rgba(0,0,0,1)");
    const fn = rest.match(/^([a-z-]+\([^)]*\))\s*/i);
    if (fn) {
      color = parseCssColor(fn[1]!);
      rest = rest.slice(fn[0].length);
    } else {
      const tail = rest.match(/\s+([a-z#][^\s]*)$/i);
      const lead = rest.match(/^([a-z#][^\s]*)\s+/i);
      if (lead && !/^-?[\d.]/.test(lead[1]!)) {
        color = parseCssColor(lead[1]!);
        rest = rest.slice(lead[0].length);
      } else if (tail && !/^-?[\d.]/.test(tail[1]!)) {
        color = parseCssColor(tail[1]!);
        rest = rest.slice(0, rest.length - tail[0].length);
      }
    }
    if (fn === null && rest.match(/rgba?\(/)) {
      const trailing = rest.match(/(rgba?\([^)]*\))\s*$/i);
      if (trailing) {
        color = parseCssColor(trailing[1]!);
        rest = rest.slice(0, trailing.index).trim();
      }
    }
    const nums = rest
      .trim()
      .split(/\s+/)
      .map((t) => parseFloat(t))
      .filter((n) => Number.isFinite(n));
    if (nums.length < 2) continue;
    out.push({
      color,
      dx: nums[0]!,
      dy: nums[1]!,
      blur: Math.max(0, nums[2] ?? 0),
      spread: nums[3] ?? 0,
      inset,
    });
  }
  return out;
}

/** Corner radii grown by a shadow's spread (a square corner stays square). */
export function growRadii(r: Radii, by: number): Radii {
  const grow = (c: Radius): Radius => ({
    x: c.x > 0 ? Math.max(0, c.x + by) : 0,
    y: c.y > 0 ? Math.max(0, c.y + by) : 0,
  });
  return { tl: grow(r.tl), tr: grow(r.tr), br: grow(r.br), bl: grow(r.bl) };
}

/** The standard normal cumulative distribution (Abramowitz-Stegun 7.1.26 on erf). */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const erf =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/**
 * Stacked shapes that imitate a gaussian-blurred box-shadow edge. `grow` is how far each shape's
 * edge sits beyond the shadow's own edge (negative = inside it); `alpha` is that layer's share of
 * the shadow's opacity. The CSS blur radius is a gaussian with sigma = blur / 2.
 */
export function shadowLayers(
  blur: number,
  opacity: number,
): { grow: number; alpha: number }[] {
  if (blur < 0.5) return [{ grow: 0, alpha: opacity }];
  const sigma = blur / 2;
  const n = blur <= 4 ? 2 : blur <= 16 ? 4 : 6;
  const span = 2 * sigma;
  const grows = Array.from({ length: n }, (_, i) => -span + (2 * span * i) / (n - 1));
  const step = (2 * span) / (n - 1);
  // Opacity wanted just inside the edge of layer k, i.e. with layers k..n-1 stacked.
  const wanted = (k: number): number => {
    const mid = grows[k]! - step / 2;
    return opacity * normalCdf(-mid / sigma);
  };
  const out: { grow: number; alpha: number }[] = [];
  for (let k = 0; k < n; k++) {
    const stacked = wanted(k);
    const above = k + 1 < n ? wanted(k + 1) : 0;
    const alpha = stacked - above;
    if (alpha > 0.0005) out.push({ grow: grows[k]!, alpha });
  }
  return out;
}

export type AlphaBand = { from: number; to: number; alpha: number };

/**
 * A gradient whose stops all share one colour (only the opacity changes, like `black/60 -> transparent`)
 * as a short list of flat bands along the gradient line (0 = start, 1 = end). Such a gradient can be
 * drawn as a few constant-opacity vector shapes, which a PDF viewer scrolls far more smoothly than
 * a bitmap with a soft mask. Null when the stops differ in colour.
 */
export function alphaOnlyBands(
  stops: ResolvedStop[],
  maxBands = 48,
): { color: Rgba; bands: AlphaBand[]; maxAlpha: number } | null {
  if (stops.length < 2) return null;
  const visible = stops.filter((st) => st.color.a > 0.0005);
  if (!visible.length) return null;
  const ref = visible[0]!.color;
  const same = (c: Rgba) =>
    Math.abs(c.r - ref.r) < 1.5 / 255 &&
    Math.abs(c.g - ref.g) < 1.5 / 255 &&
    Math.abs(c.b - ref.b) < 1.5 / 255;
  if (!stops.every((st) => st.color.a <= 0.0005 || same(st.color))) return null;

  const maxAlpha = Math.max(...stops.map((st) => st.color.a));
  const at = (t: number): number => {
    if (t <= stops[0]!.pos) return stops[0]!.color.a;
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1]!;
      const b = stops[i]!;
      if (t <= b.pos) {
        const span = b.pos - a.pos;
        if (span <= 1e-9) return b.color.a;
        return a.color.a + ((b.color.a - a.color.a) * (t - a.pos)) / span;
      }
    }
    return stops[stops.length - 1]!.color.a;
  };

  // Band edges: every stop position plus an even grid fine enough for ~1% opacity steps.
  const n = Math.min(maxBands, Math.max(3, Math.ceil(maxAlpha / 0.012)));
  const edges = new Set<number>([0, 1]);
  for (let i = 1; i < n; i++) edges.add(i / n);
  for (const st of stops) edges.add(Math.min(1, Math.max(0, st.pos)));
  const sorted = [...edges].sort((a, b) => a - b);

  const bands: AlphaBand[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const from = sorted[i]!;
    const to = sorted[i + 1]!;
    if (to - from < 1e-6) continue;
    const alpha = at((from + to) / 2);
    const last = bands[bands.length - 1];
    if (last && Math.abs(last.alpha - alpha) < 0.006 && Math.abs(last.to - from) < 1e-6) {
      last.to = to;
      continue;
    }
    bands.push({ from, to, alpha });
  }
  return {
    color: { r: ref.r, g: ref.g, b: ref.b, a: 1 },
    bands: bands.filter((b) => b.alpha > 0.002),
    maxAlpha,
  };
}
