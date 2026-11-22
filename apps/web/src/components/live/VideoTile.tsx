/**
 * One drone in the live console's video stack: live video, status chips (armed /
 * disarmed, flight mode), quick actions and the key flight values. The selected drone is
 * framed in red.
 */
import { useEffect, useRef, useState } from 'react';
import { BatteryMedium, Crosshair, Ellipsis, Gauge, Hexagon, House, MoveUp, Pause, Play, PlaneLanding, PlaneTakeoff, Satellite, ScanSearch, Square, Timer, UserRound, Video } from 'lucide-react';
import type { CommandName, CommandParams } from '@athena-sky/shared';
import type { DroneView } from '../../api/live';
import { api, errorMessage } from '../../api/client';
import { useOrgId } from '../../state/auth';
import { useLive } from '../../state/live';
import { useToast } from '../ui';

/** Flight-mode names as the autopilot (and the video HUD) reports them, in readable case. */
const MODE_LABEL: Record<string, string> = {
  MISSION: 'Mission',
  GUIDED: 'Guided',
  HOLD: 'Hold',
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
  const orgId = useOrgId();
  const toast = useToast();
  const [video, setVideo] = useState(true);
  /** The drone reports no camera: no video is asked for, and the tile says so. */
  const noCamera = d.online && !d.videoAvailable;
  const watching = video && !noCamera;
  const t = d.telemetry;
  const remaining = useRemainingTime(d);
  const controlledByOther = !!d.controller && d.controller.userId !== live.userId;
  const canCmd = live.canControl && d.online && !controlledByOther;
  // A member of a running swarm operation is released by the operation, not by its own buttons.
  const inSwarm = !!swarm && swarm.state !== 'detached' && swarm.state !== 'done';

  useEffect(() => {
    if (!client) return;
    client.setVideo(d.droneId, watching && d.online, 'sd', 'tile');
    return () => client.setVideo(d.droneId, false, 'sd', 'tile');
  }, [client, watching, d.droneId, d.online]);

  const cmd = async (command: CommandName, params: CommandParams = {}, confirmText?: string) => {
    if (!client) return;
    if (confirmText && !confirm(confirmText)) return;
    const r = await client.command(d.droneId, command, params);
    toast(`${d.name}: ${command} ${r.result}${r.message ? ` – ${r.message}` : ''}`, r.result === 'accepted' || r.result === 'completed' ? 'ok' : 'error');
  };
  const videoFresh = d.frameUrl && Date.now() - d.frameAt < 5000;
  const mode = t ? String(t.mode) : null;
  const ai = d.ai ?? null;
  const objects = ai?.enabled && Date.now() - d.detectionsAt < 5000 ? d.detections : [];
  const [picked, setPicked] = useState<number | null>(null);
  const pickedObj = objects.find((o) => o.trackId === picked) ?? null;
  const following = ai?.following ?? null;
  const toggleAi = async () => {
    try {
      await api(`/api/v2/organisations/${orgId}/drones/${d.droneId}/ai`, { body: { enabled: !ai?.enabled } });
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  const follow = async (trackId: number | null) => {
    try {
      if (trackId === null) await api(`/api/v2/organisations/${orgId}/drones/${d.droneId}/ai/follow`, { method: 'DELETE' });
      else await api(`/api/v2/organisations/${orgId}/drones/${d.droneId}/ai/follow`, { body: { trackId } });
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <div className={`vtile${selected ? ' selected' : ''}`} data-testid={`tile-${d.name}`} onClick={onSelect}>
      <div className="vtile-head">
        <b className="truncate vtile-name" title={d.name}>
          {d.name}
        </b>
        <span className="vtile-chips">
          {!d.online ? <span className="chip">offline</span> : t?.armed ? <span className="chip ok">Armed</span> : <span className="chip danger">Disarmed</span>}
          {mode && <span className="chip accent" title={mode}>{MODE_LABEL[mode] ?? mode}</span>}
          {d.controller && (
            <span className="chip" title={`Pilot in command: ${d.controller.name}`} aria-label={`Pilot in command: ${d.controller.name}`}>
              <UserRound />
            </span>
          )}
          {swarm && (
            <span className={`chip${swarm.state === 'waiting' ? ' warn' : swarm.state === 'detached' ? ' danger' : ''}`} title={`Swarm: ${swarm.label} – ${swarm.state}`} data-testid={`tile-swarm-${d.name}`}>
              <Hexagon /> {swarm.state === 'waiting' ? 'waiting' : swarm.label}
            </span>
          )}
          {ai?.enabled && (
            <span className={`chip${following !== null ? (ai.followStatus === 'searching' ? ' warn' : ' danger') : ' accent'}`} data-testid={`tile-ai-${d.name}`} title={ai.source === 'onboard' ? 'Detections from the on-board AI' : 'Cloud AI detection'}>
              {following !== null ? (
                <>
                  {ai.followStatus === 'searching' ? <ScanSearch /> : <Crosshair />} #{following}
                </>
              ) : (
                `AI ${objects.length}`
              )}
            </span>
        )}
        </span>
        <span className="vtile-tools">
          <button
            className={`icon-btn${ai?.enabled ? ' active' : ''}`}
            title={!live.canControl ? 'AI object detection – only pilots can turn it on or off' : ai?.enabled ? 'Stop AI object detection' : 'AI object detection (people, vehicles)'}
            aria-label={`AI detection ${d.name}`}
            aria-pressed={!!ai?.enabled}
            disabled={!d.online || !live.canControl}
            onClick={(e) => {
              e.stopPropagation();
              void toggleAi();
            }}
          >
            AI
          </button>
          <button
            className="icon-btn"
            title={noCamera ? 'This drone reports no camera' : watching ? 'Stop video' : 'Live video'}
            aria-label={watching ? 'Stop video' : 'Live video'}
            disabled={noCamera}
            onClick={(e) => {
              e.stopPropagation();
              setVideo(!video);
            }}
          >
            {watching ? <Square /> : <Video />}
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
            <Ellipsis />
        </button>
        </span>
      </div>
      <div className={`vtile-body${live.canControl ? '' : ' watch-only'}`}>
        {live.canControl && (
          <div className="vtile-actions" onClick={(e) => e.stopPropagation()}>
            <button className="icon-btn" title="Take off" aria-label={`Take off ${d.name}`} disabled={!canCmd || !!t?.inAir} onClick={() => cmd('takeoff', { alt: takeoffAlt }, `Take off ${d.name} to ${takeoffAlt} m?`)}>
              <PlaneTakeoff />
            </button>
            <button className="icon-btn" title="Pause / hold position" aria-label={`Hold ${d.name}`} disabled={!canCmd || !t?.inAir} onClick={() => cmd(mode === 'MISSION' ? 'mission_pause' : 'hold')}>
              <Pause />
            </button>
            {/* In the air: resume the mission; on the ground: start the loaded mission (arms and takes off).
                Not for a member of a running swarm operation: the operation releases it. */}
            <button
              className="icon-btn"
              title={inSwarm ? "Flies in a swarm operation – use the operation's controls in the Swarm panel" : t?.inAir ? 'Resume mission' : 'Start mission'}
              aria-label={t?.inAir ? `Resume ${d.name}` : `Start mission on ${d.name}`}
              disabled={!canCmd || !d.mission || inSwarm}
              onClick={() => (t?.inAir ? cmd('mission_resume') : cmd('mission_start', {}, `Start mission "${d.mission?.name}" on ${d.name}? It arms and takes off.`))}
            >
              <Play />
            </button>
            <button className="icon-btn" title="Reposition" aria-label={`Reposition ${d.name}`} disabled={!canCmd || !t?.inAir} onClick={onReposition}>
              <Crosshair />
            </button>
            <button className="icon-btn" title="Return home" aria-label={`Return home ${d.name}`} disabled={!canCmd || !t?.inAir} onClick={() => cmd('rtl')}>
              <House />
            </button>
            <button className="icon-btn danger" title="Land" aria-label={`Land ${d.name}`} disabled={!canCmd || !t?.inAir} onClick={() => cmd('land')}>
              <PlaneLanding />
            </button>
          </div>
        )}
        <div className="vtile-video" data-testid={`tile-video-${d.name}`}>
          {watching && videoFresh ? (
            <img src={d.frameUrl!} alt={`${d.name} live video`} />
          ) : (
            <div className="placeholder small">{!d.online ? 'Drone offline' : noCamera ? 'No camera on this drone' : video ? 'Waiting for video…' : 'Video off'}</div>
          )}
          {watching && videoFresh &&
            objects.map((o) => (
              <button
                key={o.trackId}
                className={`det-box ${o.cls}${o.trackId === following ? ' followed' : ''}${o.trackId === picked ? ' picked' : ''}`}
                style={{ left: `${o.box[0] * 100}%`, top: `${o.box[1] * 100}%`, width: `${o.box[2] * 100}%`, height: `${o.box[3] * 100}%` }}
                title={`#${o.trackId} ${o.color ?? ''} ${o.cls} (${Math.round(o.score * 100)} %)`}
                aria-label={`Object ${o.trackId} ${o.cls}`}
                data-testid={`det-${d.name}-${o.trackId}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setPicked(o.trackId === picked ? null : o.trackId);
                }}
              >
                <span className="det-label">
                  #{o.trackId} {o.cls}
                </span>
              </button>
            ))}
        </div>
      </div>
      {(pickedObj || following !== null) && (
        <div className="vtile-ai row small" onClick={(e) => e.stopPropagation()} data-testid={`tile-ai-bar-${d.name}`}>
          {following !== null ? (
            <>
              <span className="truncate">
                {ai?.followStatus === 'searching' ? 'Searching for' : 'Following'} #{following}
              </span>
              <span className="spacer" />
              <button className="btn small" onClick={() => follow(null)} disabled={!live.canControl}>
                Stop following
              </button>
            </>
          ) : (
            pickedObj && (
              <>
                <span className="truncate">
                  #{pickedObj.trackId} {pickedObj.color ? `${pickedObj.color} ` : ''}
                  {pickedObj.cls}
                  {pickedObj.speedMs !== null ? ` · ${pickedObj.speedMs.toFixed(1)} m/s` : ''}
                </span>
                <span className="spacer" />
                <button className="btn small primary" disabled={!canCmd || !t?.inAir} onClick={() => follow(pickedObj.trackId)} title={t?.inAir ? 'Follow this object' : 'Take off first'}>
                  Follow
                </button>
              </>
            )
          )}
        </div>
      )}
      <div className="vtile-foot" data-testid={`tile-foot-${d.name}`}>
        <span title="Ground speed">
          <Gauge /> {t ? t.groundSpeed.toFixed(1) : '—'} m/s
        </span>
        <span title="Satellites used">
          <Satellite /> {t ? t.gps.satellites : '—'}
        </span>
        <span title="Estimated flight time left (15 % reserve)">
          <Timer /> {fmtRemaining(remaining)}
        </span>
        <span title="Altitude above home">
          <MoveUp /> {t ? Math.round(t.altRel) : '—'} m
        </span>
        <span title="Battery" style={{ color: t && t.battery.pct < 25 ? 'var(--danger)' : undefined }}>
          <BatteryMedium /> {t ? Math.round(t.battery.pct) : '—'}%
        </span>
      </div>
    </div>
  );
}
