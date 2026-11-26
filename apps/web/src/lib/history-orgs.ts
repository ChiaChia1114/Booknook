/**
 * The organisation each entry of this tab's browser history was opened in (kept for the tab in
 * sessionStorage): Back and Forward bring a page back in its own organisation, and a page of an
 * organisation the user has left is not shown in another.
 */
const KEY = 'athena.historyOrgs';
const MAX_ENTRIES = 300;
let entries: Record<string, string> | null = null;

function load(): Record<string, string> {
  if (!entries) {
    try {
      entries = JSON.parse(sessionStorage.getItem(KEY) ?? '{}') as Record<string, string>;
    } catch {
      entries = {};
    }
  }
  return entries;
}

/** The organisation an entry was opened in – none for "default", the key every page load starts with. */
export function entryOrg(key: string): string | undefined {
  return key === 'default' ? undefined : load()[key];
}

/** Records (or changes) the organisation of an entry; the oldest entries are forgotten. */
export function recordEntryOrg(key: string, orgId: string): void {
  if (key === 'default') return;
  const map = load();
  if (map[key] === orgId) return;
  delete map[key];
  map[key] = orgId;
  const keys = Object.keys(map);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete map[k];
  try {
    sessionStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* private mode: Back stays in the organisation chosen */
  }
}
