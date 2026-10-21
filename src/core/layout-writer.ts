/**
 * layout-writer.ts
 *
 * Draws the primitives from layout-extractor.ts onto PDF pages at their real
 * positions. Each page is one vertical slice of the document: everything is
 * shifted up by the slice's start and clipped to the page, so a card or a
 * gradient that straddles a cut simply continues on the next page.
 *
 * Everything is vector except images: text stays text, fills and borders are
 * paths, opaque gradients are PDF axial shadings (resolution independent), and
 * links are real clickable annotations.
 */

import {
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFOperator,
  PDFString,
  LineCapStyle,
  LineJoinStyle,
  appendBezierCurve,
  clip,
  concatTransformationMatrix,
  closePath,
  endPath,
  fill,
  fillAndStroke,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setDashPattern,
  setLineCap,
  setLineJoin,
  setFillingColor,
  setGraphicsState,
  setLineWidth,
  setStrokingColor,
  stroke,
  type PDFOperator as Operator,
  type PDFPage,
  type PDFRef,
} from "pdf-lib";
import type { Rgba } from "./color.js";
import type { FontSetup } from "../fonts/runtime.js";
import { createRegistry } from "../fonts/runtime.js";
import {
  createImageEmbedder,
  IMAGE_DEFAULTS,
  type ImageLoader,
  type ImageResolution,
} from "./image-embed.js";
import {
  fitImage,
  hasRadius,
  growRadii,
  insetRadii,
  invertMatrix,
  multiplyMatrix,
  type Matrix2D,
  type Radii,
} from "./layout-math.js";
import type { Layout, Prim } from "./layout-types.js";
import { drawRunText } from "./text-draw.js";

const PX_TO_PT = 72 / 96;
const KAPPA = 0.5522847498;

export type LayoutWriteOptions = FontSetup & {
  pageWidthPt: number;
  pageHeightPt: number;
  marginTopPt: number;
  marginBottomPt: number;
  marginLeftPt: number;
  /** page boundaries in CSS px; page i covers [cuts[i], cuts[i+1]) */
  cuts: number[];
  /** PDF points per CSS px */
  scale: number;
  imageLoader?: ImageLoader;
  /** false embeds every image exactly as fetched */
  imageResolution?: Partial<ImageResolution> | false;
  pageBackground?: { r: number; g: number; b: number } | null;
};

/** Operators for a rounded rectangle; x, yBottom, w, h and radii in PDF points. */
function pathOps(
  x: number,
  yb: number,
  w: number,
  h: number,
  r: Radii | null,
): Operator[] {
  const top = yb + h;
  if (!r || !hasRadius(r)) {
    return [
      moveTo(x, yb),
      lineTo(x + w, yb),
      lineTo(x + w, top),
      lineTo(x, top),
      closePath(),
    ];
  }
  const { tl, tr, br, bl } = r;
  return [
    moveTo(x + tl.x, top),
    lineTo(x + w - tr.x, top),
    appendBezierCurve(
      x + w - tr.x + tr.x * KAPPA,
      top,
      x + w,
      top - tr.y + tr.y * KAPPA,
      x + w,
      top - tr.y,
    ),
    lineTo(x + w, yb + br.y),
    appendBezierCurve(
      x + w,
      yb + br.y - br.y * KAPPA,
      x + w - br.x + br.x * KAPPA,
      yb,
      x + w - br.x,
      yb,
    ),
    lineTo(x + bl.x, yb),
    appendBezierCurve(
      x + bl.x - bl.x * KAPPA,
      yb,
      x,
      yb + bl.y - bl.y * KAPPA,
      x,
      yb + bl.y,
    ),
    lineTo(x, top - tl.y),
    appendBezierCurve(
      x,
      top - tl.y + tl.y * KAPPA,
      x + tl.x - tl.x * KAPPA,
      top,
      x + tl.x,
      top,
    ),
    closePath(),
  ];
}

const ZERO_RADII: Radii = {
  tl: { x: 0, y: 0 },
  tr: { x: 0, y: 0 },
  br: { x: 0, y: 0 },
  bl: { x: 0, y: 0 },
};

const scaleRadii = (r: Radii | null, k: number): Radii | null =>
  r && {
    tl: { x: r.tl.x * k, y: r.tl.y * k },
    tr: { x: r.tr.x * k, y: r.tr.y * k },
    br: { x: r.br.x * k, y: r.br.y * k },
    bl: { x: r.bl.x * k, y: r.bl.y * k },
  };

/** pdf-lib exports no typed names for the even-odd fill ('f*') and shading ('sh') operators. */
const rawOp = (
  name: string,
  args?: Parameters<typeof PDFOperator.of>[1],
): Operator => PDFOperator.of(name as never, args);

const sameColor = (a: Rgba, b: Rgba) =>
  a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;

export async function writeLayoutPdf(
  layout: Layout,
  options: LayoutWriteOptions,
): Promise<{ bytes: Uint8Array; warnings: string[]; pageCount: number }> {
  const k = options.scale;
  const fs = k / PX_TO_PT; // converts the extractor's pt font sizes to the fitted scale
  const pdfDoc = await PDFDocument.create();

  const fonts = createRegistry(pdfDoc, options);
  const textPrims = layout.prims.filter(
    (p): p is Extract<Prim, { type: "text" }> => p.type === "text",
  );
  await fonts.prepareText(
    textPrims.map((p) => ({ run: p.style, text: p.text })),
  );

  const warnings = fonts.warnings;
  const imageCfg: ImageResolution | null =
    options.imageResolution === false
      ? null
      : { ...IMAGE_DEFAULTS, ...(options.imageResolution ?? {}) };
  const images = createImageEmbedder(pdfDoc, {
    ...(options.imageLoader ? { loader: options.imageLoader } : {}),
    config: imageCfg,
    warnings,
  });

  const alphaRefs = new Map<string, PDFRef>();
  let shadingCounter = 0;

  const alphaName = (page: PDFPage, alpha: number): string => {
    const key = alpha.toFixed(3);
    if (!alphaRefs.has(key)) {
      alphaRefs.set(
        key,
        pdfDoc.context.register(
          pdfDoc.context.obj({ Type: "ExtGState", ca: alpha, CA: alpha }),
        ),
      );
    }
    const name = `GSa${key.replace(".", "_")}`;
    page.node.setExtGState(PDFName.of(name), alphaRefs.get(key)!);
    return name;
  };
  const withAlpha = (page: PDFPage, alpha: number): Operator[] =>
    alpha < 0.999
      ? [setGraphicsState(alphaName(page, Math.max(0, alpha)))]
      : [];

  function registerShading(page: PDFPage, dict: PDFDict): string {
    const ref = pdfDoc.context.register(dict);
    const resources = page.node.normalizedEntries().Resources;
    let shadings = resources.lookupMaybe(PDFName.of("Shading"), PDFDict);
    if (!shadings) {
      shadings = pdfDoc.context.obj({});
      resources.set(PDFName.of("Shading"), shadings);
    }
    const name = `Sh${++shadingCounter}`;
    shadings.set(PDFName.of(name), ref);
    return name;
  }

  function stitchedFunction(rawStops: { pos: number; color: Rgba }[]): PDFRef {
    // The shading function is defined on [0,1]. Clamp stops into it and pad with
    // flat colour at either end so a gradient that starts at 20% still holds its
    // first colour from 0 to 20%.
    const stops = rawStops.map((s) => ({
      pos: Math.min(1, Math.max(0, s.pos)),
      color: s.color,
    }));
    if (stops[0]!.pos > 0) stops.unshift({ pos: 0, color: stops[0]!.color });
    if (stops[stops.length - 1]!.pos < 1)
      stops.push({ pos: 1, color: stops[stops.length - 1]!.color });

    const color = (c: Rgba) => [c.r, c.g, c.b];
    const segments: PDFRef[] = [];
    for (let i = 0; i < stops.length - 1; i++) {
      segments.push(
        pdfDoc.context.register(
          pdfDoc.context.obj({
            FunctionType: 2,
            Domain: [0, 1],
            C0: color(stops[i]!.color),
            C1: color(stops[i + 1]!.color),
            N: 1,
          }),
        ),
      );
    }
    if (segments.length === 1) return segments[0]!;

    // PDF requires strictly increasing bounds, so a hard colour stop (two stops
    // at one position) is nudged apart by a hair.
    const bounds: number[] = [];
    let prev = 0;
    for (const s of stops.slice(1, -1)) {
      prev = Math.min(1 - 1e-6, Math.max(s.pos, prev + 1e-6));
      bounds.push(prev);
    }
    return pdfDoc.context.register(
      pdfDoc.context.obj({
        FunctionType: 3,
        Domain: [0, 1],
        Functions: segments,
        Bounds: bounds,
        Encode: segments.flatMap(() => [0, 1]),
      }),
    );
  }

  // How wide each image needs to be: its largest drawn size times pixelRatio.
  const requiredWidth = new Map<string, number>();
  if (imageCfg) {
    for (const p of layout.prims) {
      if (p.type !== "image" || !p.src) continue;
      const drawn = fitImage(
        p.naturalW,
        p.naturalH,
        p.w,
        p.h,
        p.fit,
        p.posX ?? 0.5,
        p.posY ?? 0.5,
      );
      requiredWidth.set(
        p.src,
        Math.max(requiredWidth.get(p.src) ?? 0, drawn.w * imageCfg.pixelRatio),
      );
    }
  }

  const pageContentHeightPt =
    options.pageHeightPt - options.marginTopPt - options.marginBottomPt;
  const contentWidthPt = options.pageWidthPt - options.marginLeftPt * 2;
  let pageCount = 0;

  for (let i = 0; i < options.cuts.length - 1; i++) {
    const top = options.cuts[i]!;
    const bottom = options.cuts[i + 1]!;
    if (bottom - top < 0.5 && i > 0) continue;

    const page = pdfDoc.addPage([options.pageWidthPt, options.pageHeightPt]);
    pageCount++;
    const X = (px: number) => options.marginLeftPt + px * k;
    const Y = (py: number) =>
      options.pageHeightPt - options.marginTopPt - (py - top) * k;
    const box = (p: { x: number; y: number; w: number; h: number }) => ({
      x: X(p.x),
      yb: Y(p.y + p.h),
      w: p.w * k,
      h: p.h * k,
    });

    if (options.pageBackground) {
      page.drawRectangle({
        x: 0,
        y: 0,
        width: options.pageWidthPt,
        height: options.pageHeightPt,
        color: rgb(
          options.pageBackground.r,
          options.pageBackground.g,
          options.pageBackground.b,
        ),
      });
    }

    // Everything on this page is clipped to its content area.
    page.pushOperators(
      pushGraphicsState(),
      ...pathOps(
        options.marginLeftPt,
        options.marginBottomPt,
        contentWidthPt,
        pageContentHeightPt,
        null,
      ),
      clip(),
      endPath(),
    );

    const fillOps = (
      ops: Operator[],
      color: Rgba,
      alpha: number,
      evenOdd = false,
    ) =>
      page.pushOperators(
        pushGraphicsState(),
        ...withAlpha(page, alpha * color.a),
        setFillingColor(rgb(color.r, color.g, color.b)),
        ...ops,
        evenOdd ? rawOp("f*") : fill(),
        popGraphicsState(),
      );

    // CSS px (y down, relative to the root) -> this page's PDF points, as a matrix.
    const toPage: Matrix2D = [
      k,
      0,
      0,
      -k,
      options.marginLeftPt,
      options.pageHeightPt - options.marginTopPt + top * k,
    ];
    const fromPage = invertMatrix(toPage);
    // Content inside a transform can land away from where its untransformed box sits, so it is not
    // skipped for being "off this page"; the page clip still keeps it from leaking.
    let transformDepth = 0;

    for (const p of layout.prims) {
      if (
        p.type === "clip-end" ||
        p.type === "transform-end" ||
        p.type === "shape-clip-end"
      ) {
        if (p.type === "transform-end") transformDepth--;
        page.pushOperators(popGraphicsState());
        continue;
      }
      if (p.type === "transform-start") {
        transformDepth++;
        // The same move in page space: toPage * matrix * toPage^-1.
        const m = fromPage
          ? multiplyMatrix(multiplyMatrix(toPage, p.matrix), fromPage)
          : ([1, 0, 0, 1, 0, 0] as Matrix2D);
        page.pushOperators(
          pushGraphicsState(),
          concatTransformationMatrix(...m),
        );
        continue;
      }
      if (p.type === "shape-clip-start") {
        const ops: Operator[] = [pushGraphicsState()];
        for (const seg of p.segments) {
          if (seg.op === "M") ops.push(moveTo(X(seg.x), Y(seg.y)));
          else if (seg.op === "L") ops.push(lineTo(X(seg.x), Y(seg.y)));
          else if (seg.op === "C")
            ops.push(
              appendBezierCurve(
                X(seg.x1),
                Y(seg.y1),
                X(seg.x2),
                Y(seg.y2),
                X(seg.x),
                Y(seg.y),
              ),
            );
          else ops.push(closePath());
        }
        ops.push(p.evenOdd ? rawOp("W*") : clip(), endPath());
        page.pushOperators(...ops);
        continue;
      }
      if (p.type === "clip-start") {
        const b = box(p);
        page.pushOperators(
          pushGraphicsState(),
          ...pathOps(b.x, b.yb, b.w, b.h, scaleRadii(p.radii, k)),
          clip(),
          endPath(),
        );
        continue;
      }
      if (transformDepth === 0 && (p.y + p.h < top || p.y > bottom)) continue;
      const b = box(p);

      if (p.type === "shadow") {
        const hole = box(p);
        const holePath = pathOps(
          hole.x,
          hole.yb,
          hole.w,
          hole.h,
          scaleRadii(p.radii, k),
        );
        const ops: Operator[] = [
          pushGraphicsState(),
          setFillingColor(rgb(p.color.r, p.color.g, p.color.b)),
        ];
        if (p.cutout) {
          // See-through element: clip to everything EXCEPT its own box, then stack the layers.
          ops.push(
            ...pathOps(
              -1000,
              -1000,
              options.pageWidthPt + 2000,
              options.pageHeightPt + 2000,
              null,
            ),
            ...holePath,
            rawOp("W*"),
            endPath(),
          );
        }
        for (const layer of p.layers) {
          const g = layer.grow;
          const shape = box({
            x: p.x + p.dx - g,
            y: p.y + p.dy - g,
            w: p.w + g * 2,
            h: p.h + g * 2,
          });
          if (shape.w <= 0 || shape.h <= 0) continue;
          ops.push(
            pushGraphicsState(),
            ...withAlpha(page, p.alpha * layer.alpha),
            ...pathOps(
              shape.x,
              shape.yb,
              shape.w,
              shape.h,
              scaleRadii(growRadii(p.radii ?? ZERO_RADII, g), k),
            ),
            // An opaque element covers its own box, so the layer is only a ring around it.
            ...(p.cutout ? [] : holePath),
            p.cutout ? fill() : rawOp("f*"),
            popGraphicsState(),
          );
        }
        ops.push(popGraphicsState());
        page.pushOperators(...ops);
      } else if (p.type === "rect") {
        fillOps(
          pathOps(b.x, b.yb, b.w, b.h, scaleRadii(p.radii, k)),
          p.color,
          p.alpha,
        );
      } else if (p.type === "alpha-gradient") {
        const ops: Operator[] = [
          pushGraphicsState(),
          ...pathOps(b.x, b.yb, b.w, b.h, scaleRadii(p.radii, k)),
          clip(),
          endPath(),
          setFillingColor(rgb(p.color.r, p.color.g, p.color.b)),
        ];
        const pt = (x: number, y: number): [number, number] => [X(x), Y(y)];
        const polygon = (pts: [number, number][]): Operator[] => [
          moveTo(...pts[0]!),
          ...pts.slice(1).map((q) => lineTo(...q)),
          closePath(),
        ];
        if (p.shape === "linear") {
          const { x0, y0, x1, y1 } = p.axis;
          const len = Math.hypot(x1 - x0, y1 - y0) || 1;
          const ux = (x1 - x0) / len;
          const uy = (y1 - y0) / len;
          const vx = -uy;
          const vy = ux;
          const reach = Math.hypot(p.w, p.h);
          for (const band of p.bands) {
            const s0 = band.from * len;
            const s1 = band.to * len;
            const a = [x0 + ux * s0, y0 + uy * s0];
            const c = [x0 + ux * s1, y0 + uy * s1];
            ops.push(
              pushGraphicsState(),
              ...withAlpha(page, p.alpha * band.alpha),
              ...polygon([
                pt(a[0]! - vx * reach, a[1]! - vy * reach),
                pt(a[0]! + vx * reach, a[1]! + vy * reach),
                pt(c[0]! + vx * reach, c[1]! + vy * reach),
                pt(c[0]! - vx * reach, c[1]! - vy * reach),
              ]),
              fill(),
              popGraphicsState(),
            );
          }
        } else {
          const cx = p.x + p.w / 2;
          const cy = p.y + p.h / 2;
          const reach = Math.hypot(p.w / 2, p.h / 2);
          const circle = (r: number): Operator[] => {
            const kx = r * KAPPA;
            const [px, py] = pt(cx, cy);
            const R = r * k;
            const K = kx * k;
            return [
              moveTo(px + R, py),
              appendBezierCurve(px + R, py + K, px + K, py + R, px, py + R),
              appendBezierCurve(px - K, py + R, px - R, py + K, px - R, py),
              appendBezierCurve(px - R, py - K, px - K, py - R, px, py - R),
              appendBezierCurve(px + K, py - R, px + R, py - K, px + R, py),
              closePath(),
            ];
          };
          for (const band of p.bands) {
            ops.push(
              pushGraphicsState(),
              ...withAlpha(page, p.alpha * band.alpha),
              ...circle(band.to * reach),
              ...(band.from > 0.0005 ? circle(band.from * reach) : []),
              band.from > 0.0005 ? rawOp("f*") : fill(),
              popGraphicsState(),
            );
          }
        }
        ops.push(popGraphicsState());
        page.pushOperators(...ops);
      } else if (p.type === "gradient") {
        const dict = pdfDoc.context.obj({
          ShadingType: 2,
          ColorSpace: "DeviceRGB",
          Coords: [X(p.axis.x0), Y(p.axis.y0), X(p.axis.x1), Y(p.axis.y1)],
          Function: stitchedFunction(p.stops),
          Extend: [true, true],
        });
        const name = registerShading(page, dict);
        page.pushOperators(
          pushGraphicsState(),
          ...withAlpha(page, p.alpha),
          ...pathOps(b.x, b.yb, b.w, b.h, scaleRadii(p.radii, k)),
          clip(),
          endPath(),
          rawOp("sh", [PDFName.of(name)]),
          popGraphicsState(),
        );
      } else if (p.type === "border") {
        const [t, r, bo, l] = p.sides.map((s) => s.w * k) as [
          number,
          number,
          number,
          number,
        ];
        const colors = p.sides.filter((s) => s.w > 0).map((s) => s.color);
        const uniformColor = colors.every((c) => sameColor(c, colors[0]!));
        const radii = scaleRadii(p.radii, k);

        if (uniformColor) {
          const first = p.sides[0]!;
          const dashed =
            p.sides.every((s) => s.w === first.w) &&
            ["dashed", "dotted"].includes(first.kind);
          if (dashed) {
            const w = first.w * k;
            const c = colors[0]!;
            const half = w / 2;
            page.pushOperators(
              pushGraphicsState(),
              ...withAlpha(page, p.alpha * c.a),
              setStrokingColor(rgb(c.r, c.g, c.b)),
              setLineWidth(w),
              setDashPattern(
                first.kind === "dotted" ? [w, w] : [w * 3, w * 2],
                0,
              ),
              ...pathOps(
                b.x + half,
                b.yb + half,
                b.w - w,
                b.h - w,
                radii && insetRadii(radii, half, half, half, half),
              ),
              stroke(),
              popGraphicsState(),
            );
          } else {
            const ops = [...pathOps(b.x, b.yb, b.w, b.h, radii)];
            const iw = b.w - l - r;
            const ih = b.h - t - bo;
            if (iw > 0 && ih > 0)
              ops.push(
                ...pathOps(
                  b.x + l,
                  b.yb + bo,
                  iw,
                  ih,
                  radii && insetRadii(radii, t, r, bo, l),
                ),
              );
            fillOps(ops, colors[0]!, p.alpha, true);
          }
        } else {
          const [st, sr, sb, sl] = p.sides as [
            (typeof p.sides)[0],
            (typeof p.sides)[0],
            (typeof p.sides)[0],
            (typeof p.sides)[0],
          ];
          if (t > 0)
            fillOps(
              pathOps(b.x, b.yb + b.h - t, b.w, t, null),
              st.color,
              p.alpha,
            );
          if (bo > 0)
            fillOps(pathOps(b.x, b.yb, b.w, bo, null), sb.color, p.alpha);
          if (l > 0)
            fillOps(pathOps(b.x, b.yb, l, b.h, null), sl.color, p.alpha);
          if (r > 0)
            fillOps(
              pathOps(b.x + b.w - r, b.yb, r, b.h, null),
              sr.color,
              p.alpha,
            );
        }
      } else if (p.type === "vector") {
        // SVG user space -> page points, then each shape's own transform on top.
        const { sx, sy, tx, ty } = p.userToPx;
        const base: [number, number, number, number, number, number] = [
          k * sx,
          0,
          0,
          -k * sy,
          options.marginLeftPt + k * tx,
          options.pageHeightPt - options.marginTopPt - k * (ty - top),
        ];
        for (const shape of p.shapes) {
          const ops: Operator[] = [
            pushGraphicsState(),
            ...withAlpha(page, p.alpha * shape.opacity),
            concatTransformationMatrix(...base),
            concatTransformationMatrix(...shape.matrix),
          ];
          if (shape.fill)
            ops.push(
              setFillingColor(rgb(shape.fill.r, shape.fill.g, shape.fill.b)),
            );
          if (shape.stroke) {
            ops.push(
              setStrokingColor(
                rgb(shape.stroke.r, shape.stroke.g, shape.stroke.b),
              ),
              setLineWidth(shape.strokeWidth),
              setLineCap(
                shape.cap === "round"
                  ? LineCapStyle.Round
                  : shape.cap === "square"
                    ? LineCapStyle.Projecting
                    : LineCapStyle.Butt,
              ),
              setLineJoin(
                shape.join === "round"
                  ? LineJoinStyle.Round
                  : shape.join === "bevel"
                    ? LineJoinStyle.Bevel
                    : LineJoinStyle.Miter,
              ),
            );
            if (shape.dash) ops.push(setDashPattern(shape.dash, 0));
          }
          for (const seg of shape.segments) {
            if (seg.op === "M") ops.push(moveTo(seg.x, seg.y));
            else if (seg.op === "L") ops.push(lineTo(seg.x, seg.y));
            else if (seg.op === "C")
              ops.push(
                appendBezierCurve(seg.x1, seg.y1, seg.x2, seg.y2, seg.x, seg.y),
              );
            else ops.push(closePath());
          }
          if (shape.fill && shape.stroke)
            ops.push(shape.evenOdd ? rawOp("B*") : fillAndStroke());
          else if (shape.fill) ops.push(shape.evenOdd ? rawOp("f*") : fill());
          else ops.push(stroke());
          ops.push(popGraphicsState());
          page.pushOperators(...ops);
        }
      } else if (p.type === "link") {
        // A real, clickable PDF link over the text/image, with no visible border.
        const annotation = pdfDoc.context.obj({
          Type: "Annot",
          Subtype: "Link",
          Rect: [b.x, b.yb, b.x + b.w, b.yb + b.h],
          Border: [0, 0, 0],
          A: { Type: "Action", S: "URI", URI: PDFString.of(p.href) },
        });
        page.node.addAnnot(pdfDoc.context.register(annotation));
      } else if (p.type === "image") {
        let embedded = p.bytes
          ? await pdfDoc.embedPng(p.bytes)
          : await images.embed(p.src!, requiredWidth.get(p.src!));
        if (embedded && p.smooth) {
          const stream = pdfDoc.context.lookup(embedded.ref) as
            | { dict?: PDFDict }
            | undefined;
          stream?.dict?.set(PDFName.of("Interpolate"), PDFBool.True);
        }
        if (!embedded) continue;
        const fit = fitImage(
          p.naturalW ?? embedded.width,
          p.naturalH ?? embedded.height,
          p.w,
          p.h,
          p.fit,
          p.posX ?? 0.5,
          p.posY ?? 0.5,
        );
        const needsClip = p.fit !== "fill" || hasRadius(p.radii);
        if (needsClip) {
          page.pushOperators(
            pushGraphicsState(),
            ...pathOps(b.x, b.yb, b.w, b.h, scaleRadii(p.radii, k)),
            clip(),
            endPath(),
          );
        }
        page.drawImage(embedded, {
          x: X(p.x + fit.x),
          y: Y(p.y + fit.y + fit.h),
          width: fit.w * k,
          height: fit.h * k,
          ...(p.alpha < 0.999 ? { opacity: p.alpha } : {}),
        });
        if (needsClip) page.pushOperators(popGraphicsState());
      } else if (p.type === "text") {
        const size = p.style.fontSizePt * fs;
        const run = { ...p.style, text: p.text, fontSizePt: size };
        const alpha = p.alpha * p.style.color.a;
        drawRunText(page, fonts, run, X(p.x), Y(p.baseline), {
          opacity: alpha,
          letterSpacingPt: p.style.letterSpacingPt * fs,
          targetWidthPt: p.w * k,
        });
        if (p.style.underline) {
          fillOps(
            pathOps(
              X(p.x),
              Y(p.baseline) - size * 0.14,
              p.w * k,
              Math.max(0.4, size * 0.06),
              null,
            ),
            p.style.color,
            alpha,
          );
        }
      }
    }

    // Close the page clip.
    page.pushOperators(popGraphicsState());
  }

  images.finish();
  return { bytes: await pdfDoc.save(), warnings, pageCount };
}
