const REVOKE_MS = 60_000;
const PROMPT_REMOVE_MS = 5 * 60_000;

/** Saves a blob through a link click. Only browsers that allow it after a wait save it directly. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = fileName;
  link.click();
  // Revoke after the browser has had time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_MS);
}

function styled<T extends HTMLElement>(
  element: T,
  style: Partial<CSSStyleDeclaration>,
): T {
  Object.assign(element.style, style);

  return element;
}

/**
 * A small "your PDF is ready" box with a Save button. A click on that button is a fresh tap,
 * so iOS Safari saves the file instead of opening a preview. Used where the direct download
 * cannot start at the first tap.
 */
export function showSavePrompt(blob: Blob, fileName: string): void {
  const overlay = styled(document.createElement("div"), {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    background: "rgba(0, 0, 0, 0.45)",
    fontFamily: "system-ui, -apple-system, sans-serif",
  });
  const card = styled(document.createElement("div"), {
    width: "100%",
    maxWidth: "320px",
    padding: "22px",
    borderRadius: "16px",
    background: "#ffffff",
    color: "#111111",
    textAlign: "center",
    boxShadow: "0 12px 40px rgba(0, 0, 0, 0.3)",
  });
  const title = styled(document.createElement("p"), {
    margin: "0 0 4px",
    fontSize: "17px",
    fontWeight: "600",
  });
  const name = styled(document.createElement("p"), {
    margin: "0 0 18px",
    fontSize: "13px",
    color: "#666666",
    wordBreak: "break-word",
  });
  const save = styled(document.createElement("button"), {
    width: "100%",
    padding: "13px",
    border: "0",
    borderRadius: "12px",
    background: "#111111",
    color: "#ffffff",
    fontSize: "16px",
    fontWeight: "600",
  });
  const close = styled(document.createElement("button"), {
    marginTop: "10px",
    padding: "8px",
    border: "0",
    background: "transparent",
    color: "#666666",
    fontSize: "14px",
  });

  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "PDF ready");
  title.textContent = "Your PDF is ready";
  name.textContent = fileName;
  save.type = "button";
  save.textContent = "Save PDF";
  close.type = "button";
  close.textContent = "Close";

  const dismiss = () => overlay.remove();

  save.addEventListener("click", () => {
    saveBlob(blob, fileName);
    dismiss();
  });
  close.addEventListener("click", dismiss);

  card.append(title, name, save, close);
  overlay.append(card);
  document.body.appendChild(overlay);
  setTimeout(dismiss, PROMPT_REMOVE_MS);
}
