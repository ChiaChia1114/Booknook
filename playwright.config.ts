import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.E2E_PORT ?? 4173);
const dataDir = process.env.E2E_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'athena-e2e-'));

/**
 * End-to-end tests run against the production build (npm run build) in demo mode:
 * the server seeds demo data and connects three in-process virtual drones.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: 'off',
  },
  webServer: {
    command: 'node --disable-warning=ExperimentalWarning apps/server/dist/main.js --demo',
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      ATHENA_DATA_DIR: dataDir,
      ATHENA_PUBLIC_URL: `http://127.0.0.1:${PORT}`,
      ATHENA_TERRAIN_URL: 'off',
      ATHENA_WEATHER_URL: 'off',
      ATHENA_GEOCODER_URL: 'off',
      ATHENA_AUTH_RATE_LIMIT: '1000',
      LOG_LEVEL: 'warn',
    },
  },
});
