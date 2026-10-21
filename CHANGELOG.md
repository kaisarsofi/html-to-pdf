# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.4] — 2026-10-21

First public release, published as `@kaisarsofi/html-to-pdf`.

Turn any element on the page into a real vector PDF, in the browser, with no headless
browser and no server round-trip. The element is measured where the browser already laid it
out, then drawn as PDF objects — so text stays selectable and searchable, and page breaks
land where nothing is crossing them.

### Output

- **`layout: 'preserve'` (default)** — an exact copy of the on-screen layout: text in the
  page's own fonts, backgrounds, gradients, borders, rounded corners, rounded image crops,
  images, inline SVG icons and clickable `http` / `mailto:` / `tel:` links.
- **`layout: 'flow'`** — re-stacks text, images and table rows into pages, for
  document-like pages where the designed layout does not matter.
- **CSS effects drawn as vector shapes** — `transform` (including nested), `clip-path`
  basic shapes, and outer `box-shadow`.

### Pages

- **One continuous page by default**, exactly as long as the document: nothing is cut and
  nothing is left blank.
- **`page.mode: 'paginated'`** for regular pages, with breaks chosen from the measured
  geometry so no line, row, image or card is split, and a page is only closed when the next
  piece genuinely does not fit.
- **`page.maxHeight`** splits a very long continuous document into several tall pages, for
  viewers that scroll a single huge page jerkily. A document past the PDF page-size limit
  (about 19,200 CSS px) falls back automatically.

### Rendering

- The element is copied into a **hidden 1440px-wide frame in the light theme** before
  measuring, so output never depends on the reader's window size or dark mode. Content width
  is measured and held between 900 and 1200px, so a phone still gets a desktop-width
  document. `render: false` opts out.
- **`render.view: 'responsive'`** instead follows the device that downloads: a phone gets the
  page's mobile layout, anything wider gets desktop.
- **`data-pdf-hide`** removes an element, **`data-pdf-skip`** skips it and its contents, and
  **`data-pdf-break="avoid"`** keeps a block off a page break.

### Fonts

- The page's own `@font-face` files are embedded automatically — static TTF, OTF and WOFF.
- **WOFF2 and variable fonts cannot be embedded** (the subsetter cannot read them), which is
  what `next/font` and Google Fonts serve. A standard face is substituted and `warnings`
  says so once.
- **Bundled static Inter** is substituted automatically in exactly that case, so the common
  `next/font` setup still gets its real typeface.
- **Bundled Noto Sans** covers characters nothing else can draw, including `₹`. Both bundles
  load lazily — a PDF that needs neither never fetches them.
- Faces whose `unicode-range` excludes basic Latin are used for just the characters the main
  face lacks, and `fallbackFonts` adds your own chain.

### Images

- Embedded at 2 device pixels per drawn CSS pixel by default; an image close to the size it
  is drawn at is embedded untouched.
- An image the browser refuses to let the page read (no CORS headers on the host) is left
  out and named in `warnings`, with `images.loader` as the escape hatch.

### Errors

- A missing font, glyph or image never throws. Everything that changed the output comes back
  in `warnings`, and CSS that could only be approximated in `notes`.

### Project

- MIT licensed; bundled font licences in `NOTICE`.
- TypeScript throughout, with declarations shipped in `dist/`.
- 71 tests covering layout extraction, page breaking, pagination, colour parsing, SVG paths
  and config resolution, run on Node 18, 20 and 22.

[0.3.4]: https://github.com/kaisarsofi-kxar/html-to-pdf/releases/tag/v0.3.4
