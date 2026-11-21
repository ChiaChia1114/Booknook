import { StrictMode, Suspense, lazy, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import '@fontsource-variable/inter';
import './styles.css';
import { AuthProvider, useAuth } from './state/auth';
import { LiveProvider } from './state/live';
import { Layout } from './components/Layout';
import { Loading, ToastProvider } from './components/ui';
import { LoginPage, SignupPage, ForgotPasswordPage, ResetPasswordPage } from './pages/Auth';
import { DashboardPage } from './pages/Dashboard';
import { AnalyticsPage } from './pages/Analytics';
import { LocationsPage } from './pages/Locations';
import { FleetPage } from './pages/Fleet';
import { DroneDetailPage } from './pages/DroneDetail';
import { FlightsPage } from './pages/Flights';
import { FlightDetailPage } from './pages/FlightDetail';
import { MissionsPage } from './pages/Missions';
import { AirspacePage } from './pages/Airspace';
import { LivePage } from './pages/Live';
import { SettingsPage } from './pages/Settings';
import { SafetyMapPage } from './pages/SafetyMap';
import { MaintenancePage } from './pages/Maintenance';
import { ReportsPage } from './pages/Reports';

// Cesium is large: load the 3D planner on demand.
const MissionPlannerPage = lazy(() => import('./pages/MissionPlanner'));

document.documentElement.dataset.theme = localStorage.getItem('athena.theme') ?? 'dark';
// Where Cesium loads its workers and assets from (copied into the build by vite-plugin-static-copy).
(window as unknown as { CESIUM_BASE_URL: string }).CESIUM_BASE_URL = '/cesium';

function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading, orgId } = useAuth();
  const location = useLocation();
  if (loading) return <Loading what="Starting Athena-sky…" />;
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (!orgId) {
    return (
      <div className="auth-page">
        <div className="card auth-card">You are not a member of any organisation yet. Ask an administrator for an invitation.</div>
      </div>
    );
  }
  return <LiveProvider>{children}</LiveProvider>;
}

function NotFound() {
  return (
    <div className="content">
      <div className="not-found">
        <div className="not-found-code">404</div>
        <h1>Page not found</h1>
        <p className="muted">The page you asked for does not exist or was moved.</p>
        <Link className="btn primary" to="/">
          Back to the dashboard
        </Link>
      </div>
    </div>
  );
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/safety-map" element={<SafetyMapPage />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route path="locations" element={<LocationsPage />} />
        <Route path="fleet" element={<FleetPage />} />
        <Route path="fleet/:droneId" element={<DroneDetailPage />} />
        <Route path="flights" element={<FlightsPage />} />
        <Route path="flights/:flightId" element={<FlightDetailPage />} />
        <Route path="maintenance" element={<MaintenancePage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="missions" element={<MissionsPage />} />
        <Route
          path="missions/:missionId"
          element={
            <Suspense fallback={<Loading what="Loading the 3D planner…" />}>
              <MissionPlannerPage />
            </Suspense>
          }
        />
        <Route path="airspace" element={<AirspacePage />} />
        <Route path="live" element={<LivePage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
