import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type {
  ApiTokenCreatedDto,
  ApiTokenDto,
  AuditEntryDto,
  FleetDto,
  InvitationDto,
  LogbookIntegrationDto,
  LogbookProviderDto,
  MemberDto,
  OrganisationDto,
  Paged,
  Role,
  WebhookCreatedDto,
  WebhookDeliveryDto,
  WebhookDto,
  WebhookEvent,
} from '@athena-sky/shared';
import { ROLES, ROLE_LABELS, WEBHOOK_EVENTS } from '@athena-sky/shared';
import { api, errorMessage } from '../api/client';
import { useApi } from '../hooks';
import { useAuth, useOrgId } from '../state/auth';
import { Badge, Card, Empty, ErrorBox, Modal, PageHead, fmtDate, timeAgo, useToast } from '../components/ui';

type Tab = 'organisation' | 'members' | 'fleets' | 'tokens' | 'webhooks' | 'integrations' | 'audit' | 'profile';

function OrganisationTab() {
  const { org, refreshOrg, refresh, can } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState({ name: '', maxAltitudeM: 120, lowBatteryPct: 25 });
  const [newOrg, setNewOrg] = useState('');
  useEffect(() => {
    if (org) setForm({ name: org.name, maxAltitudeM: org.settings.maxAltitudeM, lowBatteryPct: org.settings.lowBatteryPct });
  }, [org]);
  if (!org) return null;
  return (
    <div className="grid two">
      <Card title="Organisation">
        <div className="form">
          <label className="field">
            Name
            <input value={form.name} disabled={!can('org.manage')} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <div className="form-grid">
            <label className="field">
              Legal altitude limit (m AGL)
              <input type="number" value={form.maxAltitudeM} disabled={!can('org.manage')} onChange={(e) => setForm({ ...form, maxAltitudeM: Number(e.target.value) })} />
            </label>
            <label className="field">
              Low battery threshold (%)
              <input type="number" value={form.lowBatteryPct} disabled={!can('org.manage')} onChange={(e) => setForm({ ...form, lowBatteryPct: Number(e.target.value) })} />
            </label>
          </div>
          <p className="small muted">The altitude limit is used by mission validation and post-flight compliance checks.</p>
          {can('org.manage') && (
            <button
              className="btn primary"
              onClick={async () => {
                try {
                  await api<OrganisationDto>(`/api/v2/organisations/${org.id}`, { method: 'PATCH', body: { name: form.name, settings: { maxAltitudeM: form.maxAltitudeM, lowBatteryPct: form.lowBatteryPct } } });
                  await refreshOrg();
                  await refresh();
                  toast('Saved', 'ok');
                } catch (err) {
                  toast(errorMessage(err), 'error');
                }
              }}
            >
              Save
            </button>
          )}
        </div>
      </Card>
      <div className="col" style={{ gap: 16 }}>
        <Card title="Create another organisation">
          <div className="row">
            <input value={newOrg} onChange={(e) => setNewOrg(e.target.value)} placeholder="Organisation name" aria-label="New organisation name" />
            <button
              className="btn"
              disabled={!newOrg}
              onClick={async () => {
                await api('/api/v2/organisations', { body: { name: newOrg } });
                setNewOrg('');
                await refresh();
                toast('Organisation created – switch to it in the top bar', 'ok');
              }}
            >
              <Plus /> Create
            </button>
          </div>
        </Card>
        {can('org.delete') && (
          <Card title="Danger zone" className="danger-zone">
            <p className="small muted" style={{ marginTop: 0 }}>
              Deleting the organisation removes its drones, flights, logs, missions and members permanently.
            </p>
            <button
              className="btn danger"
              onClick={async () => {
                if (prompt(`Type the organisation name to delete it permanently: ${org.name}`) !== org.name) return;
                await api(`/api/v2/organisations/${org.id}`, { method: 'DELETE' });
                await refresh();
              }}
            >
              <Trash2 /> Delete organisation
            </button>
          </Card>
        )}
      </div>
    </div>
  );
}

function MembersTab() {
  const orgId = useOrgId();
  const { can, me } = useAuth();
  const toast = useToast();
  const members = useApi<MemberDto[]>(`/api/v2/organisations/${orgId}/members`);
  const invites = useApi<InvitationDto[]>(can('members.manage') ? `/api/v2/organisations/${orgId}/invitations` : null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('pilot');
  const [link, setLink] = useState<string | null>(null);
  const manage = can('members.manage');
  return (
    <div className="stack">
      {manage && (
        <Card title="Invite a team member">
          <div className="row">
            <input type="email" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="E-mail" />
            <select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role">
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
            <button
              className="btn primary"
              disabled={!email}
              onClick={async () => {
                try {
                  const r = await api<{ member: MemberDto | null; invitation: InvitationDto | null }>(`/api/v2/organisations/${orgId}/members`, { body: { email, role } });
                  if (r.invitation?.acceptUrl) setLink(r.invitation.acceptUrl);
                  else toast('Member added', 'ok');
                  setEmail('');
                  members.reload();
                  invites.reload();
                } catch (err) {
                  toast(errorMessage(err), 'error');
                }
              }}
            >
              Invite
            </button>
          </div>
          {link && (
            <div className="notice small" style={{ marginTop: 10 }}>
              Invitation e-mailed. You can also share this link: <code style={{ wordBreak: 'break-all' }}>{link}</code>
            </div>
          )}
          <p className="small muted" style={{ marginTop: 8 }}>
            Roles: <b>Owner/Administrator</b> manage everything · <b>Mission manager</b> plans, approves airspace requests and observes · <b>Pilot</b> flies drones and uploads logs · <b>Observer</b> watches live flights and
            analytics.
          </p>
        </Card>
      )}
      <Card title="Members">
        <ErrorBox error={members.error} />
        <div className="table-wrap">
          <table className="table" data-testid="members-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Pilot licence</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(members.data ?? []).map((m) => (
                <tr key={m.userId}>
                  <td>
                    {m.name}
                    <div className="small muted">{m.email}</div>
                  </td>
                  <td>
                    {manage && m.userId !== me?.user.id ? (
                      <select
                        value={m.role}
                        onChange={async (e) => {
                          try {
                            await api(`/api/v2/organisations/${orgId}/members/${m.userId}`, { method: 'PATCH', body: { role: e.target.value } });
                            members.reload();
                          } catch (err) {
                            toast(errorMessage(err), 'error');
                          }
                        }}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABELS[r]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      ROLE_LABELS[m.role]
                    )}
                  </td>
                  <td>
                    {manage ? (
                      <input
                        defaultValue={m.pilotLicense ?? ''}
                        placeholder="—"
                        style={{ width: 150 }}
                        onBlur={async (e) => {
                          if (e.target.value === (m.pilotLicense ?? '')) return;
                          await api(`/api/v2/organisations/${orgId}/members/${m.userId}`, { method: 'PATCH', body: { pilotLicense: e.target.value || null } });
                          toast('Licence saved', 'ok');
                        }}
                      />
                    ) : (
                      (m.pilotLicense ?? '—')
                    )}
                  </td>
                  <td>{m.online ? <Badge tone="ok">online</Badge> : <span className="muted small">offline</span>}</td>
                  <td>
                    {(manage || m.userId === me?.user.id) && (
                      <button
                        className="btn small danger"
                        onClick={async () => {
                          if (!confirm(m.userId === me?.user.id ? 'Leave this organisation?' : `Remove ${m.name}?`)) return;
                          try {
                            await api(`/api/v2/organisations/${orgId}/members/${m.userId}`, { method: 'DELETE' });
                            members.reload();
                          } catch (err) {
                            toast(errorMessage(err), 'error');
                          }
                        }}
                      >
                        {m.userId === me?.user.id ? 'Leave' : 'Remove'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {manage && (invites.data ?? []).length > 0 && (
        <Card title="Pending invitations">
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {invites.data!.map((i) => (
                  <tr key={i.id}>
                    <td>{i.email}</td>
                    <td>{ROLE_LABELS[i.role]}</td>
                    <td className="small muted">expires {fmtDate(i.expiresAt)}</td>
                    <td>
                      <button className="btn small" onClick={async () => { await api(`/api/v2/organisations/${orgId}/invitations/${i.id}`, { method: 'DELETE' }); invites.reload(); }}>
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function FleetsTab() {
  const orgId = useOrgId();
  const { can } = useAuth();
  const fleets = useApi<FleetDto[]>(`/api/v2/organisations/${orgId}/fleets`);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  return (
    <Card title="Fleets">
      {can('fleet.manage') && (
        <div className="row" style={{ marginBottom: 12 }}>
          <input placeholder="Fleet name" value={name} onChange={(e) => setName(e.target.value)} />
          <input placeholder="Description" value={desc} onChange={(e) => setDesc(e.target.value)} />
          <button
            className="btn primary"
            disabled={!name}
            onClick={async () => {
              await api(`/api/v2/organisations/${orgId}/fleets`, { body: { name, description: desc } });
              setName('');
              setDesc('');
              fleets.reload();
            }}
          >
            Add fleet
          </button>
        </div>
      )}
      {(fleets.data ?? []).length === 0 ? (
        <Empty>No fleets yet.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <tbody>
              {fleets.data!.map((f) => (
                <tr key={f.id}>
                  <td>
                    <b>{f.name}</b>
                    <div className="small muted">{f.description}</div>
                  </td>
                  <td className="num">{f.droneCount} drones</td>
                  <td>
                    {can('fleet.manage') && (
                      <button className="btn small danger" onClick={async () => { if (confirm(`Delete fleet ${f.name}? Drones are kept.`)) { await api(`/api/v2/organisations/${orgId}/fleets/${f.id}`, { method: 'DELETE' }); fleets.reload(); } }}>
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function TokensTab() {
  const orgId = useOrgId();
  const tokens = useApi<ApiTokenDto[]>('/api/v2/tokens');
  const [name, setName] = useState('');
  const [scoped, setScoped] = useState(true);
  const [created, setCreated] = useState<string | null>(null);
  return (
    <div className="stack">
      <Card title="Personal API tokens">
        <p className="small muted">
          Use tokens to call the <a href="/api/v2/docs/" target="_blank" rel="noreferrer">Athena-sky API</a> from your own systems: <code>Authorization: Bearer ast_…</code>. Real-time telemetry is available on{' '}
          <code>wss://…/api/v2/live?org={orgId}</code> with the same header.
        </p>
        <div className="row">
          <input placeholder="Token name, e.g. ERP integration" value={name} onChange={(e) => setName(e.target.value)} />
          <label className="row small">
            <input type="checkbox" checked={scoped} onChange={(e) => setScoped(e.target.checked)} /> Limit to this organisation
          </label>
          <button
            className="btn primary"
            disabled={!name}
            onClick={async () => {
              const t = await api<ApiTokenCreatedDto>('/api/v2/tokens', { body: { name, orgId: scoped ? orgId : null } });
              setCreated(t.token);
              setName('');
              tokens.reload();
            }}
          >
            Create token
          </button>
        </div>
        {created && (
          <div style={{ marginTop: 10 }}>
            <div className="small">Copy the token now – it will not be shown again:</div>
            <div className="secret" data-testid="api-token">
              {created}
            </div>
          </div>
        )}
      </Card>
      <Card title="Active tokens">
        {(tokens.data ?? []).length === 0 ? (
          <Empty>No tokens.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {tokens.data!.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <b>{t.name}</b>
                      <div className="small muted mono">{t.prefix}…</div>
                    </td>
                    <td className="small">{t.orgId ? 'this organisation' : 'all organisations'}</td>
                    <td className="small muted">last used {timeAgo(t.lastUsedAt)}</td>
                    <td>
                      <button className="btn small danger" onClick={async () => { await api(`/api/v2/tokens/${t.id}`, { method: 'DELETE' }); tokens.reload(); }}>
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function WebhooksTab() {
  const orgId = useOrgId();
  const toast = useToast();
  const hooks = useApi<WebhookDto[]>(`/api/v2/organisations/${orgId}/webhooks`);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<Set<WebhookEvent>>(new Set(['flight.ended', 'alert.raised']));
  const [secret, setSecret] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<{ hook: WebhookDto; items: WebhookDeliveryDto[] } | null>(null);
  return (
    <div className="stack">
      <Card title="New webhook">
        <p className="small muted">
          Stream in-flight telemetry and payload data, flight records, alerts and authorisation updates directly to your cloud. Each delivery is signed with HMAC-SHA256 in <code>X-Athena-Signature</code> (over{' '}
          <code>timestamp.body</code>).
        </p>
        <div className="form">
          <input placeholder="https://example.com/athena/webhook" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Webhook URL" />
          <div className="row wrap">
            {WEBHOOK_EVENTS.map((e) => (
              <label key={e} className="row small">
                <input
                  type="checkbox"
                  checked={events.has(e)}
                  onChange={(ev) => {
                    const s = new Set(events);
                    if (ev.target.checked) s.add(e);
                    else s.delete(e);
                    setEvents(s);
                  }}
                />
                {e}
              </label>
            ))}
          </div>
          <button
            className="btn primary"
            disabled={!url || events.size === 0}
            onClick={async () => {
              try {
                const h = await api<WebhookCreatedDto>(`/api/v2/organisations/${orgId}/webhooks`, { body: { url, events: [...events] } });
                setSecret(h.secret);
                setUrl('');
                hooks.reload();
              } catch (err) {
                toast(errorMessage(err), 'error');
              }
            }}
          >
            Add webhook
          </button>
          {secret && (
            <div>
              <div className="small">Signing secret (shown once):</div>
              <div className="secret">{secret}</div>
            </div>
          )}
        </div>
      </Card>
      <Card title="Webhooks">
        {(hooks.data ?? []).length === 0 ? (
          <Empty>No webhooks.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {hooks.data!.map((h) => (
                  <tr key={h.id}>
                    <td>
                      <span className="mono small">{h.url}</span>
                      <div className="small muted">{h.events.join(', ')}</div>
                    </td>
                    <td>
                      {h.active ? <Badge tone="ok">active</Badge> : <Badge>paused</Badge>}{' '}
                      {h.lastStatus !== null && <Badge tone={h.lastStatus >= 200 && h.lastStatus < 300 ? 'ok' : 'danger'}>last {h.lastStatus || 'error'}</Badge>}
                    </td>
                    <td className="row">
                      <button className="btn small" onClick={async () => { await api(`/api/v2/organisations/${orgId}/webhooks/${h.id}/test`, { method: 'POST' }); toast('Test delivery queued', 'ok'); setTimeout(hooks.reload, 1500); }}>
                        Test
                      </button>
                      <button className="btn small" onClick={async () => setDeliveries({ hook: h, items: await api<WebhookDeliveryDto[]>(`/api/v2/organisations/${orgId}/webhooks/${h.id}/deliveries`) })}>
                        Deliveries
                      </button>
                      <button className="btn small" onClick={async () => { await api(`/api/v2/organisations/${orgId}/webhooks/${h.id}`, { method: 'PATCH', body: { active: !h.active } }); hooks.reload(); }}>
                        {h.active ? 'Pause' : 'Resume'}
                      </button>
                      <button className="btn small danger" onClick={async () => { await api(`/api/v2/organisations/${orgId}/webhooks/${h.id}`, { method: 'DELETE' }); hooks.reload(); }}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {deliveries && (
        <Modal title={`Deliveries – ${deliveries.hook.url}`} wide onClose={() => setDeliveries(null)}>
          {deliveries.items.length === 0 ? (
            <Empty>No deliveries yet.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table small">
                <tbody>
                  {deliveries.items.map((d) => (
                    <tr key={d.id}>
                      <td>{fmtDate(d.createdAt)}</td>
                      <td>{d.event}</td>
                      <td>{d.delivered ? <Badge tone="ok">{d.statusCode}</Badge> : <Badge tone="danger">{d.statusCode ?? 'failed'}</Badge>}</td>
                      <td>{d.attempts} attempt(s)</td>
                      <td className="muted">{d.error}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

function IntegrationsTab() {
  const orgId = useOrgId();
  const toast = useToast();
  const cfg = useApi<LogbookIntegrationDto>(`/api/v2/organisations/${orgId}/integrations/logbook`);
  const providers = useApi<LogbookProviderDto[]>('/api/v2/integrations/logbook/providers');
  const [form, setForm] = useState({ enabled: false, provider: 'json', endpointUrl: '', autoExport: false, apiKey: '' });
  useEffect(() => {
    if (cfg.data) setForm({ enabled: cfg.data.enabled, provider: cfg.data.provider, endpointUrl: cfg.data.endpointUrl, autoExport: cfg.data.autoExport, apiKey: '' });
  }, [cfg.data]);
  return (
    <Card title="Flight logbook export">
      <p className="small muted">
        Export flight logs to your logbook service (e.g. a DroneLogbook-style import endpoint). Choose the format your endpoint accepts; your API key is sent as a Bearer
        token and stored encrypted. Enable auto-export to send every completed flight.
      </p>
      <div className="form">
        <label className="row">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Enabled
        </label>
        <div className="form-grid">
          <label className="field">
            Provider
            <select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} data-testid="logbook-provider">
              {(providers.data ?? [{ id: 'json', label: 'JSON flight record', description: '' }]).map((p) => (
                <option key={p.id} value={p.id} title={p.description}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ gridColumn: 'span 2' }}>
            Endpoint URL
            <input value={form.endpointUrl} onChange={(e) => setForm({ ...form, endpointUrl: e.target.value })} placeholder="https://…" />
          </label>
          <label className="field">
            API key {cfg.data?.hasApiKey && <span>(saved – leave empty to keep)</span>}
            <input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
          </label>
        </div>
        <label className="row">
          <input type="checkbox" checked={form.autoExport} onChange={(e) => setForm({ ...form, autoExport: e.target.checked })} /> Automatically export every completed flight
        </label>
        {cfg.data?.lastExportAt && (
          <div className="small muted">
            Last export {fmtDate(cfg.data.lastExportAt)} – {cfg.data.lastStatus}
          </div>
        )}
        <button
          className="btn primary"
          onClick={async () => {
            try {
              cfg.setData(
                await api<LogbookIntegrationDto>(`/api/v2/organisations/${orgId}/integrations/logbook`, {
                  method: 'PUT',
                  body: { enabled: form.enabled, provider: form.provider, endpointUrl: form.endpointUrl, autoExport: form.autoExport, ...(form.apiKey ? { apiKey: form.apiKey } : {}) },
                }),
              );
              toast('Integration saved', 'ok');
            } catch (err) {
              toast(errorMessage(err), 'error');
            }
          }}
        >
          Save
        </button>
      </div>
    </Card>
  );
}

function AuditTab() {
  const orgId = useOrgId();
  const log = useApi<Paged<AuditEntryDto>>(`/api/v2/organisations/${orgId}/audit?limit=200`);
  return (
    <Card title="Audit trail">
      <ErrorBox error={log.error} />
      <div className="table-wrap">
        <table className="table small">
          <tbody>
            {(log.data?.items ?? []).map((e) => (
              <tr key={e.id}>
                <td className="nowrap">{fmtDate(e.createdAt)}</td>
                <td>{e.userName ?? 'system'}</td>
                <td>
                  <code>{e.action}</code>
                </td>
                <td className="mono muted audit-details">{JSON.stringify(e.details)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ProfileTab() {
  const { me, setMe } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(me?.user.name ?? '');
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  return (
    <div className="grid two">
      <Card title="Profile">
        <div className="form">
          <label className="field">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="small muted">{me?.user.email}</div>
          <button className="btn primary" onClick={async () => { setMe(await api(`/api/v2/auth/me`, { method: 'PATCH', body: { name } })); toast('Saved', 'ok'); }}>
            Save
          </button>
        </div>
      </Card>
      <Card title="Change password">
        <div className="form">
          <input type="password" placeholder="Current password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} />
          <input type="password" placeholder="New password (min. 8)" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} />
          <button
            className="btn primary"
            onClick={async () => {
              try {
                await api('/api/v2/auth/password/change', { body: pw });
                setPw({ currentPassword: '', newPassword: '' });
                toast('Password changed – other sessions were signed out', 'ok');
              } catch (err) {
                toast(errorMessage(err), 'error');
              }
            }}
          >
            Change password
          </button>
        </div>
      </Card>
    </div>
  );
}

export function SettingsPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('organisation');
  const tabs: [Tab, string, boolean][] = [
    ['organisation', 'Organisation', true],
    ['members', 'Members & roles', true],
    ['fleets', 'Fleets', true],
    ['tokens', 'API tokens', true],
    ['webhooks', 'Webhooks', can('integrations.manage')],
    ['integrations', 'Integrations', can('integrations.manage')],
    ['audit', 'Audit trail', can('audit.view')],
    ['profile', 'My profile', true],
  ];
  return (
    <div className="content">
      <PageHead title="Settings & API" subtitle="Organisation, team, integrations and API access." />
      <div className="tabs">
        {tabs
          .filter(([, , show]) => show)
          .map(([t, label]) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {label}
            </button>
          ))}
      </div>
      {tab === 'organisation' && <OrganisationTab />}
      {tab === 'members' && <MembersTab />}
      {tab === 'fleets' && <FleetsTab />}
      {tab === 'tokens' && <TokensTab />}
      {tab === 'webhooks' && <WebhooksTab />}
      {tab === 'integrations' && <IntegrationsTab />}
      {tab === 'audit' && <AuditTab />}
      {tab === 'profile' && <ProfileTab />}
    </div>
  );
}
