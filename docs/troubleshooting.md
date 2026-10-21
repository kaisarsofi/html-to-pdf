# Troubleshooting

## The text is not in my font

The page's font is almost certainly **WOFF2 or variable**, which cannot be embedded.
`warnings` will say so. If the font is Inter, the bundled static Inter is used automatically.
Otherwise pass static files — see [fonts.md](./fonts.md).

## Some images are missing

The browser blocked reading their bytes because the host sends no CORS headers. `warnings`
names the host. Fix it on the host, or pass `images.loader` — see [images.md](./images.md).

## The PDF does not look like my screen

Check these in order:

1. **Dark mode.** The default forces the light theme. Use `render: { theme: 'auto' }` to keep
   whatever the page is showing.
2. **Width.** The default lays the element out at a 1440px viewport and a 900–1200px content
   width, so a phone still gets a desktop-looking document. Set `render.contentWidth` to pin
   it, or `render: false` to copy the element exactly as it is on screen.
3. **Approximated CSS.** `result.notes` lists anything that could not be drawn exactly:
   inset shadows, `clip-path: url()` / `path()`, shapes using `calc()` / `var()`,
   `backdrop-filter`, `::before` / `::after` content. Radial and conic gradients are
   approximated.

## "The element has no size"

The element must be rendered and visible when you call. A `display: none` element, an
unmounted component, or a `ref` read before paint has no layout to copy. Call it from an
event handler, not during render.

## I want one long page instead of A4 pages

The default is `page.mode: 'paginated'` — regular A4 pages. For a single page exactly as tall
as the document, use `page: { mode: 'continuous' }`. That mode also drops the page margin to
zero, since a margin around one document-sized page reads as a border rather than padding.

## A very long continuous PDF scrolls jerkily

Some viewers draw a single very long page in one go. In `'continuous'` mode, set
`page.maxHeight` (try `1600`) to split it into several tall pages, which are drawn lazily. A
document past the PDF page-size limit (about 19,200 CSS px) falls back automatically.

## It fails during server-side rendering

The package needs a real browser. Importing it on the server is safe — nothing touches
`document` at import time — but calling it is not. Call it from an event handler in a
client component. See [frameworks.md](./frameworks.md).

## Buttons and toolbars appear in the PDF

Mark them `data-pdf-hide`.
