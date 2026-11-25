import type { AuthorizationDto } from '@athena-sky/shared';

/** What a member is told about the request just made: decided, awaiting a decision, or not yet submitted to the authority. */
export function requestOutcome(a: AuthorizationDto): { message: string; tone: 'ok' | 'error' | 'info' } {
  const tone = a.status === 'approved' ? 'ok' : a.status === 'rejected' ? 'error' : 'info';
  if (a.status === 'pending' && a.authority) {
    // Its answer did not come (or the authority was not reached): it is submitted again later.
    if (a.authorityState === 'submitting') return { message: `${a.reference}: not submitted to ${a.authority} yet${a.authorityError ? ` (${a.authorityError})` : ''} – retrying`, tone };
    return { message: `${a.reference}: submitted to ${a.authority} – awaiting its decision`, tone };
  }
  if (a.status === 'pending') return { message: `${a.reference}: pending – awaiting a mission manager's decision`, tone };
  return { message: `${a.reference}: ${a.status}${a.authority ? ` by ${a.authority}` : ''}`, tone };
}
