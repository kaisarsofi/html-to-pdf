/**
 * Some bundlers (Turbopack) replace `new URL('./file', import.meta.url)` with a stand-in that
 * only holds the path, e.g. "/_next/static/media/file.js". Reading it as a string and resolving
 * it against the page gives a real absolute URL whatever the bundler produced.
 */
export function toAbsoluteUrl(asset: { toString(): string }, base: string): URL {
  return new URL(String(asset), base);
}
