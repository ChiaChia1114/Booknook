import { useEffect, useRef, useState, type FormEvent } from 'react';
import { cleanName } from '@athena-sky/shared';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import type { MeDto } from '@athena-sky/shared';
import { api, errorMessage } from '../api/client';
import { useAuth } from '../state/auth';
import { Mountain, Radar, Radio, Sparkles, type LucideIcon } from 'lucide-react';
import { Logo } from '../components/Layout';
import { AsyncButton, ErrorBox, NAME_PATTERN, useAction } from '../components/ui';
import { safeNext } from '../lib/navigation';

const FEATURES: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: Radio, title: 'Real-time flights', text: 'Live telemetry, video and control over LTE for the whole fleet.' },
  { icon: Mountain, title: '3D mission planning', text: 'Terrain-aware routes, AI optimisation and pre-flight simulation.' },
  { icon: Radar, title: 'Integrated UTM', text: 'Airspace, manned traffic and conformance alerts as you fly.' },
  { icon: Sparkles, title: 'AI analytics', text: 'Post-flight health, route deviation and predictive maintenance.' },
];

function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="auth-page">
      <aside className="auth-hero" aria-hidden="true">
        <div className="brand">
          <Logo /> <span className="brand-name">Athena-sky</span>
        </div>
        <div className="auth-visual">
          <svg viewBox="0 0 520 260" role="presentation">
            <defs>
              <linearGradient id="auth-route" x1="0" x2="1">
                <stop offset="0" stopColor="#60a5fa" />
                <stop offset="1" stopColor="#a78bfa" />
              </linearGradient>
              <pattern id="auth-grid" width="26" height="26" patternUnits="userSpaceOnUse">
                <path d="M26 0H0V26" fill="none" stroke="rgba(148,163,184,0.10)" />
              </pattern>
            </defs>
            <rect width="520" height="260" rx="16" fill="url(#auth-grid)" />
            <path d="M0 210 C70 170 110 190 160 160 S260 120 300 140 S400 110 520 80 L520 260 L0 260 Z" fill="rgba(59,130,246,0.08)" />
            <path d="M0 230 C90 200 150 220 220 190 S350 170 420 150 S490 140 520 130 L520 260 L0 260 Z" fill="rgba(59,130,246,0.10)" />
            <polyline points="60,196 140,120 230,150 300,84 390,112 460,60" fill="none" stroke="url(#auth-route)" strokeWidth="3" strokeLinejoin="round" strokeDasharray="1 0" />
            {[
              [60, 196],
              [140, 120],
              [230, 150],
              [300, 84],
              [390, 112],
              [460, 60],
            ].map(([x, y], i) => (
              <g key={i}>
                <line x1={x} y1={y} x2={x} y2={238} stroke="rgba(96,165,250,0.35)" strokeDasharray="3 4" />
                <circle cx={x} cy={y} r="9" fill="#0b0d11" stroke="#60a5fa" strokeWidth="2" />
                <text x={x} y={y! + 3.5} textAnchor="middle" fontSize="9" fontWeight="700" fill="#e5e7eb">
                  {i + 1}
                </text>
              </g>
            ))}
            <g transform="translate(300 84) rotate(-28)">
              <circle r="26" fill="rgba(96,165,250,0.12)" />
            </g>
          </svg>
        </div>
        <div>
          <h1>One cloud for your entire drone operation.</h1>
          <p>Plan, fly, monitor and analyse – from a single drone to a synchronised swarm, with airspace awareness built in.</p>
          <div className="features">
            {FEATURES.map((f) => (
              <div key={f.title} className="feature">
                <f.icon />
                <div>
                  <b>{f.title}</b>
                  {f.text}
                </div>
              </div>
            ))}
          </div>
        </div>
      </aside>
      <main className="auth-side">
        <div className="auth-card">
          <div className="brand auth-mobile-brand">
            <Logo /> <span className="brand-name">Athena-sky</span>
          </div>
          <h2>{title}</h2>
          {subtitle && <p className="muted" style={{ marginBottom: 20 }}>{subtitle}</p>}
          {children}
          {footer && <div className="small muted" style={{ marginTop: 20, textAlign: 'center' }}>{footer}</div>}
        </div>
      </main>
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
  const next = safeNext(params.get('next'));
  if (me) return <Navigate to={next} replace />;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      navigate(next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell
      title="Welcome back"
      subtitle="Log in to your Athena-sky workspace."
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
  /** The address a confirmation link was sent to (sign-up with e-mail confirmation). */
  const [sentTo, setSentTo] = useState<string | null>(null);

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
        <AsyncButton
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
        </AsyncButton>
      </AuthShell>
    );
  }
  if (me) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<MeDto | { confirmationRequired: true; email: string }>('/api/v2/auth/signup', {
        body: { ...form, organisationName: cleanName(form.organisationName) || undefined, inviteToken: invite || undefined },
      });
      if ('confirmationRequired' in res) {
        setSentTo(res.email);
        return;
      }
      setMe(res);
      navigate('/');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  if (sentTo) {
    return (
      <AuthShell title="Check your inbox" footer={<Link to="/login">Back to log in</Link>}>
        <div className="notice" data-testid="signup-sent">
          <span>
            We sent an e-mail to <b>{sentTo}</b>. Open the link in it to confirm your address and finish creating your account – it is valid for 24 hours.
          </span>
        </div>
        <p className="small muted">No e-mail? Check your spam folder, or sign up again in a few minutes.</p>
      </AuthShell>
    );
  }
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
          <input required pattern={NAME_PATTERN} title="Enter your name" value={form.name} onChange={set('name')} autoComplete="name" />
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

/**
 * Link from the sign-up confirmation e-mail: with the password chosen at sign-up, creates the
 * account and logs in (the link alone would let whoever signed up with someone else's address
 * have the account created when its owner clicks).
 */
export function ConfirmSignupPage() {
  const { setMe, loading } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // After the app's own session probe (its answer would otherwise replace the new session).
    if (loading) return;
    setBusy(true);
    setError(null);
    try {
      const me = await api<MeDto>('/api/v2/auth/signup/confirm', { body: { token: params.get('token') ?? '', password } });
      setMe(me);
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell
      title="Confirm your account"
      footer={
        <>
          <Link to="/login">Log in</Link> · <Link to="/signup">Sign up</Link>
        </>
      }
    >
      <form className="form" onSubmit={submit}>
        <p className="small muted" style={{ margin: 0 }}>
          Enter the password you chose when signing up to create your account.
        </p>
        <ErrorBox error={error} />
        <label className="field">
          Password
          <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </label>
        <button className="btn primary" disabled={busy || loading || !password} type="submit">
          {busy ? 'Creating…' : 'Create my account'}
        </button>
      </form>
    </AuthShell>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One request per submit: the button waits for the server.
  const { busy, run } = useAction();
  return (
    <AuthShell title="Reset your password" footer={<Link to="/login">Back to log in</Link>}>
      {sent ? (
        <div className="notice">If an account exists for {email}, we have sent a link to choose a new password.</div>
      ) : (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              try {
                await api('/api/v2/auth/password/reset', { body: { email } });
                setSent(true);
              } catch (err) {
                setError(errorMessage(err));
              }
            });
          }}
        >
          <ErrorBox error={error} />
          <label className="field">
            E-mail
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <button className="btn primary" type="submit" disabled={busy} aria-busy={busy || undefined}>
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
  const { busy, run } = useAction();
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
          onSubmit={(e) => {
            e.preventDefault();
            // One request per submit: the link's token can be used once.
            void run(async () => {
              try {
                await api('/api/v2/auth/password/reset/confirm', { body: { token: params.get('token') ?? '', password } });
                setDone(true);
              } catch (err) {
                setError(errorMessage(err));
              }
            });
          }}
        >
          <ErrorBox error={error} />
          <label className="field">
            New password
            <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </label>
          <button className="btn primary" type="submit" disabled={busy} aria-busy={busy || undefined}>
            Set password
          </button>
        </form>
      )}
    </AuthShell>
  );
}
