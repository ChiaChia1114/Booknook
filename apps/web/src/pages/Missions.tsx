import { FileUp, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { MissionDto, ScheduleDto } from '@athena-sky/shared';
import { emptyPlan, cleanName, hasVisibleText } from '@athena-sky/shared';
import { api, errorMessage } from '../api/client';
import { useApi, useLateNotice, useStillShown } from '../hooks';
import { useAuth, useOrgId } from '../state/auth';
import { AsyncButton, Badge, Card, Empty, ErrorBox, Loading, Modal, PageHead, fmtDate, fmtDistance, fmtDuration, loadError, useToast } from '../components/ui';

/**
 * What a mission dialog's action does with its answer: in the dialog while it is shown – the new
 * mission opens in the planner, or the dialog says why it could not be made. Answered after the
 * dialog was closed (and maybe opened again, or the other one opened), or after the page was left
 * (another page, another organisation), it does not act on the dialog or page shown now: a message
 * says the mission was made (the Missions page, if still shown, lists it) or why it could not be.
 */
function useMissionAnswer(what: string, pageShown: () => boolean, onCreated: () => unknown) {
  const navigate = useNavigate();
  const notice = useLateNotice();
  const shown = useStillShown();
  const [error, setError] = useState<string | null>(null);
  const run = async (name: string, make: () => Promise<MissionDto>) => {
    try {
      const m = await make();
      if (shown()) navigate(`/missions/${m.id}`);
      else {
        notice(`Mission "${m.name}" ${what === 'import' ? 'imported' : 'created'}`, 'ok');
        if (pageShown()) void onCreated();
      }
    } catch (err) {
      if (shown()) setError(errorMessage(err));
      else notice(`${what === 'import' ? 'Import' : 'New mission'}${name ? ` "${name}"` : ''}: ${errorMessage(err)}`, 'error');
    }
  };
  return { error, run };
}

/** "New mission": opened empty each time – nothing typed before, none of an earlier answer. */
function NewMissionModal({ orgId, pageShown, onCreated, onClose }: { orgId: string; pageShown(): boolean; onCreated(): unknown; onClose(): void }) {
  const [name, setName] = useState('');
  const answer = useMissionAnswer('create', pageShown, onCreated);
  return (
    <Modal
      title="New mission"
      onClose={onClose}
      actions={
        <AsyncButton
          className="btn primary"
          disabled={!hasVisibleText(name)}
          onClick={() => answer.run(cleanName(name), () => api<MissionDto>(`/api/v2/organisations/${orgId}/missions`, { body: { name, plan: emptyPlan() } }))}
        >
          Create & open planner
        </AsyncButton>
      }
    >
      <ErrorBox error={answer.error} />
      <label className="field">
        Mission name
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Bridge inspection – north span" />
      </label>
    </Modal>
  );
}

/** "Import mission": opened empty each time – no file or name chosen before, none of an earlier answer. */
function ImportMissionModal({ orgId, pageShown, onCreated, onClose }: { orgId: string; pageShown(): boolean; onCreated(): unknown; onClose(): void }) {
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const answer = useMissionAnswer('import', pageShown, onCreated);
  return (
    <Modal
      title="Import mission"
      onClose={onClose}
      actions={
        <AsyncButton
          className="btn primary"
          disabled={!file}
          onClick={() => {
            const chosen = file!;
            const named = cleanName(name) || chosen.name.replace(/\.[^.]+$/, '');
            return answer.run(named, async () => {
              const content = await chosen.text();
              const format = /\.plan$/i.test(chosen.name) || content.trimStart().startsWith('{') ? 'plan' : 'waypoints';
              return api<MissionDto>(`/api/v2/organisations/${orgId}/missions/import`, { body: { name: named, format, content } });
            });
          }}
        >
          Import
        </AsyncButton>
      }
    >
      <div className="form">
        <p className="small muted">QGroundControl plan files (.plan) and Mission Planner / ArduPilot waypoint files (QGC WPL 110) are supported.</p>
        <ErrorBox error={answer.error} />
        <input type="file" accept=".plan,.waypoints,.txt,.json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <label className="field">
          Name (optional)
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}

export function MissionsPage() {
  const orgId = useOrgId();
  const { can } = useAuth();
  // What is said of an action may come after another page or organisation was chosen: it names both.
  const notice = useLateNotice();
  // A mission created or imported after the page was left (e.g. for another organisation) is not opened.
  const stillShown = useStillShown();
  const missions = useApi<MissionDto[]>(`/api/v2/organisations/${orgId}/missions`);
  const schedules = useApi<ScheduleDto[]>(`/api/v2/organisations/${orgId}/schedules`);
  const [dialog, setDialog] = useState<'create' | 'import' | null>(null);
  const edit = can('mission.edit');
  return (
    <div className="content">
      <PageHead
        title="3D Mission Planning"
        subtitle="Plan autonomous missions in 3D with terrain, airspace and ground hazards; schedule them for your fleet."
        actions={
          edit && (
            <>
              <button className="btn" onClick={() => setDialog('import')}>
                <FileUp /> Import .plan / .waypoints
              </button>
              <button className="btn primary" onClick={() => setDialog('create')}>
                <Plus /> New mission
              </button>
            </>
          )
        }
      />
      <div className="stack">
        <Card title="Missions">
          <ErrorBox error={loadError('The missions', missions.error)} />
          {!missions.data ? (
            missions.error ? null : <Loading />
          ) : missions.data.length === 0 ? (
            <Empty>No missions yet – create one and add waypoints on the 3D map.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table" data-testid="missions-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th className="num">Items</th>
                    <th className="num">Distance</th>
                    <th className="num">Est. time</th>
                    <th className="num">Battery</th>
                    <th>Updated</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {missions.data.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <Link to={`/missions/${m.id}`}>{m.name}</Link>
                        <div className="small muted">
                          {m.plan.rallyPoints.length > 0 && `${m.plan.rallyPoints.length} rally point(s) · `}
                          {m.plan.geofence ? 'geofence · ' : ''}by {m.createdByName ?? '—'}
                        </div>
                      </td>
                      <td className="num">{m.plan.items.length}</td>
                      <td className="num">{fmtDistance(m.stats.totalDistanceM)}</td>
                      <td className="num">{fmtDuration(m.stats.estimatedTimeS)}</td>
                      <td className="num">{m.stats.estimatedBatteryPct.toFixed(0)} %</td>
                      <td>{fmtDate(m.updatedAt)}</td>
                      <td className="row">
                        {edit && (
                          <>
                            <AsyncButton
                              className="btn small"
                              onClick={async () => {
                                try {
                                  await api(`/api/v2/organisations/${orgId}/missions/${m.id}/duplicate`, { method: 'POST' });
                                  await missions.reload();
                                } catch (err) {
                                  notice(`Mission "${m.name}" not duplicated: ${errorMessage(err)}`, 'error');
                                }
                              }}
                            >
                              Duplicate
                            </AsyncButton>
                            <AsyncButton
                              className="btn small danger"
                              onClick={async () => {
                                if (!confirm(`Delete mission "${m.name}"? Its scheduled operations are removed too.`)) return;
                                try {
                                  await api(`/api/v2/organisations/${orgId}/missions/${m.id}`, { method: 'DELETE' });
                                  await missions.reload();
                                  await schedules.reload();
                                } catch (err) {
                                  notice(`Mission "${m.name}" not deleted: ${errorMessage(err)}`, 'error');
                                }
                              }}
                            >
                              Delete
                            </AsyncButton>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="Upcoming operations">
          <ErrorBox error={loadError('The scheduled operations', schedules.error)} />
          {!schedules.data ? (
            schedules.error ? null : <Loading />
          ) : schedules.data.length === 0 ? (
            <Empty>No operations scheduled. Schedule a mission from the planner.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Planned</th>
                    <th>Mission</th>
                    <th>Drone</th>
                    <th>Pilot</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {schedules.data.map((s) => (
                    <tr key={s.id}>
                      <td>{fmtDate(s.plannedAt)}</td>
                      <td>
                        {s.missionId ? <Link to={`/missions/${s.missionId}`}>{s.missionName}</Link> : <span title="Mission deleted since">{s.missionName}</span>}
                      </td>
                      <td>{s.droneName}</td>
                      <td>{s.pilotName ?? '—'}</td>
                      <td>
                        <Badge tone={s.status === 'completed' ? 'ok' : s.status === 'cancelled' ? undefined : 'accent'}>{s.status}</Badge>{' '}
                        {s.flightId && <Link to={`/flights/${s.flightId}`}>flight</Link>}
                      </td>
                      <td>
                        {edit && ['scheduled', 'uploaded'].includes(s.status) && (
                          <AsyncButton
                            className="btn small"
                            onClick={async () => {
                              try {
                                await api(`/api/v2/organisations/${orgId}/schedules/${s.id}`, { method: 'PATCH', body: { status: 'cancelled' } });
                                await schedules.reload();
                              } catch (err) {
                                notice(`Scheduled flight of "${s.missionName}" with ${s.droneName} not cancelled: ${errorMessage(err)}`, 'error');
                              }
                            }}
                          >
                            Cancel
                          </AsyncButton>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
      {/* Each dialog is its own: it opens empty, and an answer to the other one (or to an earlier
          opening) never shows in it. */}
      {dialog === 'create' && <NewMissionModal key="create" orgId={orgId} pageShown={stillShown} onCreated={missions.reload} onClose={() => setDialog(null)} />}
      {dialog === 'import' && <ImportMissionModal key="import" orgId={orgId} pageShown={stillShown} onCreated={missions.reload} onClose={() => setDialog(null)} />}
    </div>
  );
}
