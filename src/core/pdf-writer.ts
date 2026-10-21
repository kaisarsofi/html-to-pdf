/**
 * pdf-writer.ts
 *
 * Draws the already-paginated boxes as REAL PDF content: vector text via
 * pdf-lib's drawText (selectable, searchable, crisp at any zoom) and real
 * embedded images, instead of rasterizing the page into one big picture.
 * This is the piece that fixes "blurry screenshot text" as a side effect
 * of fixing pagination: because we know exactly which text line and which
 * image goes where (from pagination-engine's output), we can draw each one
 * as its own PDF object at its own coordinates.
 *
 * This writer belongs to the 'flow' layout. The default 'preserve' layout is
 * drawn by layout-writer.ts.
 */

import { PDFDocument } from "pdf-lib";
import type {
  FlowContent,
  FlowRun,
  GroupItem,
} from "./content-flow-analyzer.js";
import { createRegistry, type FontSetup } from "../fonts/runtime.js";
import {
  createImageEmbedder,
  type ImageLoader,
  type ImageResolution,
} from "./image-embed.js";
import type { PlacedBox } from "./pagination-engine.js";
import { drawRunText } from "./text-draw.js";

export { drawRunText } from "./text-draw.js";

export type WriteOptions = FontSetup & {
  pageWidthPt: number;
  pageHeightPt: number;
  marginLeftPt?: number;
  marginTopPt?: number;
  imageLoader?: ImageLoader;
  imageResolution?: ImageResolution | null;
};

export async function writePdf(
  pages: PlacedBox<FlowContent>[][],
  options: WriteOptions,
): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  const marginLeft = options.marginLeftPt ?? 0;
  const marginTop = options.marginTopPt ?? 0;

  const pdfDoc = await PDFDocument.create();

  // Resolve every font the document needs up front, so the drawing loop
  // below stays synchronous and each face is embedded exactly once.
  const fonts = createRegistry(pdfDoc, options);
  await fonts.prepare(pages);

  const images = createImageEmbedder(pdfDoc, {
    ...(options.imageLoader ? { loader: options.imageLoader } : {}),
    config: options.imageResolution ?? null,
    warnings: fonts.warnings,
  });

  for (const placedBoxes of pages) {
    const page = pdfDoc.addPage([options.pageWidthPt, options.pageHeightPt]);

    for (const { box, y, scale = 1 } of placedBoxes) {
      const topY = options.pageHeightPt - marginTop - y; // PDF origin is bottom-left
      const content = box.content;
      if (!content) continue;

      // Draws one text line / image at an offset from the box's top-left.
      // Top-level boxes pass dx = dy = 0; the pieces inside an atomic group
      // pass their own measured offsets, which is what keeps table columns
      // in their columns and a caption under its image.
      //
      // A line is a list of styled runs, not a single string, so a `<code>`
      // span or a bold phrase inside a paragraph keeps its own font, size and
      // colour. Each run carries the offset of its own baseline from the top
      // of the line, so runs of different sizes sit on a shared baseline
      // rather than a shared top edge.
      const drawLine = (runs: FlowRun[], dx = 0, dy = 0) => {
        for (const run of runs) {
          drawRunText(
            page,
            fonts,
            run,
            marginLeft + dx + run.dx,
            topY - dy - run.baselineFromTop,
          );
        }
      };
      // `scale` is 1 for everything the engine placed at its measured size;
      // it is < 1 only for an oversized image the engine shrank to fit.
      const drawImage = async (
        {
          src,
          widthPt,
          heightPt,
        }: { src: string; widthPt: number; heightPt: number },
        dx = 0,
        dy = 0,
      ) => {
        const embedded = await images.embed(src);
        if (!embedded) return;
        const w = widthPt * scale;
        const h = heightPt * scale;
        page.drawImage(embedded, {
          x: marginLeft + dx * scale,
          y: topY - dy * scale - h,
          width: w,
          height: h,
        });
      };

      if (content.type === "text-line") {
        drawLine(content.runs);
      } else if (content.type === "image") {
        await drawImage(content);
      } else if (content.type === "group") {
        // An atomic block (<tr>, <li>, <figure>, a card marked
        // data-pdf-break="avoid"). The engine moved it as one unit; here we
        // lay its pieces back down at their original relative positions.
        for (const item of content.items as GroupItem[]) {
          if (item.type === "text-line") drawLine(item.runs, item.dx, item.dy);
          else await drawImage(item, item.dx, item.dy);
        }
      }
      // Anything else (e.g. an <hr>, or a block whose visual weight lives
      // entirely in CSS borders/backgrounds) draws nothing: this layout emits
      // text and images only. The 'preserve' layout draws backgrounds and borders.
    }
  }

  images.finish();
  return { bytes: await pdfDoc.save(), warnings: fonts.warnings };
}
