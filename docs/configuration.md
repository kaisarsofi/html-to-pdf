# Configuration

Every option is optional. `downloadPdf(element)` with no config produces an exact copy of
the element's desktop layout on one continuous page.

```ts
await downloadPdf(element, 'quote.pdf', {
  page: { mode: 'paginated', size: 'A4', margin: 36 },
  render: { viewportWidth: 1440, contentWidth: 900, theme: 'light' },
  fonts: [{ family: 'Inter', weight: 400, url: '/fonts/Inter-400.woff' }],
  images: { pixelRatio: 2, quality: 0.95 },
});
```

## Layout

| Option | Default | |
|---|---|---|
| `layout` | `'preserve'` | `'preserve'` copies the on-screen layout exactly, with backgrounds, gradients, borders, rounded corners, images, icons, links and text. `'flow'` re-stacks the content as plain text, images and tables — it suits document-like pages but loses designed layouts. |

## Pages

| Option | Default | |
|---|---|---|
| `page.mode` | `'continuous'` | `'continuous'`: one tall page exactly as long as the document, so nothing is cut and nothing is left blank. `'paginated'`: regular pages, cut between lines of text, images and small cards. |
| `page.size` | `'A4'` | `'A4'`, `'LETTER'`, or `{ width, height }` in points. Only used when paginated. |
| `page.maxHeight` | none | Points. In continuous mode, a document taller than this is split into a few equally wide, tall pages. Try `1600` if a viewer scrolls a very long page jerkily. |
| `page.margin` | `0` / `36` | Points, or `{ top, bottom, left }`. `0` for continuous, `36` for paginated. |
| `page.background` | none | `{ r, g, b }` from 0 to 1, painted behind each page. |

## Rendering

The element is copied into a hidden, desktop-width frame before measuring, so the PDF never
depends on the size of the reader's window or on dark mode. Set `render: false` to draw the
element exactly as it is on screen instead.

| Option | Default | |
|---|---|---|
| `render.view` | `'desktop'` | `'desktop'` always copies the desktop layout. `'responsive'` follows the device that downloads: a phone gets the page's mobile layout (readable without zooming), anything wider gets desktop. |
| `render.phoneBreakpoint` | `767` | `'responsive'` only: screens this narrow count as a phone. |
| `render.phoneWidth` | `430` | `'responsive'` only: width of the mobile layout, in CSS px. |
| `render.viewportWidth` | `1440` | Width that responsive CSS sees. |
| `render.contentWidth` | `'auto'` | CSS px, or `'auto'` to measure the element. |
| `render.minContentWidth` / `maxContentWidth` | `900` / `1200` | Bounds for `'auto'`, so a phone still gets a desktop-width document. |
| `render.theme` | `'light'` | `'light'`, `'dark'`, or `'auto'` to keep the page's current theme. |
| `render.hide` | `'[data-pdf-hide]'` | Elements matching this are removed — buttons, toolbars, anything that only makes sense on screen. |
| `render.skip` | `'[data-pdf-skip]'` | Elements matching this, and their contents, are skipped. |

## Fonts

See [fonts.md](./fonts.md) for the detail.

| Option | Default | |
|---|---|---|
| `fonts` | `'auto'` | `'auto'` reads the page's `@font-face` rules. Or a list of `{ family, weight?, style?, url \| bytes }`. |
| `fallbackFonts` | `[]` | Tried in order for characters the page's fonts lack, before the bundled font. |
| `bundledFallbackFont` | `true` | Use the bundled Noto Sans for characters nothing else can draw (covers `₹`). |
| `bundledInter` | `true` | Use the bundled static Inter when the page uses Inter but its own copy cannot be embedded. |
| `fontkit` | auto | Override the automatically loaded fontkit. |

## Images

See [images.md](./images.md).

| Option | Default | |
|---|---|---|
| `images.pixelRatio` | `2` | Pixels kept per drawn CSS pixel. |
| `images.quality` | `0.95` | JPEG quality for photos that are reduced. |
| `images.recompressAbove` | `1.5` | Leave an image untouched unless it is more than this many times larger than needed. |
| `images.resample` | `true` | `false` embeds every image exactly as fetched. |
| `images.loader` | none | Called for an image the browser will not let the page read. |

## Other

| Option | Default | |
|---|---|---|
| `links` | `true` | Make `http`, `mailto:` and `tel:` links clickable. |
| `logWarnings` | `true` | Print `warnings` to the console. |
| `flow.oversized` | `'scale'` | `'flow'` layout only: an image taller than a page is shrunk to fit (`'scale'`) or left to run off the page (`'overflow'`). |
| `flow.minFill` | `0.4` | `'flow'` layout only: the smallest fraction of a page a shrunk image may be reduced to. |

## Markup hooks

| Attribute | Effect |
|---|---|
| `data-pdf-hide` | The element is removed from the PDF. |
| `data-pdf-skip` | The element and its contents are skipped. |
| `data-pdf-break="avoid"` | Paginated mode: keep this block off a page break. CSS `break-inside: avoid` works too. |

## Result

```ts
const { bytes, pageCount, warnings, notes } = await generatePdf('#quote');
```

| Field | |
|---|---|
| `bytes` | `Uint8Array` of the PDF. |
| `pageCount` | Pages written. |
| `warnings` | Things that changed the output: a font that could not be embedded, images the browser blocked. Never thrown — always returned. |
| `notes` | CSS that was approximated or skipped, so you are never silently given a wrong-looking PDF. |
