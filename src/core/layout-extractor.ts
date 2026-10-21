/**
 * layout-extractor.ts
 *
 * DOM -> a flat, ordered list of paint primitives at their REAL positions
 * (CSS px, relative to the root's top-left). This is what the layout-preserving
 * mode draws from: backgrounds, gradients, borders, rounded clips, images, SVG
 * icons, links and text, in paint order.
 *
 * Nothing here decides pagination or touches PDF objects. It only reads what the
 * browser already laid out, so it works at whatever width the root was rendered
 * at. CSS transforms, clip-path shapes and outer box-shadows are drawn too. Effects that are still
 * unsupported (inset shadows, filters, pseudo-elements) are skipped and reported once in `notes`,
 * never silently drawn wrong.
 */

import { parseCssColor } from "./color.js";
import {
  alphaOnlyBands,
  gradientAxis,
  growRadii,
  matrixAbout,
  parseBoxShadows,
  parseClipPath,
  parseGradient,
  parseTransformMatrix,
  parseTransformOrigin,
  resolveRadii,
  resolveStops,
  shadowLayers,
  splitFragmentsByLine,
  splitTopLevel,
  type CharBox,
  type Fragment,
  type Radii,
} from "./layout-math.js";
import type { AvoidBand } from "./page-breaker.js";
import { parseSvgPath } from "./svg-path.js";
import {
  isScopePrim,
  type Layout,
  type Matrix,
  type Prim,
  type Rect,
  type TextInfo,
  type VectorPrim,
  type VectorShape,
} from "./layout-types.js";

const PX_TO_PT = 72 / 96;

type Win = Window & typeof globalThis;

const ascentCache = new Map<string, number>();
let ascentCtx: CanvasRenderingContext2D | null = null;
function ascentOf(style: CSSStyleDeclaration): number {
  const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const hit = ascentCache.get(font);
  if (hit !== undefined) return hit;
  const size = parseFloat(style.fontSize);
  let ascent = size * 0.8;
  try {
    ascentCtx ||= document.createElement("canvas").getContext("2d");
    if (ascentCtx) {
      ascentCtx.font = font;
      const m = ascentCtx.measureText("Hxg");
      ascent = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent ?? ascent;
    }
  } catch {
    /* keep the estimate */
  }
  ascentCache.set(font, ascent);
  return ascent;
}

const css = (style: CSSStyleDeclaration, name: string): string =>
  style.getPropertyValue(name);

function transformText(text: string, mode: string): string {
  if (mode === "uppercase") return text.toUpperCase();
  if (mode === "lowercase") return text.toLowerCase();
  if (mode === "capitalize")
    return text.replace(
      /(^|[\s\-"'(])(\p{L})/gu,
      (_, a: string, b: string) => a + b.toUpperCase(),
    );
  return text;
}

async function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) throw new Error("canvas.toBlob returned nothing");
  return new Uint8Array(await blob.arrayBuffer());
}

export type ExtractOptions = {
  /** Elements matching this selector (and their contents) are left out of the PDF. */
  skip?: string;
};

export async function analyzeLayout(
  root: Element,
  options: ExtractOptions = {},
): Promise<Layout> {
  const doc = root.ownerDocument;
  const win = doc.defaultView as Win;
  const rootRect = root.getBoundingClientRect();
  const ox = rootRect.left;
  const oy = rootRect.top;

  const prims: Prim[] = [];
  const avoid: AvoidBand[] = [];
  const notes: string[] = [];
  const noted = new Set<string>();
  const noteOnce = (key: string, message: string) => {
    if (noted.has(key)) return;
    noted.add(key);
    notes.push(message);
  };

  const rel = (r: {
    left: number;
    top: number;
    width: number;
    height: number;
  }): Rect => ({
    x: r.left - ox,
    y: r.top - oy,
    w: r.width,
    h: r.height,
  });
  const textStyleCache = new WeakMap<Element, TextInfo>();

  function textStyle(el: Element): TextInfo {
    const hit = textStyleCache.get(el);
    if (hit) return hit;
    const s = win.getComputedStyle(el);
    const ls = parseFloat(s.letterSpacing);
    const info: TextInfo = {
      fontSizePt: parseFloat(s.fontSize) * PX_TO_PT,
      bold: Number(s.fontWeight) >= 600 || s.fontWeight === "bold",
      italic: s.fontStyle === "italic",
      fontFamily: s.fontFamily,
      fontWeight: s.fontWeight,
      color: parseCssColor(s.color),
      ascent: ascentOf(s),
      letterSpacingPt: Number.isFinite(ls) ? ls * PX_TO_PT : 0,
      transform: s.textTransform,
      underline: (s.textDecorationLine || "").includes("underline"),
      visible: s.visibility !== "hidden",
    };
    textStyleCache.set(el, info);
    return info;
  }

  function emitText(node: Text, el: Element, alpha: number): void {
    const info = textStyle(el);
    if (!info.visible) return;
    const text = node.textContent ?? "";
    const range = doc.createRange();
    const wordRegex = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = wordRegex.exec(text))) {
      const word = m[0];
      range.setStart(node, m.index);
      range.setEnd(node, m.index + word.length);
      const r = range.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;

      // A word wrapped across lines (at a hyphen, say) has one bounding box
      // spanning both. Measure it character by character and draw one fragment
      // per line, each at its own position.
      let pieces: Fragment[] = [
        {
          text: word,
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
        },
      ];
      const lineRects = Array.from(range.getClientRects()).filter(
        (c) => c.width > 0 || c.height > 0,
      );
      const wrapped =
        lineRects.length > 1 &&
        r.height > Math.min(...lineRects.map((c) => c.height)) * 1.5;
      if (wrapped) {
        const chars: CharBox[] = [];
        const charRange = doc.createRange();
        for (let i = 0; i < word.length; i++) {
          charRange.setStart(node, m.index + i);
          charRange.setEnd(node, m.index + i + 1);
          const c = charRange.getBoundingClientRect();
          chars.push({
            ch: word[i]!,
            left: c.left,
            right: c.right,
            top: c.top,
            bottom: c.bottom,
          });
        }
        const split = splitFragmentsByLine(chars);
        if (split.length > 1) pieces = split;
      }

      for (const piece of pieces) {
        const box = rel({
          left: piece.left,
          top: piece.top,
          width: piece.right - piece.left,
          height: piece.bottom - piece.top,
        });
        prims.push({
          type: "text",
          text: transformText(piece.text, info.transform),
          ...box,
          baseline: box.y + info.ascent,
          style: info,
          alpha,
        });
        avoid.push({ top: box.y, bottom: box.y + box.h });
      }
    }
  }

  async function loadImage(src: string): Promise<HTMLImageElement> {
    const img = new win.Image();
    img.crossOrigin = "anonymous";
    img.src = src;
    try {
      await img.decode();
    } catch {
      /* decode() rejects for some valid cross-origin images; fall through to the size check */
    }
    return img;
  }

  function radiiOf(style: CSSStyleDeclaration, box: Rect): Radii {
    return resolveRadii(
      [
        css(style, "border-top-left-radius"),
        css(style, "border-top-right-radius"),
        css(style, "border-bottom-right-radius"),
        css(style, "border-bottom-left-radius"),
      ],
      box.w,
      box.h,
    );
  }

  function parsePosition(value: string | undefined): { x: number; y: number } {
    const parts = String(value || "")
      .trim()
      .split(/\s+/);
    const one = (p: string | undefined, fallback: number): number => {
      if (p === undefined) return fallback;
      if (p === "left" || p === "top") return 0;
      if (p === "right" || p === "bottom") return 1;
      if (p === "center") return 0.5;
      if (p.endsWith("%")) return parseFloat(p) / 100;
      return fallback;
    };
    return { x: one(parts[0], 0.5), y: one(parts[1], 0.5) };
  }

  async function emitBackgroundLayers(
    style: CSSStyleDeclaration,
    box: Rect,
    radii: Radii,
    alpha: number,
  ): Promise<void> {
    const layers = splitTopLevel(css(style, "background-image") || "none");
    const sizes = splitTopLevel(css(style, "background-size") || "auto");
    const positions = splitTopLevel(
      css(style, "background-position") || "0% 0%",
    );

    // CSS lists the TOP layer first; paint bottom-up.
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      if (!layer || layer === "none") continue;

      const grad = parseGradient(layer);
      if (grad) {
        if (layer.startsWith("repeating-"))
          noteOnce(
            "repeating",
            "repeating gradients are drawn as plain gradients",
          );
        if (grad.kind !== "linear")
          noteOnce(
            grad.kind,
            `${grad.kind} gradients are approximated by a centred ellipse`,
          );
        const axis =
          grad.kind === "linear"
            ? gradientAxis(box.w, box.h, {
                angleDeg: grad.angleDeg ?? 180,
                corner: grad.corner,
              })
            : null;
        const stops = resolveStops(
          grad.stops,
          axis ? axis.length : Math.hypot(box.w, box.h) / 2,
        );
        const translucent = stops.some((s) => s.color.a < 0.999);

        // A gradient that only fades one colour in or out is drawn as a few flat translucent vector
        // bands: a bitmap with a soft mask per card makes long PDFs stutter in a viewer.
        const flat = translucent ? alphaOnlyBands(stops) : null;
        // A tint under about 3% opacity is invisible; skip it rather than make the viewer draw it.
        if (flat && flat.maxAlpha < 0.03) continue;
        if (
          flat &&
          grad.kind !== "conic" &&
          (flat.maxAlpha <= 0.12 || flat.bands.length <= 4)
        ) {
          prims.push({
            type: "alpha-gradient",
            ...box,
            radii,
            alpha,
            color: flat.color,
            shape: grad.kind === "linear" ? "linear" : "radial",
            axis: axis
              ? {
                  x0: box.x + axis.x0,
                  y0: box.y + axis.y0,
                  x1: box.x + axis.x1,
                  y1: box.y + axis.y1,
                }
              : { x0: 0, y0: 0, x1: 0, y1: 0 },
            bands: flat.bands,
          });
          continue;
        }

        if (axis && !translucent) {
          prims.push({
            type: "gradient",
            ...box,
            radii,
            alpha,
            axis: {
              x0: box.x + axis.x0,
              y0: box.y + axis.y0,
              x1: box.x + axis.x1,
              y1: box.y + axis.y1,
            },
            stops: stops.map((s) => ({ pos: s.pos, color: s.color })),
          });
        } else {
          // Alpha (or a non-linear shape) cannot be a PDF axial shading, so draw
          // the gradient to a canvas with exactly CSS semantics and embed that.
          // A smooth gradient needs only a few hundred pixels (the viewer smooths it up), and a
          // large transparent bitmap is the costliest thing a PDF viewer has to draw. A gradient
          // with a hard colour edge keeps more resolution so the edge stays sharp.
          const hardEdge = stops.some(
            (st, i) => i > 0 && Math.abs(st.pos - stops[i - 1]!.pos) < 0.002,
          );
          const cap = hardEdge ? 1000 : 320;
          const scale = Math.min(2, cap / Math.max(box.w, box.h, 1));
          const cw = Math.max(1, Math.round(box.w * scale));
          const ch = Math.max(1, Math.round(box.h * scale));
          const canvas = doc.createElement("canvas");
          canvas.width = cw;
          canvas.height = ch;
          const ctx = canvas.getContext("2d")!;
          const g = axis
            ? ctx.createLinearGradient(
                axis.x0 * scale,
                axis.y0 * scale,
                axis.x1 * scale,
                axis.y1 * scale,
              )
            : ctx.createRadialGradient(
                cw / 2,
                ch / 2,
                0,
                cw / 2,
                ch / 2,
                Math.hypot(cw / 2, ch / 2),
              );
          for (const s of stops) {
            const c = s.color;
            g.addColorStop(
              Math.min(1, Math.max(0, s.pos)),
              `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a})`,
            );
          }
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, cw, ch);
          try {
            prims.push({
              type: "image",
              ...box,
              radii,
              alpha,
              bytes: await canvasToPng(canvas),
              fit: "fill",
              smooth: true,
            });
          } catch (err) {
            noteOnce(
              "gradient-raster",
              `could not rasterise a gradient: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        continue;
      }

      const url = layer.match(/^url\((['"]?)(.*?)\1\)$/);
      if (url) {
        const img = await loadImage(url[2]!);
        if (!img.naturalWidth) {
          noteOnce(`bg:${url[2]}`, `could not load background image ${url[2]}`);
          continue;
        }
        const size = (sizes[i % sizes.length] || "auto").trim();
        const pos = parsePosition(positions[i % positions.length]);
        const fit =
          size === "cover"
            ? "cover"
            : size === "contain"
              ? "contain"
              : size === "100% 100%"
                ? "fill"
                : "cover";
        prims.push({
          type: "image",
          ...box,
          radii,
          alpha,
          src: img.currentSrc || img.src,
          naturalW: img.naturalWidth,
          naturalH: img.naturalHeight,
          fit,
          posX: pos.x,
          posY: pos.y,
        });
        continue;
      }

      noteOnce(
        "bg-layer",
        `unsupported background layer: ${layer.slice(0, 60)}`,
      );
    }
  }

  function emitBorder(
    style: CSSStyleDeclaration,
    box: Rect,
    radii: Radii,
    alpha: number,
  ): void {
    const sides = (["top", "right", "bottom", "left"] as const).map((side) => {
      const w = parseFloat(css(style, `border-${side}-width`)) || 0;
      const kind = css(style, `border-${side}-style`);
      const color = parseCssColor(css(style, `border-${side}-color`));
      return { w: kind === "none" || kind === "hidden" ? 0 : w, kind, color };
    });
    if (sides.every((s) => s.w === 0 || s.color.a === 0)) return;
    prims.push({ type: "border", ...box, radii, alpha, sides });
  }

  async function emitDecoration(
    style: CSSStyleDeclaration,
    box: Rect,
    alpha: number,
  ): Promise<Radii> {
    const radii = radiiOf(style, box);
    emitShadows(style, box, radii, alpha);
    const bg = parseCssColor(css(style, "background-color"));
    if (bg.a > 0) prims.push({ type: "rect", ...box, radii, color: bg, alpha });
    await emitBackgroundLayers(style, box, radii, alpha);
    emitBorder(style, box, radii, alpha);
    return radii;
  }

  /**
   * Outer box-shadows, painted under the element (CSS paints the first shadow on top). A shadow with no
   * blur is a crisp shape (rings and hard shadows). A blurred one is a few stacked translucent shapes
   * that imitate the gaussian falloff: still vector, so a long document stays smooth to scroll in a
   * PDF viewer (a bitmap per card is what makes viewers stutter).
   */
  function emitShadows(
    style: CSSStyleDeclaration,
    box: Rect,
    radii: Radii,
    alpha: number,
  ): void {
    const shadows = parseBoxShadows(css(style, "box-shadow"));
    if (!shadows.length) return;
    for (let i = shadows.length - 1; i >= 0; i--) {
      const sh = shadows[i]!;
      if (sh.inset) {
        noteOnce("inset-shadow", "inset box-shadows are not drawn");
        continue;
      }
      if (sh.color.a <= 0.001) continue;
      // A hairline shadow (`0 1px 2px` at a few percent) is below what any screen or printer shows,
      // yet costs the viewer several fills per card. Leave it out.
      if (sh.color.a <= 0.06 && sh.blur <= 4 && sh.spread <= 0) continue;
      if (box.w + sh.spread * 2 <= 0 || box.h + sh.spread * 2 <= 0) continue;

      if (sh.blur < 0.5 && sh.dx === 0 && sh.dy === 0 && sh.spread > 0) {
        // A ring: only the band around the box, so a translucent box is not tinted.
        const side = { w: sh.spread, kind: "solid", color: sh.color };
        prims.push({
          type: "border",
          x: box.x - sh.spread,
          y: box.y - sh.spread,
          w: box.w + sh.spread * 2,
          h: box.h + sh.spread * 2,
          radii: growRadii(radii, sh.spread),
          alpha,
          sides: [side, side, side, side],
        });
        continue;
      }

      prims.push({
        type: "shadow",
        ...box,
        radii,
        dx: sh.dx,
        dy: sh.dy,
        layers: shadowLayers(sh.blur, 1).map((l) => ({
          grow: sh.spread + l.grow,
          alpha: l.alpha,
        })),
        color: { ...sh.color, a: 1 },
        alpha: alpha * sh.color.a,
        cutout: parseCssColor(css(style, "background-color")).a < 0.98,
      });
    }
  }

  function emitImage(
    el: HTMLImageElement,
    style: CSSStyleDeclaration,
    box: Rect,
    alpha: number,
  ): void {
    const src = el.currentSrc || el.src;
    if (!src || !el.naturalWidth) {
      noteOnce(
        `img:${src}`,
        `skipped an image that did not load: ${String(src).slice(0, 80)}`,
      );
      return;
    }
    const pos = parsePosition(css(style, "object-position"));
    prims.push({
      type: "image",
      ...box,
      radii: radiiOf(style, box),
      alpha,
      src,
      naturalW: el.naturalWidth,
      naturalH: el.naturalHeight,
      fit: css(style, "object-fit") || "fill",
      posX: pos.x,
      posY: pos.y,
    });
    avoid.push({ top: box.y, bottom: box.y + box.h });
  }

  const SVG_SKIP = new Set([
    "defs",
    "title",
    "desc",
    "metadata",
    "style",
    "script",
  ]);
  // Things a vector conversion does not handle; an <svg> using any of them is drawn as a picture instead.
  const SVG_UNSUPPORTED = new Set([
    "use",
    "image",
    "text",
    "tspan",
    "textpath",
    "foreignobject",
    "symbol",
    "switch",
    "pattern",
    "marker",
    "lineargradient",
    "radialgradient",
    "mask",
    "clippath",
    "filter",
  ]);
  const MAX_SHAPES = 600;

  const compose = (p: Matrix, c: Matrix): Matrix => [
    p[0] * c[0] + p[2] * c[1],
    p[1] * c[0] + p[3] * c[1],
    p[0] * c[2] + p[2] * c[3],
    p[1] * c[2] + p[3] * c[3],
    p[0] * c[4] + p[2] * c[5] + p[4],
    p[1] * c[4] + p[3] * c[5] + p[5],
  ];

  function shapePath(el: Element): string | null {
    const num = (name: string) => parseFloat(el.getAttribute(name) ?? "0") || 0;
    switch (el.localName.toLowerCase()) {
      case "path":
        return el.getAttribute("d");
      case "circle": {
        const cx = num("cx"),
          cy = num("cy"),
          r = num("r");
        return r > 0
          ? `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`
          : null;
      }
      case "ellipse": {
        const cx = num("cx"),
          cy = num("cy"),
          rx = num("rx"),
          ry = num("ry");
        return rx > 0 && ry > 0
          ? `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0z`
          : null;
      }
      case "rect": {
        const x = num("x"),
          y = num("y"),
          w = num("width"),
          h = num("height");
        if (w <= 0 || h <= 0) return null;
        let rx = el.hasAttribute("rx") ? num("rx") : num("ry");
        let ry = el.hasAttribute("ry") ? num("ry") : rx;
        rx = Math.min(rx, w / 2);
        ry = Math.min(ry, h / 2);
        if (!rx || !ry) return `M${x} ${y}h${w}v${h}h${-w}z`;
        return `M${x + rx} ${y}h${w - 2 * rx}a${rx} ${ry} 0 0 1 ${rx} ${ry}v${h - 2 * ry}a${rx} ${ry} 0 0 1 ${-rx} ${ry}h${-(w - 2 * rx)}a${rx} ${ry} 0 0 1 ${-rx} ${-ry}v${-(h - 2 * ry)}a${rx} ${ry} 0 0 1 ${rx} ${-ry}z`;
      }
      case "line":
        return `M${num("x1")} ${num("y1")}L${num("x2")} ${num("y2")}`;
      case "polyline":
      case "polygon": {
        const pts = (el.getAttribute("points") ?? "")
          .trim()
          .split(/[\s,]+/)
          .map(Number);
        if (pts.length < 4 || pts.some((n) => !Number.isFinite(n))) return null;
        let d = `M${pts[0]} ${pts[1]}`;
        for (let i = 2; i + 1 < pts.length; i += 2)
          d += `L${pts[i]} ${pts[i + 1]}`;
        return el.localName.toLowerCase() === "polygon" ? `${d}z` : d;
      }
      default:
        return null;
    }
  }

  /** Converts an inline <svg> to vector shapes, or returns null when it uses something unsupported. */
  function buildVector(
    svg: Element,
    box: Rect,
    alpha: number,
  ): VectorPrim | null {
    const shapes: VectorShape[] = [];
    let ok = true;

    const walk = (node: Element, parent: Matrix, parentOpacity: number) => {
      for (const child of Array.from(node.children)) {
        if (!ok) return;
        const tag = child.localName.toLowerCase();
        if (SVG_SKIP.has(tag)) continue;
        if (SVG_UNSUPPORTED.has(tag)) {
          ok = false;
          return;
        }
        const clipAttr = child.getAttribute("clip-path");
        const maskAttr = child.getAttribute("mask");
        const filterAttr = child.getAttribute("filter");
        if (
          (clipAttr && clipAttr !== "none") ||
          (maskAttr && maskAttr !== "none") ||
          (filterAttr && filterAttr !== "none")
        ) {
          ok = false;
          return;
        }

        const cs = win.getComputedStyle(child);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        const opacity = parentOpacity * (parseFloat(cs.opacity) || 0);
        if (opacity <= 0.001) continue;

        let matrix = parent;
        const list = (child as SVGGraphicsElement).transform?.baseVal;
        if (list && list.numberOfItems > 0) {
          const m = list.consolidate()?.matrix;
          if (m) matrix = compose(parent, [m.a, m.b, m.c, m.d, m.e, m.f]);
        }

        if (tag === "g" || tag === "a") {
          walk(child, matrix, opacity);
          continue;
        }

        const d = shapePath(child);
        if (d === null) {
          if (
            [
              "path",
              "circle",
              "ellipse",
              "rect",
              "line",
              "polyline",
              "polygon",
            ].includes(tag)
          )
            continue; // empty shape
          ok = false; // an element this converter does not know
          return;
        }

        if (cs.fill.startsWith("url(") || cs.stroke.startsWith("url(")) {
          ok = false;
          return;
        }
        const fill = cs.fill === "none" ? null : parseCssColor(cs.fill);
        const strokeColor =
          cs.stroke === "none" ? null : parseCssColor(cs.stroke);
        const strokeWidth = parseFloat(cs.strokeWidth) || 0;
        const stroke = strokeColor && strokeWidth > 0 ? strokeColor : null;
        if (!fill && !stroke) continue;

        let segments;
        try {
          segments = parseSvgPath(d);
        } catch {
          ok = false;
          return;
        }
        if (!segments.length) continue;

        const fillOpacity = (parseFloat(cs.fillOpacity) || 0) * (fill?.a ?? 1);
        const strokeOpacity =
          (parseFloat(cs.strokeOpacity) || 0) * (stroke?.a ?? 1);
        const dash =
          cs.strokeDasharray && cs.strokeDasharray !== "none"
            ? cs.strokeDasharray
                .split(/[\s,]+/)
                .map(parseFloat)
                .filter((n) => Number.isFinite(n))
            : [];
        shapes.push({
          segments,
          matrix,
          fill: fill ? { r: fill.r, g: fill.g, b: fill.b, a: 1 } : null,
          stroke: stroke
            ? { r: stroke.r, g: stroke.g, b: stroke.b, a: 1 }
            : null,
          strokeWidth,
          cap:
            cs.strokeLinecap === "round"
              ? "round"
              : cs.strokeLinecap === "square"
                ? "square"
                : "butt",
          join:
            cs.strokeLinejoin === "round"
              ? "round"
              : cs.strokeLinejoin === "bevel"
                ? "bevel"
                : "miter",
          evenOdd: cs.fillRule === "evenodd",
          dash: dash.length ? dash : null,
          opacity: opacity * (fill ? fillOpacity : strokeOpacity),
        });
        if (shapes.length > MAX_SHAPES) {
          ok = false;
          return;
        }
      }
    };

    walk(svg, [1, 0, 0, 1, 0, 0], 1);
    if (!ok || !shapes.length) return null;

    // SVG user space -> the element's box (viewBox scaling, centred unless preserveAspectRatio="none").
    const vb = (svg as SVGSVGElement).viewBox?.baseVal;
    const vbX = vb && vb.width > 0 ? vb.x : 0;
    const vbY = vb && vb.height > 0 ? vb.y : 0;
    const vbW = vb && vb.width > 0 ? vb.width : box.w;
    const vbH = vb && vb.height > 0 ? vb.height : box.h;
    const stretch = (svg.getAttribute("preserveAspectRatio") ?? "")
      .trim()
      .startsWith("none");
    const sx = stretch ? box.w / vbW : Math.min(box.w / vbW, box.h / vbH);
    const sy = stretch ? box.h / vbH : sx;
    const offX = stretch ? 0 : (box.w - vbW * sx) / 2;
    const offY = stretch ? 0 : (box.h - vbH * sy) / 2;

    return {
      type: "vector",
      ...box,
      alpha,
      userToPx: {
        sx,
        sy,
        tx: box.x + offX - vbX * sx,
        ty: box.y + offY - vbY * sy,
      },
      shapes,
    };
  }

  async function emitSvg(
    el: Element,
    style: CSSStyleDeclaration,
    box: Rect,
    alpha: number,
  ): Promise<void> {
    if (box.w < 1 || box.h < 1) return;

    const vector = buildVector(el, box, alpha);
    if (vector) {
      prims.push(vector);
      avoid.push({ top: box.y, bottom: box.y + box.h });
      return;
    }

    // Anything the vector conversion does not handle (gradients, masks, text, <use>) is drawn as a picture.
    noteOnce(
      "svg-raster",
      "some SVGs use features that cannot be drawn as vectors, so they were embedded as pictures",
    );
    try {
      const clone = el.cloneNode(true) as SVGElement;
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      clone.setAttribute("width", String(box.w));
      clone.setAttribute("height", String(box.h));
      clone.style.color = style.color;
      clone.removeAttribute("class");
      const markup = new win.XMLSerializer().serializeToString(clone);
      const img = new win.Image();
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
      await img.decode();
      const scale = Math.max(1, Math.min(3, 1000 / Math.max(box.w, box.h, 1)));
      const canvas = doc.createElement("canvas");
      canvas.width = Math.max(1, Math.round(box.w * scale));
      canvas.height = Math.max(1, Math.round(box.h * scale));
      canvas
        .getContext("2d")!
        .drawImage(img, 0, 0, canvas.width, canvas.height);
      prims.push({
        type: "image",
        ...box,
        radii: null,
        alpha,
        bytes: await canvasToPng(canvas),
        fit: "fill",
      });
      avoid.push({ top: box.y, bottom: box.y + box.h });
    } catch (err) {
      noteOnce(
        "svg",
        `could not draw an inline SVG: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Clickable links: every line box of an <a> becomes a link rectangle, so a link
  // that wraps over two lines is two hit areas, not one box over empty space.
  // An <img> inside an <a> links its own box.
  const linkedEls = new WeakSet<Element>();
  function emitLink(
    anchor: Element | null,
    source: Element,
    alpha: number,
  ): void {
    if (!anchor || linkedEls.has(source)) return;
    const raw = anchor.getAttribute("href") || "";
    if (!raw || raw.startsWith("#") || /^\s*javascript:/i.test(raw)) return;
    let href: string;
    try {
      href = new URL(raw, anchor.ownerDocument.baseURI).href;
    } catch {
      return;
    }
    if (!/^(https?:|mailto:|tel:)/i.test(href)) return;
    linkedEls.add(source);
    const rects =
      source === anchor && source.tagName.toLowerCase() === "a"
        ? Array.from(anchor.getClientRects())
        : [source.getBoundingClientRect()];
    for (const r of rects) {
      if (r.width < 1 || r.height < 1) continue;
      prims.push({ type: "link", ...rel(r), href, alpha });
    }
  }

  /**
   * Opens the element's `transform` and `clip-path` scopes and returns what closes them. The browser
   * reports rectangles AFTER a transform, so the transform is switched off while the element and
   * its contents are measured (layout is unaffected by it) and drawn through a matrix instead.
   */
  function openEffects(el: Element, style: CSSStyleDeclaration): () => void {
    const closers: (() => void)[] = [];

    const transform = css(style, "transform");
    if (transform && transform !== "none") {
      const m = parseTransformMatrix(transform);
      if (!m) {
        noteOnce("transform", "a CSS transform could not be read and was skipped");
      } else {
        const originBox = el.getBoundingClientRect();
        const style0 = el as HTMLElement;
        const origin = parseTransformOrigin(
          css(style, "transform-origin"),
          // The pre-transform box size is what percentages and the default origin refer to.
          style0.offsetWidth || originBox.width,
          style0.offsetHeight || originBox.height,
        );
        const prevValue = style0.style?.getPropertyValue("transform") ?? "";
        const prevPriority = style0.style?.getPropertyPriority("transform") ?? "";
        style0.style?.setProperty("transform", "none", "important");
        const plain = rel(el.getBoundingClientRect());
        prims.push({
          type: "transform-start",
          ...plain,
          matrix: matrixAbout(m, plain.x + origin.x, plain.y + origin.y),
        });
        closers.push(() => {
          prims.push({ type: "transform-end" });
          if (prevValue) style0.style.setProperty("transform", prevValue, prevPriority);
          else style0.style.removeProperty("transform");
        });
      }
    }

    const clipPath = css(style, "clip-path");
    if (clipPath && clipPath !== "none") {
      const b = rel(el.getBoundingClientRect());
      const shape = parseClipPath(clipPath, b.w, b.h);
      if (!shape) {
        noteOnce(
          "clip-path",
          `clip-path "${clipPath.slice(0, 40)}" is not supported and was not applied`,
        );
      } else {
        prims.push({
          type: "shape-clip-start",
          ...b,
          segments: shape.segments.map((seg) =>
            seg.op === "M" || seg.op === "L"
              ? { ...seg, x: seg.x + b.x, y: seg.y + b.y }
              : seg.op === "C"
                ? {
                    ...seg,
                    x1: seg.x1 + b.x,
                    y1: seg.y1 + b.y,
                    x2: seg.x2 + b.x,
                    y2: seg.y2 + b.y,
                    x: seg.x + b.x,
                    y: seg.y + b.y,
                  }
                : seg,
          ),
          evenOdd: shape.evenOdd,
        });
        closers.push(() => prims.push({ type: "shape-clip-end" }));
      }
    }

    return () => {
      for (let i = closers.length - 1; i >= 0; i--) closers[i]!();
    };
  }

  async function visit(el: Element, parentAlpha: number): Promise<void> {
    const style = win.getComputedStyle(el);
    if (style.display === "none" || (options.skip && el.matches(options.skip)))
      return;
    const alpha = parentAlpha * (parseFloat(style.opacity) || 0);
    if (alpha <= 0.001) return;

    const close = openEffects(el, style);
    try {
      await paintElement(el, style, alpha);
    } finally {
      close();
    }
  }

  async function paintElement(
    el: Element,
    style: CSSStyleDeclaration,
    alpha: number,
  ): Promise<void> {
    const box = rel(el.getBoundingClientRect());
    const painted = style.visibility !== "hidden" && box.w > 0 && box.h > 0;
    const tag = el.tagName.toLowerCase();

    if (tag === "svg") {
      if (painted) await emitSvg(el, style, box, alpha);
      return;
    }

    let radii: Radii | null = null;
    if (painted) radii = await emitDecoration(style, box, alpha);

    if (tag === "img") {
      if (painted) emitImage(el as HTMLImageElement, style, box, alpha);
      emitLink(el.closest("a[href]"), el, alpha);
      return;
    }

    if (tag === "a" && painted) emitLink(el, el, alpha);

    // A visibly boxed block (card, tile, row) is a soft keep-together band: the
    // breaker protects it if it is small enough to fit comfortably on a page.
    if (painted && el !== root && box.h > 8 && box.h < 700) {
      const boxed =
        parseCssColor(css(style, "background-color")).a > 0.05 ||
        (css(style, "background-image") || "none") !== "none" ||
        (["top", "right", "bottom", "left"] as const).some(
          (side) =>
            parseFloat(css(style, `border-${side}-width`)) > 0 &&
            css(style, `border-${side}-style`) !== "none",
        );
      if (boxed) avoid.push({ top: box.y, bottom: box.y + box.h, soft: true });
    }

    if (
      painted &&
      (el.tagName === "TR" ||
        el.tagName === "LI" ||
        el.tagName === "FIGURE" ||
        (el as HTMLElement).dataset?.pdfBreak === "avoid" ||
        style.breakInside === "avoid" ||
        style.pageBreakInside === "avoid")
    ) {
      avoid.push({ top: box.y, bottom: box.y + box.h });
    }

    const clips =
      painted &&
      el.childNodes.length > 0 &&
      (style.overflowX !== "visible" || style.overflowY !== "visible");
    if (clips) prims.push({ type: "clip-start", ...box, radii });

    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 1) await visit(child as Element, alpha);
      else if (child.nodeType === 3 && (child.textContent ?? "").trim())
        emitText(child as Text, el, alpha);
    }

    if (clips) prims.push({ type: "clip-end" });
  }

  await visit(root, 1);

  const bottom = prims.reduce(
    (max, p) => (isScopePrim(p) ? max : Math.max(max, p.y + p.h)),
    0,
  );
  return {
    prims,
    avoid,
    width: rootRect.width,
    height: Math.max(
      rootRect.height,
      (root as HTMLElement).scrollHeight || 0,
      Math.min(bottom, rootRect.height * 1.5),
    ),
    notes,
  };
}
