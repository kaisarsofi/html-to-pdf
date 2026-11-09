const REVOKE_MS = 60_000;
const PROMPT_REMOVE_MS = 5 * 60_000;
const VIEW_URL_REVOKE_MS = 10 * 60_000;

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

type PromptBox = {
  label: string;
  title: string;
  detail: string;
  actionLabel: string;
  onAction: () => void;
};

/**
 * A small centred box with one main button. A click on that button is a fresh tap, which is what
 * iOS Safari needs to save a file or to open a new tab.
 */
function showPromptBox({ label, title, detail, actionLabel, onAction }: PromptBox) {
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
  const heading = styled(document.createElement("p"), {
    margin: "0 0 4px",
    fontSize: "17px",
    fontWeight: "600",
  });
  const text = styled(document.createElement("p"), {
    margin: "0 0 18px",
    fontSize: "13px",
    lineHeight: "1.4",
    color: "#666666",
    whiteSpace: "pre-line",
    wordBreak: "break-word",
  });
  const action = styled(document.createElement("button"), {
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
  overlay.setAttribute("aria-label", label);
  heading.textContent = title;
  text.textContent = detail;
  action.type = "button";
  action.textContent = actionLabel;
  close.type = "button";
  close.textContent = "Close";

  const dismiss = () => overlay.remove();

  action.addEventListener("click", () => {
    onAction();
    dismiss();
  });
  close.addEventListener("click", dismiss);

  card.append(heading, text, action, close);
  overlay.append(card);
  document.body.appendChild(overlay);
  setTimeout(dismiss, PROMPT_REMOVE_MS);
}

/**
 * "Your PDF is ready" with a Save button. A click on it is a fresh tap, so iOS Safari saves the
 * file instead of opening a preview. Used where the direct download cannot start at the first tap.
 */
export function showSavePrompt(blob: Blob, fileName: string): void {
  showPromptBox({
    label: "PDF ready",
    title: "Your PDF is ready",
    detail: fileName,
    actionLabel: "Save PDF",
    onAction: () => saveBlob(blob, fileName),
  });
}

/**
 * Shown once a direct download has been filled in: a View PDF button that opens the file in a new
 * tab, so nobody has to dig through Downloads to open it. The file is in Downloads either way.
 */
export function showViewPrompt(blob: Blob, fileName: string): void {
  showPromptBox({
    label: "PDF ready",
    title: "Your PDF is ready",
    detail: `${fileName}\nView it now, or find it later in Downloads.`,
    actionLabel: "View PDF",
    onAction: () => {
      const url = URL.createObjectURL(blob);

      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), VIEW_URL_REVOKE_MS);
    },
  });
}
