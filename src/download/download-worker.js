/*
 * Starts a file download the moment the user taps, then fills it in when the file is ready.
 *
 * iOS Safari only saves a file when the download starts from a tap, and building a PDF takes
 * longer than a tap stays valid, so a click made afterwards opens a preview instead. The page
 * opens `<this folder>/__html-to-pdf__/<id>` right away, this worker answers it as an
 * attachment, and the bytes arrive later over a MessageChannel.
 */
const DOWNLOAD_SEGMENT = "/__html-to-pdf__/";
const WAIT_FOR_PAGE_MS = 5000;
const POLL_MS = 25;

const pending = new Map();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("message", (event) => {
  const { id, fileName } = event.data || {};
  const port = event.ports[0];

  if (id && port) pending.set(id, { fileName, port });
});

function waitForPage(id) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const entry = pending.get(id);

      if (entry || Date.now() - startedAt > WAIT_FOR_PAGE_MS) {
        clearInterval(timer);
        resolve(entry);
      }
    }, POLL_MS);
  });
}

self.addEventListener("fetch", (event) => {
  const { pathname } = new URL(event.request.url);
  const at = pathname.indexOf(DOWNLOAD_SEGMENT);

  if (at === -1) return;

  const id = pathname.slice(at + DOWNLOAD_SEGMENT.length);

  event.respondWith(
    waitForPage(id).then((entry) => {
      if (!entry) return new Response("Download not found", { status: 404 });

      pending.delete(id);

      const body = new ReadableStream({
        start(controller) {
          entry.port.onmessage = ({ data }) => {
            if (data === "end") controller.close();
            else if (data === "error") controller.error(new Error("PDF failed"));
            else controller.enqueue(new Uint8Array(data));
          };
        },
      });

      return new Response(body, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(entry.fileName)}`,
        },
      });
    }),
  );
});
