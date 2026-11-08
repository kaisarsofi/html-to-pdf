/**
 * iPhone, iPod and iPad. iPadOS Safari reports itself as a Mac, so a Mac that also has a
 * touch screen counts as an iPad.
 */
export function isIosBrowser(
  env: { userAgent: string; platform: string; maxTouchPoints: number } = navigator,
): boolean {
  if (/iP(hone|od|ad)/.test(env.userAgent)) return true;

  return env.platform === "MacIntel" && env.maxTouchPoints > 1;
}
