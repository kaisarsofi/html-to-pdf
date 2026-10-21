# Images

Images are embedded at `images.pixelRatio` (default 2) device pixels per drawn CSS pixel, so
they stay sharp on retina screens and when zoomed. An image that is already close to the
size it is drawn at is embedded untouched; only one more than `images.recompressAbove`
(default 1.5×) larger than needed is resampled, at `images.quality` (default 0.95).

Set `images.resample: false` to embed every image exactly as fetched.

## Images from another domain

A browser will **display** a cross-origin image but will not let a script **read its bytes**
unless the host sends CORS headers. The PDF needs the bytes, so an image from a host without
CORS is left out and reported in `warnings`.

The proper fix is on the image host — allow your site's origin. For Google Cloud Storage or
Firebase:

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

For S3, set the equivalent `CORSRules` on the bucket.

## If you cannot change the host

Give the package another way to fetch those bytes — usually a proxy on your own server,
which is not subject to the browser's origin rules:

```ts
await downloadPdf(el, 'report.pdf', {
  images: {
    loader: async (url) =>
      (await fetch('/api/proxy?url=' + encodeURIComponent(url))).blob(),
  },
});
```

`loader` is called only for images the browser blocked, and must return a `Blob`.
