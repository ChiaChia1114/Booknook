/** Where to go after signing in: a page of this application – anything else goes to the dashboard. */
export function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || /[\\\u0000-\u001f]/.test(raw)) return '/';
  return raw;
}
