/**
 * layout-types.ts
 *
 * The paint primitives the layout extractor produces and the layout writer
 * draws. All geometry is in CSS px relative to the root's top-left corner.
 */

import type { Rgba } from "./color.js";
import type { Radii } from "./layout-math.js";
import type { PathSegment } from "./svg-path.js";
import type { AvoidBand } from "./page-breaker.js";
import type { RunStyle } from "./font-registry.js";

export type Rect = { x: number; y: number; w: number; h: number };

export type RectPrim = Rect & {
  type: "rect";
  radii: Radii | null;
  color: Rgba;
  alpha: number;
};

export type GradientPrim = Rect & {
  type: "gradient";
  radii: Radii | null;
  alpha: number;
  axis: { x0: number; y0: number; x1: number; y1: number };
  stops: { pos: number; color: Rgba }[];
};

/**
 * A gradient that only changes opacity (one colour), drawn as flat translucent vector bands so it
 * stays cheap to scroll in a PDF viewer. `shape` "linear" runs along `axis`; "radial" grows from the
 * centre of the box to its farthest corner. Band positions are 0..1 along that line.
 */
export type AlphaGradientPrim = Rect & {
  type: "alpha-gradient";
  radii: Radii | null;
  alpha: number;
  color: Rgba;
  shape: "linear" | "radial";
  axis: { x0: number; y0: number; x1: number; y1: number };
  bands: { from: number; to: number; alpha: number }[];
};

export type BorderSide = { w: number; kind: string; color: Rgba };

export type BorderPrim = Rect & {
  type: "border";
  radii: Radii | null;
  alpha: number;
  /** top, right, bottom, left */
  sides: BorderSide[];
};

export type ImagePrim = Rect & {
  type: "image";
  radii: Radii | null;
  alpha: number;
  /** a URL to fetch, or already-encoded PNG bytes */
  src?: string;
  bytes?: Uint8Array;
  naturalW?: number;
  naturalH?: number;
  fit: string;
  posX?: number;
  posY?: number;
  /** tell the viewer to smooth this image when scaling up (low-resolution gradients) */
  smooth?: boolean;
};

export type TextInfo = RunStyle & {
  fontSizePt: number;
  color: Rgba;
  ascent: number;
  letterSpacingPt: number;
  transform: string;
  underline: boolean;
  visible: boolean;
};

export type TextPrim = Rect & {
  type: "text";
  text: string;
  baseline: number;
  style: TextInfo;
  alpha: number;
};

/** [a, b, c, d, e, f]: x' = a*x + c*y + e, y' = b*x + d*y + f (the SVG / PDF convention). */
export type Matrix = [number, number, number, number, number, number];

export type VectorShape = {
  segments: PathSegment[];
  /** shape -> SVG user space */
  matrix: Matrix;
  fill: Rgba | null;
  stroke: Rgba | null;
  strokeWidth: number;
  cap: "butt" | "round" | "square";
  join: "miter" | "round" | "bevel";
  evenOdd: boolean;
  dash: number[] | null;
  /** combined opacity of this shape (element opacity x fill/stroke opacity) */
  opacity: number;
};

/** An inline <svg> drawn as real vector paths instead of a picture. */
export type VectorPrim = Rect & {
  type: "vector";
  alpha: number;
  /** SVG user space -> CSS px relative to the root: px = sx*x + tx, py = sy*y + ty */
  userToPx: { sx: number; sy: number; tx: number; ty: number };
  shapes: VectorShape[];
};

/**
 * An outer box-shadow, drawn as a few stacked translucent shapes that fake the blur (cheap for a
 * viewer to scroll, unlike a bitmap). `x/y/w/h` is the element's own box, which is cut out of the
 * shadow so it never shows through a translucent background.
 */
export type ShadowPrim = Rect & {
  type: "shadow";
  /** the element's corner radii */
  radii: Radii | null;
  dx: number;
  dy: number;
  /** spread plus the layer's growth beyond the box, in px (negative shrinks) */
  layers: { grow: number; alpha: number }[];
  color: Rgba;
  alpha: number;
  /**
   * True when the element can be see-through, so its own box must be cut out of the shadow (a clip).
   * An opaque element hides whatever is under it, so each layer is just a ring around the box, which
   * is far cheaper for a viewer to draw than a full-size translucent fill.
   */
  cutout: boolean;
};

export type LinkPrim = Rect & { type: "link"; href: string; alpha: number };
export type ClipStartPrim = Rect & { type: "clip-start"; radii: Radii | null };
export type ClipEndPrim = { type: "clip-end" };

/**
 * Starts a CSS `transform`. `matrix` maps points of the untransformed layout (CSS px, relative to the
 * root, y down) to where the element really ends up, with the transform-origin already folded in.
 * Everything up to the matching `transform-end` is drawn through it.
 */
export type TransformStartPrim = Rect & {
  type: "transform-start";
  matrix: Matrix;
};
export type TransformEndPrim = { type: "transform-end" };

/** Starts a CSS `clip-path`: everything up to the matching `shape-clip-end` is clipped to this path (CSS px). */
export type ShapeClipStartPrim = Rect & {
  type: "shape-clip-start";
  segments: PathSegment[];
  evenOdd: boolean;
};
export type ShapeClipEndPrim = { type: "shape-clip-end" };

export type Prim =
  | AlphaGradientPrim
  | ShadowPrim
  | VectorPrim
  | RectPrim
  | GradientPrim
  | BorderPrim
  | ImagePrim
  | TextPrim
  | LinkPrim
  | ClipStartPrim
  | ClipEndPrim
  | TransformStartPrim
  | TransformEndPrim
  | ShapeClipStartPrim
  | ShapeClipEndPrim;

/** Prims that only open or close a scope; they draw nothing themselves. */
export const isScopePrim = (
  p: Prim,
): p is ClipEndPrim | TransformEndPrim | ShapeClipEndPrim =>
  p.type === "clip-end" ||
  p.type === "transform-end" ||
  p.type === "shape-clip-end";

export type Layout = {
  prims: Prim[];
  avoid: AvoidBand[];
  width: number;
  height: number;
  /** Effects the page uses that are not drawn (inset shadows, filters...). Informational, not errors. */
  notes: string[];
};
