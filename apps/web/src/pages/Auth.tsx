import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import type { MeDto } from '@athena-sky/shared';
import { api, errorMessage } from '../api/client';
import { useAuth } from '../state/auth';
import { Logo } from '../components/Layout';
import { ErrorBox } from '../components/ui';

function AuthShell({ title, children, footer }: { title: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="auth-page">
      <div className="card auth-card">
        <div className="brand">
          <Logo /> Athena-sky
        </div>
        <h2 style={{ textAlign: 'center' }}>{title}</h2>
        {children}
        {footer && <div className="small muted" style={{ marginTop: 16, textAlign: 'center' }}>{footer}</div>}
      </div>
    </div>
  );
}

export function LoginPage() {
  const { me, login } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (me) return <Navigate to={params.get('next') || '/'} replace />;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      navigate(params.get('next') || '/');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell
      title="Log in"
      footer={
        <>
          New to Athena-sky? <Link to="/signup">Create an account</Link>
        </>
      }
    >
      <form className="form" onSubmit={submit}>
        <ErrorBox error={error} />
        <label className="field">
          E-mail
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          Password
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button className="btn primary" disabled={busy} type="submit">
          {busy ? 'Logging in…' : 'Log in'}
        </button>
        <Link to="/forgot-password" className="small" style={{ textAlign: 'center' }}>
          Forgot your password?
        </Link>
      </form>
    </AuthShell>
  );
}

export function SignupPage() {
  const { me, setMe, refresh } = useAuth();
  const [params] = useSearchParams();
  const invite = params.get('invite');
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '', organisationName: '' });
  const [inviteInfo, setInviteInfo] = useState<{ organisationName: string; email: string; role: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!invite) return;
    api<{ organisationName: string; email: string; role: string }>(`/api/v2/invitations/${encodeURIComponent(invite)}`)
      .then((i) => {
        setInviteInfo(i);
        setForm((f) => ({ ...f, email: i.email }));
      })
      .catch((err) => setError(errorMessage(err)));
  }, [invite]);

  if (me && invite && inviteInfo) {
    return (
      <AuthShell title="Join organisation">
        <p>
          Accept the invitation to <b>{inviteInfo.organisationName}</b> as <b>{inviteInfo.role}</b> with your current account ({me.user.email})?
        </p>
        <ErrorBox error={error} />
        <button
          className="btn primary"
          onClick={async () => {
            try {
              await api('/api/v2/invitations/accept', { body: { token: invite } });
              await refresh();
              navigate('/');
            } catch (err) {
              setError(errorMessage(err));
            }
          }}
        >
          Accept invitation
        </button>
      </AuthShell>
    );
  }
  if (me) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<MeDto>('/api/v2/auth/signup', {
        body: { ...form, organisationName: form.organisationName || undefined, inviteToken: invite || undefined },
      });
      setMe(res);
      navigate('/');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  return (
    <AuthShell
      title={inviteInfo ? `Join ${inviteInfo.organisationName}` : 'Create your account'}
      footer={
        <>
          Already registered? <Link to="/login">Log in</Link>
        </>
      }
    >
      <form className="form" onSubmit={submit}>
        {inviteInfo && <div className="notice small">You were invited as {inviteInfo.role}.</div>}
        <ErrorBox error={error} />
        <label className="field">
          Full name
          <input required value={form.name} onChange={set('name')} autoComplete="name" />
        </label>
        <label className="field">
          E-mail
          <input type="email" required value={form.email} onChange={set('email')} readOnly={!!inviteInfo} autoComplete="email" />
        </label>
        <label className="field">
          Password (min. 8 characters)
          <input type="password" required minLength={8} value={form.password} onChange={set('password')} autoComplete="new-password" />
        </label>
        {!invite && (
          <label className="field">
            Organisation name (optional)
            <input value={form.organisationName} onChange={set('organisationName')} placeholder="e.g. Skyline Inspections" />
          </label>
        )}
        <button className="btn primary" disabled={busy} type="submit">
          {busy ? 'Creating…' : 'Create account'}
        </button>
      </form>
    </AuthShell>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <AuthShell title="Reset your password" footer={<Link to="/login">Back to log in</Link>}>
      {sent ? (
        <div className="notice">If an account exists for {email}, we have sent a link to choose a new password.</div>
      ) : (
        <form
          className="form"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api('/api/v2/auth/password/reset', { body: { email } });
              setSent(true);
            } catch (err) {
              setError(errorMessage(err));
            }
          }}
        >
          <ErrorBox error={error} />
          <label className="field">
            E-mail
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <button className="btn primary" type="submit">
            Send reset link
          </button>
        </form>
      )}
    </AuthShell>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <AuthShell title="Choose a new password" footer={<Link to="/login">Back to log in</Link>}>
      {done ? (
        <div className="notice">
          Your password was changed. <Link to="/login">Log in</Link>
        </div>
      ) : (
        <form
          className="form"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api('/api/v2/auth/password/reset/confirm', { body: { token: params.get('token') ?? '', password } });
              setDone(true);
            } catch (err) {
              setError(errorMessage(err));
            }
          }}
        >
          <ErrorBox error={error} />
          <label className="field">
            New password
            <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </label>
          <button className="btn primary" type="submit">
            Set password
          </button>
        </form>
      )}
    </AuthShell>
  );
}
