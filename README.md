# html-to-pdf

Turn any element on the page into a real PDF, in the browser, with **no setup**.

```ts
import { downloadPdf } from 'html-to-pdf';

await downloadPdf(document.querySelector('#quote'), 'quote.pdf');
```

That is the whole integration. No headless browser, no server, no fonts to host, nothing to configure.
The PDF is an exact copy of the element's **desktop layout**, drawn as vector graphics:

- text you can select and search, in the page's own fonts
- backgrounds, **gradients**, borders, **rounded corners**, rounded image crops
- images (resized only when they are far larger than shown), inline SVG icons
- **clickable links** (`http`, `mailto:`, `tel:`)
- the rupee sign and other symbols, without installing a font
- one continuous page: nothing is cut, nothing is left blank

## How it behaves with no config

| | Default |
|---|---|
| Layout | An exact copy of the screen (`layout: 'preserve'`) |
| Rendering | A hidden copy laid out at **1440px** viewport width in the **light** theme, so the PDF never depends on the user's window size or dark mode |
| Document width | Measured from the element, held between 900 and 1200 px (a phone still gets a desktop-width document) |
| Pages | One continuous page (`page.mode: 'continuous'`) |
| Fonts | The page's own static `@font-face` fonts (TTF/OTF/WOFF); WOFF2 and variable fonts need static files passed in (see Fonts) |
| Missing characters | A bundled Unicode font (Noto Sans), loaded only if some character needs it |
| Images | Kept sharp at 2 device pixels per drawn pixel; smaller images are never touched |
| Links | Clickable |

`generatePdf(element, config)` returns the bytes instead of downloading them:

```ts
const { bytes, pageCount, warnings } = await generatePdf('#quote');
```

It accepts an element or a CSS selector, and never throws for a missing font, glyph or image: those
become `warnings`.

## Configuration

Everything is optional. Change only what you need.

```ts
await downloadPdf(element, 'quote.pdf', {
  page: { mode: 'paginated', size: 'A4', margin: 36 },
  render: { viewportWidth: 1440, contentWidth: 900, theme: 'light' },
  fonts: [{ family: 'Inter', weight: 400, url: '/fonts/Inter-400.woff' }],
  images: { pixelRatio: 2, quality: 0.95 },
});
```

| Option | Default | |
|---|---|---|
| `layout` | `'preserve'` | `'preserve'` copies the layout exactly. `'flow'` re-stacks content as plain text, images and tables (suits document-like pages). |
| `page.mode` | `'continuous'` | `'continuous'`: one tall page. `'paginated'`: regular pages cut between lines of text, images and small cards. |
| `page.size` | `'A4'` | `'A4'`, `'LETTER'`, or `{ width, height }` in points. Used when paginated. |
| `page.maxHeight` | none | Points. In `'continuous'` mode, a document taller than this is split into a few equally wide, tall pages (cut at safe lines). Try `1600` if a viewer scrolls a very long page jerkily. |
| `page.margin` | `0` / `36` | Points, or `{ top, bottom, left }`. `0` for continuous, `36` for paginated. |
| `page.background` | none | `{ r, g, b }` (0 to 1) painted behind each page. |
| `render` | on | Set `false` to draw the element exactly as it is on screen, with no hidden frame. |
| `render.view` | `'desktop'` | `'desktop'`: always copy the desktop layout. `'responsive'`: follow the device that downloads. A phone gets the page's mobile layout (readable without zooming), anything wider gets the desktop layout. |
| `render.phoneBreakpoint` / `phoneWidth` | `767` / `430` | `'responsive'` only: screens this narrow count as a phone, and the mobile layout is drawn this wide (CSS px). |
| `render.viewportWidth` | `1440` | Width responsive CSS sees. |
| `render.contentWidth` | `'auto'` | CSS px, or `'auto'` to measure the element. |
| `render.minContentWidth` / `maxContentWidth` | `900` / `1200` | Bounds for `'auto'`. |
| `render.theme` | `'light'` | `'light'`, `'dark'`, or `'auto'` (keep the page's current theme). |
| `render.hide` | `'[data-pdf-hide]'` | Elements matching this are removed (buttons, toolbars). |
| `render.skip` | `'[data-pdf-skip]'` | Elements matching this, and their contents, are skipped. |
| `fonts` | `'auto'` | `'auto'` reads the page's `@font-face` rules. Or a list of `{ family, weight, style?, url \| bytes }`. |
| `fallbackFonts` | `[]` | Tried in order for characters the page's fonts lack, before the bundled font. |
| `bundledFallbackFont` | `true` | Use the bundled Unicode font (covers `₹`). |
| `images.pixelRatio` | `2` | Pixels kept per drawn CSS pixel. |
| `images.quality` | `0.95` | JPEG quality for photos that are reduced. |
| `images.recompressAbove` | `1.5` | An image is left untouched unless larger than this many times what it needs. |
| `images.resample` | `true` | `false` embeds every image exactly as fetched. |
| `images.loader` | none | Called for an image the browser will not let the page read (see below). |
| `links` | `true` | Make links clickable. |
| `logWarnings` | `true` | Print `warnings` to the console. |
| `flow.oversized` / `flow.minFill` | `'scale'` / `0.4` | `'flow'` layout only. |

Mark parts of the page that should stay out of the PDF with `data-pdf-hide` (removed) or `data-pdf-skip`.
Keep a block from being split across pages (paginated mode) with `data-pdf-break="avoid"` or CSS
`break-inside: avoid`.

## Fonts

By default the package reads the page's own `@font-face` rules and embeds static **TTF, OTF and WOFF**
files, so text is drawn in the typeface the user sees.

**WOFF2 and variable fonts cannot be embedded** (the PDF library's font subsetter cannot read them). This is
the usual case for `next/font` and Google Fonts. When text on the page uses one, the PDF falls back to a
standard font for it and `warnings` says so once. For exact text, give the package static files, one per
weight, with the `fonts` option:

```ts
fonts: [300, 400, 500, 600, 700].map((weight) => ({
  family: 'Inter', weight, url: `/fonts/Inter-${weight}.woff`,
}))
```

Weights are matched to the nearest file, so the PDF can use exactly the weights the page does.

A face whose `unicode-range` does not cover basic Latin (a Latin-extended or Cyrillic file, say) is used
automatically for just the characters the main face lacks. Anything still missing is drawn from the bundled
Noto Sans (SIL Open Font License, see `NOTICE`), which is only loaded when a character needs it.
Any font that fails to embed is reported in `warnings`; it can never hang or fail the export.

## Images from another domain

A browser will **display** an image from another origin but will not let a script **read** its bytes unless
that server sends CORS headers. The PDF needs the bytes, so an image from a host without CORS is left out
and reported in `warnings`:

> 3 image(s) were left out because the browser blocked reading them: https://storage.googleapis.com. Allow this
> site's origin in that host's CORS settings...

The proper fix is on the image host: allow the site's origin. For a Google Cloud Storage / Firebase bucket:

```json
[
  {
    "origin": ["https://app.example.com", "http://localhost:3000"],
    "method": ["GET"],
    "responseHeader": ["Content-Type"],
    "maxAgeSeconds": 3600
  }
]
```

```sh
gcloud storage buckets update gs://YOUR_BUCKET --cors-file=cors.json
```

If you cannot change the host, give the package a way to fetch those images (for example through your own
server) with `images.loader: async (url) => (await fetch('/my-proxy?url=' + encodeURIComponent(url))).blob()`.

## Effects that are drawn

- **CSS `transform`** (rotate, scale, skew, translate, matrix) on any element, with `transform-origin`. The
  element and everything inside it is drawn through the matrix, nested transforms included.
- **`clip-path`** basic shapes: `polygon()` (with `evenodd`), `inset()` (with `round`), `circle()` and
  `ellipse()`. The shape clips the element, its shadow and everything inside it.
- **`box-shadow`** (outer shadows, any number): crisp ones (rings, hard shadows) as vector shapes, blurred
  ones as a few stacked translucent shapes that imitate the blur (no bitmaps, so long documents stay smooth to scroll).

## What is not drawn

Reported in `result.notes`, never drawn wrongly: inset `box-shadow`, `clip-path: url()` / `path()` and
shapes using `calc()` / `var()`, `backdrop-filter`, `::before` / `::after` content, and radial/conic
gradients are approximated. A document taller than the PDF page-size limit (about 19,200 CSS px)
automatically falls back to regular pages.

## The `flow` layout

`layout: 'flow'` is the package's original engine: it measures real line, row and image heights and re-stacks
them into pages so no page ends with unexplained empty space and nothing is cut through a line. It draws text,
images and table rows only, so it suits reports and articles rather than designed pages.

## Development

TypeScript, strict. `npm run build` compiles to `dist/` (and generates the bundled font modules);
`npm test` builds and runs the tests; `npm run typecheck` checks without emitting.
