/**
 * desktop-frame.ts
 *
 * Renders a copy of an element in a hidden frame at desktop width, in a chosen
 * theme, so the PDF is the same no matter how small or dark the user's window is.
 *
 * Responsive CSS reads the VIEWPORT width, not the element's, so a copy placed in
 * the same page would still lay out as narrow as the window. A frame has its own
 * viewport: at 1440px wide every desktop breakpoint applies. The copy keeps the
 * element's own width (measured on the page, then held to a sensible range), so
 * its layout matches the desktop screen rather than filling the frame.
 */

import type { ResolvedRender } from "../config.js";

export type DesktopRender = {
  /** The copy to export. */
  root: HTMLElement;
  /** Its width in CSS px. */
  contentWidth: number;
  /** Removes the frame. Always call it, even if exporting fails. */
  dispose: () => void;
};

const MIN_FRAME_HEIGHT = 1123;

/** Overrides that stop an ancestor's layout (fixed heights, scrolling, flex) from clipping or reshaping the copy. */
const NEUTRAL_SHELL =
  "display:block;position:static;float:none;width:auto;height:auto;min-width:0;min-height:0;max-width:none;max-height:none;" +
  "overflow:visible;padding:0;margin:0;border:0;transform:none;background:none;box-shadow:none;";

function whenLoaded(node: HTMLLinkElement): Promise<void> {
  return new Promise((resolve) => {
    node.addEventListener("load", () => resolve(), { once: true });
    node.addEventListener("error", () => resolve(), { once: true });
  });
}

function whenImageReady(image: HTMLImageElement): Promise<void> {
  if (image.complete) return Promise.resolve();
  return new Promise((resolve) => {
    image.addEventListener("load", () => resolve(), { once: true });
    image.addEventListener("error", () => resolve(), { once: true });
  });
}

function themeClasses(
  source: Document,
  theme: ResolvedRender["theme"],
): string {
  const kept = Array.from(source.documentElement.classList).filter(
    (c) => c !== "dark" && c !== "light",
  );
  if (theme === "auto")
    return Array.from(source.documentElement.classList).join(" ");
  return kept.concat(theme).join(" ");
}

export async function createDesktopRender(
  source: Element,
  config: ResolvedRender,
): Promise<DesktopRender> {
  const sourceDoc = source.ownerDocument;
  const measured = source.getBoundingClientRect().width;
  const contentWidth =
    config.contentWidth === "auto"
      ? Math.round(
          Math.min(
            config.maxContentWidth,
            Math.max(config.minContentWidth, measured > 0 ? measured : 900),
          ),
        )
      : config.contentWidth;

  const frame = sourceDoc.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  Object.assign(frame.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: `${config.viewportWidth}px`,
    height: `${MIN_FRAME_HEIGHT}px`,
    border: "0",
    pointerEvents: "none",
    visibility: "hidden",
  });
  sourceDoc.body.appendChild(frame);
  const dispose = () => frame.remove();

  try {
    const doc = frame.contentDocument;
    if (!doc) throw new Error("could not create the render frame");

    const scheme =
      config.theme === "dark"
        ? "dark"
        : config.theme === "light"
          ? "light"
          : "";
    doc.open();
    doc.write(
      `<!doctype html><html${scheme ? ` data-theme="${scheme}" style="color-scheme:${scheme}"` : ""}><head><meta charset="utf-8"></head><body></body></html>`,
    );
    doc.close();

    doc.documentElement.className = themeClasses(sourceDoc, config.theme);
    if (sourceDoc.documentElement.lang)
      doc.documentElement.lang = sourceDoc.documentElement.lang;
    if (sourceDoc.documentElement.dir)
      doc.documentElement.dir = sourceDoc.documentElement.dir;
    doc.body.className = sourceDoc.body.className;

    // Stylesheets: the same ones the page uses, so every rule (and font-face) applies.
    const sheetLoads: Promise<void>[] = [];
    sourceDoc.head
      .querySelectorAll<HTMLElement>('link[rel="stylesheet"], style')
      .forEach((node) => {
        const copy = node.cloneNode(true) as HTMLElement;
        if (copy instanceof HTMLLinkElement) sheetLoads.push(whenLoaded(copy));
        doc.head.appendChild(copy);
      });
    await Promise.all(sheetLoads);

    // Ancestors: empty shells with the same tag and classes, so descendant selectors
    // and inherited text styles still apply, with their layout neutralised.
    let parent: HTMLElement = doc.body;
    const chain: Element[] = [];
    for (
      let el = source.parentElement;
      el && el !== sourceDoc.body && el !== sourceDoc.documentElement;
      el = el.parentElement
    ) {
      chain.unshift(el);
    }
    for (const ancestor of chain) {
      const shell = doc.createElement(ancestor.tagName.toLowerCase());
      if (ancestor.className && typeof ancestor.className === "string")
        shell.className = ancestor.className;
      for (const attr of Array.from(ancestor.attributes)) {
        if (
          attr.name.startsWith("data-") ||
          attr.name === "dir" ||
          attr.name === "lang"
        )
          shell.setAttribute(attr.name, attr.value);
      }
      shell.style.cssText = NEUTRAL_SHELL;
      parent.appendChild(shell);
      parent = shell;
    }

    const root = doc.importNode(source, true) as HTMLElement;
    if (config.hide)
      root.querySelectorAll(config.hide).forEach((node) => node.remove());
    root
      .querySelectorAll("img")
      .forEach((image) => image.removeAttribute("loading"));
    doc.body.style.margin = "0";
    // Keep the document at the width it has on a desktop screen; the (wider) frame
    // only decides which responsive rules apply.
    root.style.width = `${contentWidth}px`;
    root.style.maxWidth = "none";
    root.style.flex = "none";
    root.style.margin = "0";
    parent.appendChild(root);

    await doc.fonts?.ready;
    await Promise.all(
      Array.from(root.querySelectorAll("img")).map(whenImageReady),
    );

    frame.style.height = `${Math.max(root.scrollHeight, MIN_FRAME_HEIGHT)}px`;
    return { root, contentWidth, dispose };
  } catch (err) {
    dispose();
    throw err;
  }
}
