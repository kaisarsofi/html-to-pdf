/**
 * Shared driver for every page in examples/.
 *
 * The examples exercise the 'flow' layout (text, images and table rows
 * re-stacked into A4 pages), so each one reports what the engine decided:
 * how many pages, how large, and any warnings.
 *
 * Any example page just needs: #content, #go, #status, and (optionally)
 * #preview + #preview-frame.
 */
import { generatePdf } from '../../dist/index.js';

/**
 * @param {Element} content
 * @param {{ pageSize?: 'A4'|'LETTER', oversized?: 'scale'|'overflow' }} [options]
 */
export async function build(content, options = {}) {
  const result = await generatePdf(content, {
    layout: 'flow',
    render: false, // the examples draw the page exactly as it is on screen
    logWarnings: false,
    page: { mode: 'paginated', size: options.pageSize ?? 'A4' },
    flow: { oversized: options.oversized ?? 'scale' },
  });
  return { ...result, pages: Array.from({ length: result.pageCount }) };
}

function summarize({ pages, warnings, bytes }) {
  const parts = [`${pages.length} page${pages.length === 1 ? '' : 's'}`, `${(bytes.length / 1024).toFixed(1)} KB`];
  if (warnings.length) parts.push(`${warnings.length} warning(s) - see console`);
  return parts.join(' · ');
}

function wire() {
  const content = document.getElementById('content');
  const status = document.getElementById('status');
  const go = document.getElementById('go');
  const preview = document.getElementById('preview');
  const frame = document.getElementById('preview-frame');
  if (!content) return;

  const filename = document.body.dataset.filename || 'document.pdf';
  const pageSize = document.body.dataset.pageSize || 'A4';
  // Optional per-page control (only the oversized example has one).
  const modePicker = document.getElementById('oversized-mode');
  const buildOptions = () => ({ pageSize, oversized: modePicker ? modePicker.value : undefined });

  let lastUrl = null;
  const toBlobUrl = (bytes) => {
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    return lastUrl;
  };

  const run = async (mode) => {
    status.textContent = 'Measuring content and building PDF…';
    for (const b of [go, preview]) if (b) b.disabled = true;
    try {
      const result = await build(content, buildOptions());
      if (result.warnings.length) console.warn('html-to-pdf warnings:', result.warnings);

      const url = toBlobUrl(result.bytes);
      if (mode === 'download') {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        status.textContent = `Downloaded ${filename} — ${summarize(result)}`;
      } else {
        frame.src = url;
        frame.hidden = false;
        status.textContent = `Rendered below — ${summarize(result)}`;
      }
      return result;
    } catch (err) {
      console.error(err);
      status.textContent = `Failed: ${err.message}`;
      throw err;
    } finally {
      for (const b of [go, preview]) if (b) b.disabled = false;
    }
  };

  if (modePicker) {
    modePicker.addEventListener('change', () => {
      if (frame && !frame.hidden) run('preview').catch(() => {});
    });
  }

  if (go) go.addEventListener('click', () => run('download').catch(() => {}));
  if (preview) preview.addEventListener('click', () => run('preview').catch(() => {}));

  // Exposed so the examples can be driven headlessly (tests, automation)
  // without clicking anything: `await window.htmlToPdf.build()`.
  window.htmlToPdf = { build: (o) => build(content, { ...buildOptions(), ...o }), run, summarize };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wire);
} else {
  wire();
}
