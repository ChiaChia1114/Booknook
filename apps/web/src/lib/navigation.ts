/** Where to go after signing in: a page of this application – anything else goes to the dashboard. */
export function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || /[\\\u0000-\u001f]/.test(raw)) return '/';
  return raw;
}

/**
 * Where the page goes when another organisation is chosen: the same page, without what its address
 * selects in the previous organisation (a drone: `?drone=…`, a panel, a period); a page of one of
 * its items (a drone, flight or mission) gives way to the list of that section. Settings keeps its tab.
 */
export function orgSwitchTarget(pathname: string, search: string): string {
  const item = /^\/(fleet|flights|missions)\/[^/]+\/?$/.exec(pathname);
  if (item) return `/${item[1]}`;
  const tab = pathname === '/settings' ? new URLSearchParams(search).get('tab') : null;
  return tab ? `/settings?tab=${encodeURIComponent(tab)}` : pathname;
}
