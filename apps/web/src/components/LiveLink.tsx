/**
 * The real-time link as the pages say it: live, being made (before the drones were first
 * received), or lost (it is tried again – the data still shown is as it was when it was lost).
 */
import type { LiveSnapshot } from '../api/live';
import { useLive } from '../state/live';
import { Loading } from './ui';

export type LinkState = 'live' | 'connecting' | 'lost';

export const linkState = (live: LiveSnapshot): LinkState => (live.current ? 'live' : live.synced ? 'lost' : 'connecting');

/** "Real-time link lost at 14:03:22 – reconnecting…" */
export function lostText(live: LiveSnapshot): string {
  const at = live.lostAt ? new Date(live.lostAt).toLocaleTimeString() : null;
  return `Real-time link lost${at ? ` at ${at}` : ''} – reconnecting…`;
}

/**
 * What the link is doing while it brings no live data (nothing while it does): "Connecting to the
 * real-time service…" the first time, else that it was lost – `what` names the data that waits
 * for it, `lost` says what the loss means where the note is shown (e.g. that the states shown are
 * as they were then).
 */
export function LiveLinkNote({ small, lost, what }: { small?: boolean; lost?: string; what?: string }) {
  const { live } = useLive();
  const state = linkState(live);
  if (state === 'live') return null;
  if (state === 'connecting') {
    const text = what ? `${what}: connecting to the real-time service…` : 'Connecting to the real-time service…';
    return small ? (
      <div className="muted small" role="status">
        {text}
      </div>
    ) : (
      <Loading what={text} />
    );
  }
  const text = lostText(live);
  return (
    <div className="link-lost small" role="status" data-testid="link-lost-note">
      {what ? `${what}: ${text[0]!.toLowerCase()}${text.slice(1)}` : text}
      {lost ? ` ${lost}` : ''}
    </div>
  );
}
