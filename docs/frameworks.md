# Using it with a framework

The package touches the DOM, so it only runs in the browser. Every recipe below is
the same idea: call it from an event handler, on an element that is already on screen.

## React

```tsx
import { useRef, useState } from 'react';
import { downloadPdf } from '@kaisarsofi/html-to-pdf';

export function Invoice() {
  const ref = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!ref.current) return;
    setBusy(true);
    try {
      await downloadPdf(ref.current, 'invoice.pdf');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button onClick={save} disabled={busy} data-pdf-hide>
        {busy ? 'Preparing…' : 'Download PDF'}
      </button>
      <div ref={ref}>{/* … */}</div>
    </>
  );
}
```

`data-pdf-hide` on the button keeps it out of the PDF. The element must be rendered and
visible when you call: a `display: none` element has no layout to copy.

## Next.js

Mark the component `'use client'`. A top-level `import` is fine — nothing in this package
touches `window` or `document` at import time, so the module is safe to evaluate during the
server render. Only the *call* needs a browser.

```tsx
'use client';

import { useRef } from 'react';
import { downloadPdf } from '@kaisarsofi/html-to-pdf';

export default function SaveButton() {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <>
      <button onClick={() => ref.current && downloadPdf(ref.current, 'report.pdf')} data-pdf-hide>
        Download PDF
      </button>
      <div ref={ref}>{/* … */}</div>
    </>
  );
}
```

If you would rather keep the library out of the initial bundle, import it inside the
handler instead — it is roughly 1.6 MB packed, mostly the bundled fonts:

```tsx
const { downloadPdf } = await import('@kaisarsofi/html-to-pdf');
```

### next/font

`next/font` serves **variable WOFF2**, which cannot be embedded in a PDF. Text in that font
falls back to a standard face and `warnings` tells you once. Two ways out:

1. Do nothing if you use **Inter** — the bundled static Inter is substituted automatically
   (`bundledInter`, on by default).
2. For any other family, put static files in `public/fonts/` and pass them:

   ```ts
   await downloadPdf(el, 'report.pdf', {
     fonts: [400, 600, 700].map((weight) => ({
       family: 'Söhne', weight, url: `/fonts/Sohne-${weight}.woff`,
     })),
   });
   ```

See [fonts.md](./fonts.md).

## Vue

```vue
<script setup>
import { ref } from 'vue';
import { downloadPdf } from '@kaisarsofi/html-to-pdf';

const root = ref(null);
</script>

<template>
  <button @click="downloadPdf(root, 'quote.pdf')" data-pdf-hide>Download PDF</button>
  <div ref="root"><!-- … --></div>
</template>
```

## Plain HTML, no bundler

```html
<script type="importmap">
  {
    "imports": {
      "pdf-lib": "https://esm.sh/pdf-lib@1.17.1",
      "@pdf-lib/fontkit": "https://esm.sh/@pdf-lib/fontkit@1.1.1"
    }
  }
</script>
<script type="module">
  import { downloadPdf } from 'https://esm.sh/@kaisarsofi/html-to-pdf';
  document.querySelector('#save').onclick = () => downloadPdf('#invoice', 'invoice.pdf');
</script>
```

The import map is needed because the package imports `pdf-lib` by bare name. A bundler
(Vite, webpack, Next.js, Rollup) resolves that for you and needs no import map.

## Server-side rendering

There is no Node build. The package measures a real layout, which needs a real browser
engine. Calling it during SSR will fail because there is no `document`. If you need PDFs on
a server, run this in a headless browser page, or use a server-side library instead.
