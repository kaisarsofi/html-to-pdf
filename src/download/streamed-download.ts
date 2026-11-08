import { isIosBrowser } from "./platform.js";

const DOWNLOAD_SEGMENT = "__html-to-pdf__/";
const ACTIVE_WAIT_MS = 1500;
const FRAME_REMOVE_MS = 60_000;

/** The worker file ships inside the package; bundlers emit it from this exact URL pattern. */
function workerUrl(): URL {
  return new URL("./download-worker.js", import.meta.url);
}

async function registerWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
    return null;

  try {
    return await navigator.serviceWorker.register(workerUrl());
  } catch {
    return null;
  }
}

function whenActive(
  registration: ServiceWorkerRegistration,
): Promise<ServiceWorker | null> {
  if (registration.active) return Promise.resolve(registration.active);

  const starting = registration.installing ?? registration.waiting;
  if (!starting) return Promise.resolve(null);

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ACTIVE_WAIT_MS);

    starting.addEventListener("statechange", () => {
      if (starting.state !== "activated") return;

      clearTimeout(timer);
      resolve(registration.active);
    });
  });
}

/**
 * Registers the download worker ahead of time, so the very first tap on an iPhone can start
 * a direct download too. Optional: without it that first tap shows the save button instead.
 */
export function prepareDownloads(): void {
  if (typeof navigator !== "undefined" && isIosBrowser()) void registerWorker();
}

export type StreamedDownload = {
  finish: (bytes: Uint8Array) => void;
  fail: () => void;
};

/**
 * Starts the file download right now, while the tap still counts, and returns handles to fill
 * it in once the PDF is built. Returns null when the worker cannot run (no service worker
 * support, a strict CSP, a private tab), so the caller can fall back.
 */
export async function beginStreamedDownload(
  fileName: string,
): Promise<StreamedDownload | null> {
  const registration = await registerWorker();
  const worker = registration ? await whenActive(registration) : null;

  if (!worker) return null;

  const id = crypto.randomUUID();
  const channel = new MessageChannel();
  const frame = document.createElement("iframe");

  worker.postMessage({ id, fileName }, [channel.port2]);
  frame.hidden = true;
  frame.src = new URL(`${DOWNLOAD_SEGMENT}${id}`, workerUrl()).href;
  document.body.appendChild(frame);
  setTimeout(() => frame.remove(), FRAME_REMOVE_MS);

  return {
    finish(bytes) {
      const copy = bytes.slice();

      channel.port1.postMessage(copy.buffer, [copy.buffer]);
      channel.port1.postMessage("end");
    },
    fail() {
      channel.port1.postMessage("error");
    },
  };
}
