/** Long enough for the download to finish taking the bytes before the page is left. */
const PREVIEW_DELAY_MS = 1500;

/**
 * Shows the PDF in the browser's viewer. A new tab cannot be opened here: the PDF is built long after
 * the tap, so the browser would block it. Going to the PDF in the current tab is always allowed, and
 * the back button returns to the page.
 */
export function openPreview(blob: Blob): void {
  const url = URL.createObjectURL(blob);

  setTimeout(() => window.location.assign(url), PREVIEW_DELAY_MS);
}
