/**
 * Whether an error is a part of the application that could not be loaded – typically a bundle
 * of the version this page was opened with, gone since the server was updated.
 */
export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /dynamically imported module|Importing a module script failed|Unable to preload CSS|Loading chunk .* failed/i.test(msg);
}

const RELOADED_AT = 'athena.reloadedForUpdate';

/**
 * Reloads the page to pick up the new version of the application – once: false (and no
 * reload) when it was just tried, or when the browser cannot remember that it was.
 */
export function reloadForUpdate(): boolean {
  try {
    if (Date.now() - Number(sessionStorage.getItem(RELOADED_AT) ?? 0) < 30_000) return false;
    sessionStorage.setItem(RELOADED_AT, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}
