# Fonts

By default (`fonts: 'auto'`) the package reads the page's own `@font-face` rules and embeds
the files it can, so the PDF uses the typeface the reader sees.

## What can and cannot be embedded

| Format | Embeds |
|---|---|
| TTF, OTF, WOFF (static, one file per weight) | Yes |
| **WOFF2** | **No** — the subsetter cannot read it |
| **Variable fonts** (one file, many weights) | **No** |

WOFF2 and variable fonts are what `next/font` and Google Fonts serve, so this comes up
often. When text uses one, a standard font is substituted and `warnings` says so once —
the export never fails or hangs over a font.

## Passing static files

Give one file per weight:

```ts
await downloadPdf(el, 'report.pdf', {
  fonts: [300, 400, 500, 600, 700].map((weight) => ({
    family: 'Inter', weight, url: `/fonts/Inter-${weight}.woff`,
  })),
});
```

Each entry is `{ family, weight?, style?, url }` or `{ family, …, bytes }` if you already
have the file. Weights are matched to the nearest supplied file, so the PDF uses the same
weights the page does.

Google Fonts will serve static TTFs to an old user agent, which is a convenient way to get
files to put in `public/fonts/`:

```sh
curl -A "Mozilla/4.0" "https://fonts.googleapis.com/css2?family=Inter:wght@400;700" | grep -o 'https[^)]*\.ttf'
```

## Bundled fonts

Two things are bundled and used only when needed:

- **Inter** — substituted automatically when the page uses Inter but its own copy cannot be
  embedded (the `next/font` case). Turn off with `bundledInter: false`.
- **Noto Sans** — used for characters nothing else can draw, including `₹`. Turn off with
  `bundledFallbackFont: false`.

Both are SIL Open Font License; see [`NOTICE`](../NOTICE). They are the bulk of the
package's 1.6 MB, and are loaded lazily at runtime — a PDF that needs neither never
fetches them.

## Subsets and fallbacks

A face whose `unicode-range` does not cover basic Latin (a Cyrillic or Latin-Extended file)
is used automatically for just the characters the main face lacks. You can add your own
chain with `fallbackFonts`, tried in order before the bundled Noto Sans.
