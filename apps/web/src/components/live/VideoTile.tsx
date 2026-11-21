/**
 * One drone in the live console's video stack: live video, status chips (armed /
 * disarmed, flight mode), quick actions and the key flight values. The selected drone is
 * framed in red.
 */
import { useEffect, useRef, useState } from 'react';
import type { CommandName, CommandParams } from '@athena-sky/shared';
import type { DroneView } from '../../api/live';
import { useLive } from '../../state/live';
import { useToast } from '../ui';

const MODE_LABEL: Record<string, string> = {
  MISSION: 'Auto',
  GUIDED: 'Guided',
  HOLD: 'Loiter',
  POSCTL: 'Position',
  RTL: 'RTL',
  LAND: 'Land',
  TAKEOFF: 'Takeoff',
};

/** Remaining flight time from the battery discharge rate of the last minute (s), down to a 15 % reserve. */
function useRemainingTime(d: DroneView): number | null {
  const hist = useRef<{ t: number; pct: number }[]>([]);
  const t = d.telemetry;
  useEffect(() => {
    if (!t) return;
    const h = hist.current;
    const last = h[h.length - 1];
    if (!t.inAir) {
      hist.current = [];
      return;
    }
    if (!last || t.t - last.t >= 1000) h.push({ t: t.t, pct: t.battery.pct });
    while (h.length > 0 && t.t - h[0]!.t > 90_000) h.shift();
  }, [t]);
  const h = hist.current;
  if (!t?.inAir || h.length < 10) return null;
  const n = h.length;
  const mx = h.reduce((s, p) => s + p.t, 0) / n;
  const my = h.reduce((s, p) => s + p.pct, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of h) {
    sxx += (p.t - mx) ** 2;
    sxy += (p.t - mx) * (p.pct - my);
  }
  const slope = sxx > 0 ? sxy / sxx : 0; // %/ms
  if (slope >= -1e-9) return null;
  return Math.max(0, (t.battery.pct - 15) / -slope / 1000);
}

const fmtRemaining = (s: number | null) => (s === null ? '—' : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);

export function VideoTile({
  d,
  selected,
  onSelect,
  onDetails,
  onReposition,
  takeoffAlt,
  swarm,
}: {
  d: DroneView;
  selected: boolean;
  onSelect(): void;
  onDetails(): void;
  onReposition(): void;
  takeoffAlt: number;
  /** Role and state of the drone in a running swarm operation. */
  swarm?: { label: string; state: string } | null;
}) {
  const { client, live } = useLive();
  const toast = useToast();
  const [video, setVideo] = useState(true);
  const t = d.telemetry;
  const remaining = useRemainingTime(d);
  const controlledByOther = !!d.controller && d.controller.userId !== live.userId;
  const canCmd = live.canControl && d.online && !controlledByOther;

  useEffect(() => {
    if (!client) return;
    client.setVideo(d.droneId, video && d.online, 'sd', 'tile');
    return () => client.setVideo(d.droneId, false, 'sd', 'tile');
  }, [client, video, d.droneId, d.online]);

  const cmd = async (command: CommandName, params: CommandParams = {}, confirmText?: string) => {
    if (!client) return;
    if (confirmText && !confirm(confirmText)) return;
    const r = await client.command(d.droneId, command, params);
    toast(`${d.name}: ${command} ${r.result}${r.message ? ` – ${r.message}` : ''}`, r.result === 'accepted' || r.result === 'completed' ? 'ok' : 'error');
  };
  const videoFresh = d.frameUrl && Date.now() - d.frameAt < 5000;
  const mode = t ? String(t.mode) : null;

  return (
    <div className={`vtile${selected ? ' selected' : ''}`} data-testid={`tile-${d.name}`} onClick={onSelect}>
      <div className="vtile-head">
        <b className="truncate">{d.name}</b>
        {!d.online ? <span className="chip">offline</span> : t?.armed ? <span className="chip ok">Armed</span> : <span className="chip danger">Disarmed</span>}
        {mode && <span className="chip accent" title={mode}>{MODE_LABEL[mode] ?? mode}</span>}
        {d.controller && <span className="chip" title={`Pilot in command: ${d.controller.name}`}>👤 {d.controller.name.split(' ')[0]}</span>}
        {swarm && (
          <span className={`chip${swarm.state === 'waiting' ? ' warn' : swarm.state === 'detached' ? ' danger' : ''}`} title={`Swarm: ${swarm.label} – ${swarm.state}`} data-testid={`tile-swarm-${d.name}`}>
            ⬡ {swarm.state === 'waiting' ? 'waiting' : swarm.label}
          </span>
        )}
        <span className="spacer" />
        <button
          className="icon-btn"
          title={video ? 'Stop video' : 'Live video'}
          aria-label={video ? 'Stop video' : 'Live video'}
          onClick={(e) => {
            e.stopPropagation();
            setVideo(!video);
          }}
        >
          {video ? '■' : '▶'}
        </button>
        <button
          className="icon-btn"
          title="Details & full controls"
          aria-label={`Details ${d.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onDetails();
          }}
        >
          ⋯
        </button>
      </div>
      <div className="vtile-body">
        {live.canControl && (
          <div className="vtile-actions" onClick={(e) => e.stopPropagation()}>
            <button className="icon-btn" title="Take off" aria-label={`Take off ${d.name}`} disabled={!canCmd || !!t?.inAir} onClick={() => cmd('takeoff', { alt: takeoffAlt }, `Take off ${d.name} to ${takeoffAlt} m?`)}>
              ⤒
            </button>
            <button className="icon-btn" title="Pause / hold position" aria-label={`Hold ${d.name}`} disabled={!canCmd || !t?.inAir} onClick={() => cmd(mode === 'MISSION' ? 'mission_pause' : 'hold')}>
              ❚❚
            </button>
            <button className="icon-btn" title="Resume mission" aria-label={`Resume ${d.name}`} disabled={!canCmd || !t?.inAir || !d.mission} onClick={() => cmd('mission_resume')}>
              ▶
            </button>
            <button className="icon-btn" title="Reposition" aria-label={`Reposition ${d.name}`} disabled={!canCmd || !t?.inAir} onClick={onReposition}>
              ⌖
            </button>
            <button className="icon-btn" title="Return home" aria-label={`Return home ${d.name}`} disabled={!canCmd || !t?.inAir} onClick={() => cmd('rtl')}>
              ⌂
            </button>
            <button className="icon-btn danger" title="Land" aria-label={`Land ${d.name}`} disabled={!canCmd || !t?.inAir} onClick={() => cmd('land')}>
              ⤓
            </button>
          </div>
        )}
        <div className="vtile-video" data-testid={`tile-video-${d.name}`}>
          {video && videoFresh ? <img src={d.frameUrl!} alt={`${d.name} live video`} /> : <div className="placeholder small">{!d.online ? 'Drone offline' : video ? 'Waiting for video…' : 'Video off'}</div>}
        </div>
      </div>
      <div className="vtile-foot" data-testid={`tile-foot-${d.name}`}>
        <span title="Ground speed">⇢ {t ? t.groundSpeed.toFixed(1) : '—'} m/s</span>
        <span title="Satellites used">🛰 {t ? t.gps.satellites : '—'}</span>
        <span title="Estimated flight time left (15 % reserve)">⏱ {fmtRemaining(remaining)}</span>
        <span title="Altitude above home">⇡ {t ? Math.round(t.altRel) : '—'} m</span>
        <span title="Battery" style={{ color: t && t.battery.pct < 25 ? 'var(--danger)' : undefined }}>
          ▮ {t ? Math.round(t.battery.pct) : '—'}%
        </span>
      </div>
    </div>
  );
}
