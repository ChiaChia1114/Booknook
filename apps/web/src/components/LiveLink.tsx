/**
 * The real-time link as the pages say it: live, being made (before the drones were first
 * received), lost (it is made again) or delayed (open, but what it brings comes late – slow or
 * stalled). Lost or delayed, the data still shown is as it was then and is not shown as live.
 */
import type { DroneView, LiveSnapshot } from '../api/live';
import { useLive } from '../state/live';
import { Loading } from './ui';

export type LinkState = 'live' | 'connecting' | 'lost' | 'delayed';

export const linkState = (live: LiveSnapshot): LinkState => (live.current ? 'live' : !live.synced ? 'connecting' : live.delayed ? 'delayed' : 'lost');

/** The link brought the drones, but what is shown is not live now (lost, or delayed). */
export const linkDown = (live: LiveSnapshot): boolean => live.synced && !live.current;

/** "Real-time link lost at 14:03:22 – reconnecting…" / "Real-time link delayed since 14:03:22 – …" */
export function lostText(live: LiveSnapshot): string {
  const at = live.lostAt ? new Date(live.lostAt).toLocaleTimeString() : null;
  if (live.delayed) return `Real-time link delayed${at ? ` since ${at}` : ''} – waiting for it to catch up…`;
  return `Real-time link lost${at ? ` at ${at}` : ''} – reconnecting…`;
}

/** The short form of `lostText` (the console's toolbar): "Link lost 14:03:22" / "Link delayed since 14:03:22". */
export function lostShort(live: LiveSnapshot): string {
  const at = live.lostAt ? new Date(live.lostAt).toLocaleTimeString() : null;
  return live.delayed ? `Link delayed${at ? ` since ${at}` : ''}` : `Link lost${at ? ` ${at}` : ''}`;
}

/**
 * A drone whose data stopped coming: "Nothing new from Falcon-1 since 14:03:22 – its link is slow
 * or stalled." (once the cloud said it has nothing newer either; before that, without the cause),
 * followed by `then` (what that means for the values shown) – or, nothing having come from it yet,
 * "No data from Falcon-1 yet."
 */
export function lateText(d: DroneView, then?: string): string {
  const cause = d.lateDrone ? ' – its link is slow or stalled' : '';
  if (d.dataAt <= 0) return `No data from ${d.name} yet${cause}.`;
  return `Nothing new from ${d.name} since ${new Date(d.dataAt).toLocaleTimeString()}${cause}.${then ? ` ${then}` : ''}`;
}

/** The short form of `lateText`: "no new data", or "no data yet". */
export const lateLabel = (d: Pick<DroneView, 'dataAt'>): string => (d.dataAt > 0 ? 'no new data' : 'no data yet');

/**
 * What the link is doing while it brings no live data (nothing while it does): "Connecting to the
 * real-time service…" the first time, else that it was lost or is delayed – `what` names the data
 * that waits for it, `lost` says what that means where the note is shown (e.g. that the states
 * shown are as they were then).
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
