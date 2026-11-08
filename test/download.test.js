import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { isIosBrowser } from "../dist/download/platform.js";
import { toAbsoluteUrl } from "../dist/download/worker-url.js";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";

test("iPhone and iPod count as iOS", () => {
  assert.equal(
    isIosBrowser({ userAgent: IPHONE, platform: "iPhone", maxTouchPoints: 5 }),
    true,
  );
});

test("an iPad that reports itself as a Mac counts as iOS", () => {
  assert.equal(
    isIosBrowser({ userAgent: MAC, platform: "MacIntel", maxTouchPoints: 5 }),
    true,
  );
});

test("a real Mac and Android do not count as iOS", () => {
  assert.equal(
    isIosBrowser({ userAgent: MAC, platform: "MacIntel", maxTouchPoints: 0 }),
    false,
  );
  assert.equal(
    isIosBrowser({ userAgent: ANDROID, platform: "Linux armv8l", maxTouchPoints: 5 }),
    false,
  );
});

test("a bundler path stand-in becomes a real absolute URL", () => {
  // Turbopack hands back an object that only holds the path.
  const standIn = { toString: () => "/_next/static/media/download-worker.abc.js" };
  const url = toAbsoluteUrl(standIn, "https://app.example.com/itinerary/preview");

  assert.equal(url.href, "https://app.example.com/_next/static/media/download-worker.abc.js");
  assert.equal(
    new URL("__html-to-pdf__/42", url).href,
    "https://app.example.com/_next/static/media/__html-to-pdf__/42",
  );
});

test("a real URL passes through unchanged", () => {
  const real = new URL("https://cdn.example.com/lib/download-worker.js");

  assert.equal(toAbsoluteUrl(real, "https://app.example.com/").href, real.href);
});

test("the download worker ships next to the code that loads it", () => {
  const loader = fs.readFileSync(
    new URL("../dist/download/streamed-download.js", import.meta.url),
    "utf8",
  );

  assert.match(loader, /new URL\("\.\/download-worker\.js", import\.meta\.url\)/);
  assert.ok(
    fs.existsSync(new URL("../dist/download/download-worker.js", import.meta.url)),
  );
});
