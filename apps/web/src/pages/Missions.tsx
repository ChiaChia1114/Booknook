import { FileUp, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { MissionDto, ScheduleDto } from '@athena-sky/shared';
import { emptyPlan, cleanName, hasVisibleText } from '@athena-sky/shared';
import { api, errorMessage } from '../api/client';
import { useApi } from '../hooks';
import { useAuth, useOrgId } from '../state/auth';
import { AsyncButton, Badge, Card, Empty, ErrorBox, Loading, Modal, PageHead, fmtDate, fmtDistance, fmtDuration, loadError, useToast } from '../components/ui';

export function MissionsPage() {
  const orgId = useOrgId();
  const { can } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const missions = useApi<MissionDto[]>(`/api/v2/organisations/${orgId}/missions`);
  const schedules = useApi<ScheduleDto[]>(`/api/v2/organisations/${orgId}/schedules`);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const edit = can('mission.edit');
  return (
    <div className="content">
      <PageHead
        title="3D Mission Planning"
        subtitle="Plan autonomous missions in 3D with terrain, airspace and ground hazards; schedule them for your fleet."
        actions={
          edit && (
            <>
              <button className="btn" onClick={() => setImporting(true)}>
                <FileUp /> Import .plan / .waypoints
              </button>
              <button className="btn primary" onClick={() => setCreating(true)}>
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
                                  toast(errorMessage(err), 'error');
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
                                  toast(errorMessage(err), 'error');
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
          {!schedules.data ? null : schedules.data.length === 0 ? (
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
                                toast(errorMessage(err), 'error');
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
      {creating && (
        <Modal
          title="New mission"
          onClose={() => setCreating(false)}
          actions={
            <AsyncButton
              className="btn primary"
              disabled={!hasVisibleText(name)}
              onClick={async () => {
                try {
                  const m = await api<MissionDto>(`/api/v2/organisations/${orgId}/missions`, { body: { name, plan: emptyPlan() } });
                  navigate(`/missions/${m.id}`);
                } catch (err) {
                  setError(errorMessage(err));
                }
              }}
            >
              Create & open planner
            </AsyncButton>
          }
        >
          <ErrorBox error={error} />
          <label className="field">
            Mission name
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Bridge inspection – north span" />
          </label>
        </Modal>
      )}
      {importing && (
        <Modal
          title="Import mission"
          onClose={() => setImporting(false)}
          actions={
            <AsyncButton
              className="btn primary"
              disabled={!file}
              onClick={async () => {
                try {
                  const content = await file!.text();
                  const format = /\.plan$/i.test(file!.name) || content.trimStart().startsWith('{') ? 'plan' : 'waypoints';
                  const m = await api<MissionDto>(`/api/v2/organisations/${orgId}/missions/import`, {
                    body: { name: cleanName(name) || file!.name.replace(/\.[^.]+$/, ''), format, content },
                  });
                  navigate(`/missions/${m.id}`);
                } catch (err) {
                  setError(errorMessage(err));
                }
              }}
            >
              Import
            </AsyncButton>
          }
        >
          <div className="form">
            <p className="small muted">QGroundControl plan files (.plan) and Mission Planner / ArduPilot waypoint files (QGC WPL 110) are supported.</p>
            <ErrorBox error={error} />
            <input type="file" accept=".plan,.waypoints,.txt,.json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <label className="field">
              Name (optional)
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
}
