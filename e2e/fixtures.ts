import { test as base, expect, type Page } from '@playwright/test';

export const DEMO = { email: 'demo@athena-sky.local', password: 'athena-demo' };

/** Errors that are expected in an offline sandbox (external map tiles cannot be fetched). */
const IGNORED = [/ERR_TUNNEL_CONNECTION_FAILED/, /ERR_NAME_NOT_RESOLVED/, /ERR_INTERNET_DISCONNECTED/, /tile\.openstreetmap\.org/, /arcgisonline/, /ERR_CONNECTION_REFUSED/, /net::ERR_FAILED/];

export const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !IGNORED.some((r) => r.test(m.text()) || r.test(m.location().url ?? ''))) errors.push(`console: ${m.text()}`);
    });
    page.on('dialog', (d) => void d.accept());
    await use(errors);
    expect(errors, 'unexpected browser errors').toEqual([]);
  },
});

export { expect };

export async function login(page: Page, email = DEMO.email, password = DEMO.password): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}
