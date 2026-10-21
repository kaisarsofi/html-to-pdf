# How it works

Most browser HTML-to-PDF tools take one of two routes, and both have a characteristic
failure:

- **Screenshot tools** (`html2canvas` + `jsPDF`) rasterise the element into one tall image
  and slice it at fixed heights. The slice is blind, so it cuts through a line of text or a
  table row, and the output is a picture — text cannot be selected or searched, and it
  blurs when zoomed or printed.
- **Browser print engines** (`window.print()`, Puppeteer's `page.pdf()`) paginate with an
  internal algorithm you cannot inspect or steer, which has long-standing layout bugs, and
  Puppeteer needs a headless browser process you have to run and pay for somewhere.

This package measures first and draws second, in the page you are already on.

## The passes

1. **Render.** The element is cloned into a hidden frame laid out at a desktop viewport
   width in the light theme. This is why the PDF looks the same whether the reader is on a
   1024px laptop, a phone, or in dark mode — the output never depends on the reader's
   window. (`render: false` skips this and uses the element as it sits on screen.)

2. **Extract.** The clone is walked and every visible piece becomes a drawing primitive with
   its real measured geometry: text runs with their font, size, weight and colour;
   backgrounds, gradients, borders and rounded corners; images; inline SVG; link rectangles;
   transforms, clip paths and shadows. Geometry comes from `getBoundingClientRect()` and the
   `Range` API, so the numbers are the browser's own layout, not a guess.

3. **Break.** For paginated output, break positions are chosen from the measured geometry —
   a page ends at a position no line, row, image or card straddles. Nothing is cut, and a
   page is only closed when the next piece genuinely does not fit, so there is no
   unexplained blank space either. Continuous mode skips this entirely: the page is made
   exactly as tall as the document.

4. **Write.** Primitives are drawn into a real PDF with `pdf-lib`: vector shapes, embedded
   font subsets, embedded images and link annotations. Text stays selectable, searchable and
   crisp at any zoom, because it is text — not pixels.

## Why there is no Node version

Steps 1 and 2 need a real layout engine to ask "where did this actually end up?". That is
the whole premise: measure what the browser did rather than reimplement CSS. A Node build
would have to reimplement it, which is the thing this avoids.

## Fallbacks, never failures

A font that cannot be embedded, an image the browser will not let the page read, a CSS
feature that can only be approximated — none of these throw. They come back in `warnings`
and `notes` so you get a PDF plus an honest account of what differs. See
[configuration.md](./configuration.md#result).
