/**
 * What happens on iPhone and iPad once the file has been saved:
 * 'dialog' shows a small "Your PDF is ready" box with a View PDF button, 'preview' goes straight
 * to the PDF, 'none' does nothing.
 */
export type AfterDownload = "dialog" | "preview" | "none";

export function resolveAfterDownload(value: AfterDownload | undefined): AfterDownload {
  return value === "preview" || value === "none" ? value : "dialog";
}
