import { test, expect, login, TILE_PNG } from './fixtures';
import { destinationPoint, haversineDistance } from '@athena-sky/shared';
import { LinkClient, SimWorld, VirtualDrone, worldAnchor } from '@athena-sky/simulator';

/** Home of the demo fleet (apps/server/src/demo/demo.ts) and the simulated world around it. */
const DEMO_HOME = { lat: 25.0732, lon: 121.5355 };

test.describe('Athena-sky end-to-end', () => {
  test('F1 sign up creates an organisation; log out and back in', async ({ page, consoleErrors }) => {
    void consoleErrors;
    const email = `e2e-${Date.now()}@example.com`;
    await page.goto('/signup');
    await page.getByLabel('Full name').fill('E2E Tester');
    await page.getByLabel('E-mail').fill(email);
    await page.getByLabel('Password (min. 8 characters)').fill('e2e-password-1');
    await page.getByLabel('Organisation name (optional)').fill('E2E Aerial');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByLabel('Organisation')).toContainText('E2E Aerial');
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Log out' }).click();
    await expect(page).toHaveURL(/\/login/);
    await login(page, email, 'e2e-password-1');
  });

  test('F1b signing in stays on the site; a page left open over a server update loads the new version', async ({ page }) => {
    // A crafted next= does not lead off the site (nor break the application).
    await page.goto('/login?next=//evil.example/x');
    await page.getByLabel('E-mail').fill('demo@athena-sky.local');
    await page.getByLabel('Password').fill('athena-demo');
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    expect(page.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    // The server was updated while the page was open: the planner's bundle of the old version is
    // gone (404). The page reloads once to get the new version; when that does not help either,
    // it says so (with the menus still there) instead of going blank.
    await page.route('**/assets/MissionPlanner-*.js', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' }));
    await page.locator('nav').getByRole('link', { name: '3D Mission Planning' }).click();
    const reloaded = page.waitForEvent('load');
    await page.getByTestId('missions-table').getByRole('link', { name: 'Field survey – North parcel' }).click();
    await reloaded;
    await expect(page.getByTestId('page-error')).toContainText('Athena-sky has been updated');
    await expect(page.locator('nav').getByRole('link', { name: 'Fleet Management' })).toBeVisible();
    await page.unroute('**/assets/MissionPlanner-*.js');
    await page.getByTestId('page-error').getByRole('button', { name: 'Reload' }).click();
    await expect(page.getByTestId('planner-3d')).toBeVisible({ timeout: 60_000 });
    // Bundles that are not there are answered with 404, not with the application page.
    const gone = await page.request.get('/assets/MissionPlanner-0ld0ld0l.js');
    expect(gone.status()).toBe(404);
    expect(gone.headers()['content-type']).not.toMatch(/text\/html/);
    const index = await page.request.get('/');
    expect(index.headers()['cache-control']).toBe('no-cache');
  });

  test('F2/F3/F4 dashboard, drones & operators and flight locations', async ({ page, consoleErrors }) => {
    void consoleErrors;
    await login(page);
    await expect(page.getByTestId('kpi-flights')).not.toContainText(/^\s*FLIGHTS\s*0\s*$/);
    const flights = Number((await page.getByTestId('kpi-flights').locator('.value').textContent()) ?? '0');
    expect(flights).toBeGreaterThan(20);
    await expect(page.getByText(/motor imbalance/i).first()).toBeVisible();
    await page.getByLabel('Fleet').selectOption({ label: 'Inspection' });
    await expect(page.getByTestId('kpi-drones').locator('.value')).toHaveText('1');
    await page.getByRole('link', { name: 'Drones & Operators' }).click();
    await expect(page.getByTestId('most-used-drone')).not.toBeEmpty();
    await expect(page.getByTestId('most-experienced-pilot')).toHaveText(/Demo Pilot|Pia Chen/);
    await page.getByRole('link', { name: 'Flight Locations' }).click();
    await expect(page.getByTestId('kpi-compliant')).toBeVisible();
    await expect(page.locator('.leaflet-interactive').first()).toBeVisible();
  });

  // Without the check for browser errors: the failure answered below is logged by the browser.
  test('F2.3 a custom period the page cannot use is not applied; a failed request leaves no results of other filters', async ({ page }) => {
    await login(page);
    const day = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    const asked: string[] = [];
    page.on('request', (r) => {
      if (/\/analytics\/(dashboard|heatmap|trends|drones-operators)/.test(r.url())) asked.push(r.url());
    });
    // Dashboard: two years at most.
    await page.getByLabel('Period').selectOption('custom');
    const from = page.getByLabel('From', { exact: true });
    const to = page.getByLabel('To', { exact: true });
    const end = await to.inputValue();
    const start = await from.inputValue();
    await expect(page.getByTestId('kpi-flights')).toBeVisible();
    await expect(from).toHaveAttribute('min', day(end, -730));
    await expect(from).toHaveAttribute('max', end);
    await page.waitForTimeout(500);
    const before = asked.length;
    await from.fill(day(end, -800));
    await expect(page.getByTestId('period-problem')).toHaveText(`Not applied: a period can be at most 731 days – still showing ${start} → ${end}`);
    await page.waitForTimeout(800);
    expect(asked.length, 'no request for a period the server refuses').toBe(before);
    // A period it accepts is applied at once.
    await from.fill(day(end, -700));
    await expect(page.getByTestId('period-problem')).toHaveCount(0);
    await expect.poll(() => asked.length).toBeGreaterThan(before);
    await expect(page.getByTestId('kpi-flights')).toBeVisible();

    // Flight Logs: From after To is not applied either – the list says which period it shows.
    await page.goto('/flights');
    await page.getByLabel('Period').selectOption('custom');
    await expect(page.getByTestId('flights-table')).toBeVisible();
    const logsEnd = await page.getByLabel('To', { exact: true }).inputValue();
    const logsStart = await page.getByLabel('From', { exact: true }).inputValue();
    await page.getByLabel('From', { exact: true }).fill(day(logsEnd, 5));
    await expect(page.getByTestId('period-problem')).toHaveText(`Not applied: From is after To – still showing ${logsStart} → ${logsEnd}`);
    await expect(page.getByTestId('flights-table')).toBeVisible();
    await page.getByLabel('From', { exact: true }).fill(logsStart);
    await expect(page.getByTestId('period-problem')).toHaveCount(0);
    // A year outside 1970–2100, or a field left empty: not applied either, and said so – the other
    // calendar keeps offering only days of a period the page accepts.
    await page.getByLabel('To', { exact: true }).fill('1969-12-31');
    await expect(page.getByTestId('period-problem')).toHaveText(`Not applied: To must be a date from 1970 to 2100 – still showing ${logsStart} → ${logsEnd}`);
    await expect(page.getByLabel('From', { exact: true })).toHaveAttribute('max', logsEnd);
    await page.getByLabel('To', { exact: true }).fill('');
    await expect(page.getByTestId('period-problem')).toHaveText(`Not applied: enter both dates – still showing ${logsStart} → ${logsEnd}`);
    await expect(page.getByTestId('flights-table')).toBeVisible();
    await page.getByLabel('To', { exact: true }).fill(logsEnd);
    await expect(page.getByTestId('period-problem')).toHaveCount(0);

    // A request that fails after the filters changed: its error, not the previous filters' flights.
    await page.route(/\/flights\?.*status=aborted/, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'unavailable', message: 'Flight list unavailable' }) }));
    await page.getByLabel('Status').selectOption('aborted');
    await expect(page.getByRole('alert').filter({ hasText: 'Flight list unavailable' })).toBeVisible();
    await expect(page.getByTestId('flights-table')).toHaveCount(0);
    await page.unroute(/\/flights\?.*status=aborted/);
    await page.getByLabel('Status').selectOption('');
    await expect(page.getByTestId('flights-table')).toBeVisible();
  });

  test('F4b Flight Locations: "Load more" continues only the flights of the filters shown', async ({ page, consoleErrors }) => {
    void consoleErrors;
    await login(page);
    // Pages of 10 of 20 flights per compliance filter; the first page of "All flights" can be slow.
    const asked: string[] = [];
    let slow = false;
    const pageOf = (compliance: string, offset: number) => {
      const prefix = compliance === 'non_compliant' ? 'n' : 'a';
      return {
        range: { from: new Date(Date.now() - 90 * 86_400_000).toISOString(), to: new Date().toISOString() },
        points: Array.from({ length: 10 }, (_, k) => {
          const i = offset + k;
          return { flightId: `${prefix}${i}`, droneId: 'd1', droneName: `Drone ${prefix}${i}`, pilotName: 'Pia Chen', lat: 25.07 + i * 0.001, lon: 121.53, startedAt: new Date(Date.now() - (i + 1) * 3_600_000).toISOString(), durationS: 600, maxAltM: 50, compliant: prefix === 'a', violations: prefix === 'a' ? [] : ['Above 120 m'], track: [] };
        }),
        total: 20,
        offset,
        summary: { flights: 40, compliant: 20, nonCompliant: 20, unchecked: 0 },
      };
    };
    await page.route(/\/analytics\/locations\?/, async (route) => {
      const u = new URL(route.request().url());
      const compliance = u.searchParams.get('compliance') ?? 'all';
      const offset = Number(u.searchParams.get('offset') ?? 0);
      asked.push(`${compliance}@${offset}`);
      if (slow && compliance === 'all' && offset === 0) await new Promise((r) => setTimeout(r, 3000));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(pageOf(compliance, offset)) });
    });
    await page.goto('/locations');
    const partial = page.getByTestId('locations-partial');
    await expect(partial).toContainText('Showing the 10 most recent of 20 flights');
    await page.getByLabel('Compliance').selectOption('non_compliant');
    await expect(page.getByRole('link', { name: 'Drone n0', exact: true })).toBeVisible();
    await expect(partial.getByRole('button', { name: 'Load 10 more' })).toBeEnabled();
    // Back to all flights, whose first page is slow: the non-compliant flights stay meanwhile, but
    // their "Load more" cannot ask for a page of the other filters.
    slow = true;
    await page.getByLabel('Compliance').selectOption('all');
    await expect(partial.getByRole('button')).toHaveText('Loading…');
    await expect(partial.getByRole('button')).toBeDisabled();
    await partial.getByRole('button').click({ force: true, timeout: 2000 }).catch(() => undefined);
    await expect(page.getByRole('link', { name: 'Drone a0', exact: true })).toBeVisible({ timeout: 10_000 });
    expect(asked.filter((a) => a.endsWith('@10')), 'no further page while the earlier filters were shown').toEqual([]);
    // Once the first page of all flights is in, "Load more" continues it: all 20, none missing.
    await partial.getByRole('button', { name: 'Load 10 more' }).click();
    await expect(page.getByText('Flights (20)', { exact: true })).toBeVisible();
    for (let i = 0; i < 20; i++) await expect(page.getByRole('link', { name: `Drone a${i}`, exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Drone n/ })).toHaveCount(0);
    expect(asked.filter((a) => a.endsWith('@10'))).toEqual(['all@10']);
  });

  test('F5 fleet management: live status, software version, register a drone', async ({ page, consoleErrors }) => {
    void consoleErrors;
    await login(page);
    await page.getByRole('link', { name: 'Fleet Management' }).click();
    const table = page.getByTestId('fleet-table');
    await expect(table.getByText('online').first()).toBeVisible();
    await expect(table).toContainText('athena-fc 2.4.0');
    await expect(table).toContainText('Heron-3');
    await page.getByRole('button', { name: 'Register drone' }).click();
    await page.getByLabel('Name').fill('E2E Hawk');
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await expect(page.getByTestId('link-key')).toHaveText(/^adk_/);
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(table).toContainText('E2E Hawk');
    await page.getByRole('button', { name: 'Software updates' }).click();
    await expect(page.getByText('Upload firmware package')).toBeVisible();
    // Where each drone has been (its latest flights, kept by the server) and where its next mission goes.
    await page.getByRole('button', { name: 'Fleet map' }).click();
    const onMap = page.getByTestId('fleet-map-drones');
    await expect(onMap).toContainText('Heron-3');
    await expect(onMap).toContainText(/\d+ flights? shown/);
    await expect(onMap).toContainText('Next:');
    await expect(page.locator('.leaflet-overlay-pane path').first()).toBeAttached();
    await onMap.getByRole('link', { name: 'Heron-3' }).click();
    await expect(page.getByTestId('next-mission-map')).toBeVisible();
    await expect(page.getByTestId('drone-history-map').locator('.leaflet-overlay-pane path').first()).toBeAttached();
    await expect(page.getByRole('link', { name: /All flights on Flight Locations/ })).toBeVisible();
  });

  test('F5b a mission manager moves a drone to another fleet', async ({ page, consoleErrors }) => {
    void consoleErrors;
    await login(page, 'maya@athena-sky.local');
    const orgId = (await (await page.request.get('/api/v2/auth/me')).json()).memberships[0].orgId;
    const falcon = (await (await page.request.get(`/api/v2/organisations/${orgId}/drones`)).json()).find((d: { name: string }) => d.name === 'Falcon-2');
    await page.goto(`/fleet/${falcon.id}`);
    await expect(page.getByRole('heading', { name: 'Falcon-2' })).toBeVisible();
    // Fleets are hers to organise; the drone's other settings are not.
    await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    const move = async (fleet: string) => {
      await page.getByRole('button', { name: 'Move to fleet' }).click();
      await page.getByTestId('move-fleet').selectOption({ label: fleet });
      await page.getByRole('button', { name: 'Move', exact: true }).click();
      await expect(page.getByText(`Falcon-2 moved to ${fleet}`)).toBeVisible();
      await expect(page.locator('.page-head')).toContainText(fleet);
    };
    await move('Inspection');
    expect((await (await page.request.get(`/api/v2/organisations/${orgId}/drones/${falcon.id}`)).json()).fleetName).toBe('Inspection');
    await move('Survey');
  });

  test('F9 real-time flight: take control, take off, live HD video, land and record the flight', async ({ page, consoleErrors }) => {
    void consoleErrors;
    test.setTimeout(240_000);
    await login(page);
    await page.getByRole('link', { name: 'Real-Time Flights' }).click();
    // Map-first console: the drones' live videos are stacked on the right with status chips.
    const tile = page.getByTestId('tile-Falcon-1');
    await expect(tile).toBeVisible();
    await expect(tile.getByText('Disarmed', { exact: true })).toBeVisible();
    await expect(page.getByTestId('tile-video-Falcon-1').locator('img')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('video-stack').locator('.vtile')).toHaveCount(3);
    // Full controls of the selected drone open in a drawer over the map.
    await tile.getByRole('button', { name: 'Details Falcon-1' }).click();
    await expect(tile).toHaveClass(/selected/);
    const card = page.getByTestId('drone-card-Falcon-1');
    await expect(card).toBeVisible();
    await expect(card.getByText('online')).toBeVisible();
    await card.getByRole('button', { name: 'Live video' }).click();
    await expect(page.getByTestId('video-Falcon-1').locator('img')).toBeVisible({ timeout: 20_000 });
    await card.getByLabel('Take-off altitude').fill('12');
    await card.getByRole('button', { name: 'Take off' }).click();
    await expect(card.getByText('Pilot in command:')).toContainText('Demo Pilot');
    await expect
      .poll(async () => Number(((await page.getByTestId('alt-Falcon-1').textContent()) ?? '0').replace(/[^\d.]/g, '')), { timeout: 30_000 })
      .toBeGreaterThan(8);
    await expect(card.getByRole('link', { name: 'recording' })).toBeVisible();
    await expect(card.getByText(/RTT \d+ ms/)).toBeVisible({ timeout: 15_000 });
    await expect(tile.getByText('Armed', { exact: true })).toBeVisible();
    await expect(page.getByTestId('console-log')).toContainText('Falcon-1');
    // Manual control from the keyboard while the "Manual control" checkbox keeps the focus.
    const altNow = async () => Number(((await page.getByTestId('alt-Falcon-1').textContent()) ?? '0').replace(/[^\d.]/g, ''));
    await expect.poll(altNow, { timeout: 30_000 }).toBeGreaterThan(11);
    const before = await altNow();
    await card.getByLabel('Manual control').check();
    await expect(card.getByLabel('Manual control')).toBeFocused();
    await page.keyboard.down('ArrowUp');
    await expect.poll(altNow, { timeout: 15_000 }).toBeGreaterThan(before + 4);
    await page.keyboard.up('ArrowUp');
    await card.getByLabel('Manual control').uncheck();
    // Reposition: altitude, speed, heading and position in one form.
    await page.getByRole('button', { name: 'Close details' }).click();
    await page.getByRole('button', { name: 'Reposition Falcon-1' }).click();
    const form = page.getByTestId('reposition-form');
    await form.getByLabel('Reposition altitude').fill('30');
    await form.getByLabel('Reposition speed').fill('6');
    await form.getByLabel('Reposition heading').fill('90');
    await form.getByLabel('Reposition latitude').fill(String(Number(await form.getByLabel('Reposition latitude').inputValue()) + 0.0005));
    await form.getByRole('button', { name: 'Reposition' }).click();
    await expect(page.getByTestId('console-log')).toContainText(/Repositioning to .* at 30 m, 6 m\/s, heading 90°/);
    await expect.poll(async () => Number(((await page.getByTestId('tile-foot-Falcon-1').locator('[title="Altitude above home"]').textContent()) ?? '').match(/(\d+) m/)?.[1] ?? 0), { timeout: 30_000 }).toBeGreaterThanOrEqual(28);
    await page.getByRole('button', { name: 'Details Falcon-1' }).click();
    await card.getByRole('button', { name: 'Land', exact: true }).click();
    await expect(page.getByTestId('events-Falcon-1')).toContainText('Flight recorded', { timeout: 60_000 });
    await card.getByRole('button', { name: 'Release control' }).click();
    await page.getByRole('link', { name: 'Flight Logs', exact: true }).click();
    const first = page.getByTestId('flights-table').locator('tbody tr').first();
    await expect(first).toContainText('Falcon-1');
    await expect(first).toContainText('LTE live');
    await first.getByRole('link').click();
    await expect(page.getByTestId('analysis')).toBeVisible();
  });

  test('F9b live console in 3D: drone models with tags, selection highlight and camera frustum', async ({ page, consoleErrors }) => {
    void consoleErrors;
    await login(page);
    await page.getByRole('link', { name: 'Real-Time Flights' }).click();
    await page.getByRole('group', { name: 'Live view' }).getByRole('button', { name: '3D view' }).click();
    await expect(page.getByTestId('video-stack').locator('.vtile')).toHaveCount(3);
    type Win = { __athenaLive3D?: { viewer: any; tracks: Map<string, unknown> } };
    await page.waitForFunction(() => ((window as unknown as Win).__athenaLive3D?.tracks.size ?? 0) >= 3, null, { timeout: 60_000 });
    const scene = () =>
      page.evaluate(() => {
        const v = (window as unknown as Win).__athenaLive3D!.viewer;
        const t = v.clock.currentTime;
        const drones = v.entities.values.filter((e: any) => String(e.id).startsWith('drone:'));
        return {
          labels: drones.map((e: any) => String(e.label.text.getValue(t))),
          models: drones.map((e: any) => String(e.model.uri.getValue(t).url ?? e.model.uri.getValue(t))),
          highlighted: drones.filter((e: any) => e.model.silhouetteSize.getValue(t) > 0).map((e: any) => e.name),
          frustums: v.entities.values.filter((e: any) => String(e.id).startsWith('frustum')).length,
        };
      });
    await expect.poll(async () => (await scene()).labels.filter((l) => / · -?\d+ m$/.test(l)).length, { timeout: 30_000 }).toBe(3);
    const s0 = await scene();
    expect(s0.models.every((m) => /\/models\/[a-z0-9-]+\.glb$/.test(m))).toBe(true);
    // The drones stand 40 m apart: their tags are placed so that none covers another.
    const tagOverlaps = () =>
      page.evaluate(() => {
        const v = (window as unknown as Win).__athenaLive3D!.viewer;
        const t = v.clock.currentTime;
        const ctx = document.createElement('canvas').getContext('2d')!;
        ctx.font = '600 12px sans-serif';
        const rects = v.entities.values
          .filter((e: any) => String(e.id).startsWith('drone:'))
          .map((e: any) => {
            const c = v.scene.cartesianToCanvasCoordinates(e.position.getValue(t));
            const off = e.label.pixelOffset.getValue(t);
            const w = ctx.measureText(String(e.label.text.getValue(t))).width + 12;
            return { l: c.x + off.x - w / 2, r: c.x + off.x + w / 2, t: c.y + off.y - 10, b: c.y + off.y + 10 };
          });
        let n = 0;
        for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) if (rects[i].l < rects[j].r && rects[j].l < rects[i].r && rects[i].t < rects[j].b && rects[j].t < rects[i].b) n++;
        return n;
      });
    await expect.poll(tagOverlaps, { timeout: 10_000 }).toBe(0);
    // Selecting a drone in the video stack highlights it in the scene and shows its camera frustum.
    await page.getByTestId('tile-Heron-3').click();
    await expect(page.getByTestId('tile-Heron-3')).toHaveClass(/selected/);
    await expect.poll(async () => (await scene()).highlighted).toEqual(['Heron-3']);
    await expect.poll(async () => (await scene()).frustums).toBeGreaterThan(0);
    await page.getByRole('group', { name: 'Live view' }).getByRole('button', { name: '2D map' }).click();
    await expect.poll(() => page.evaluate(() => !!(window as unknown as Win).__athenaLive3D)).toBe(false);
  });

  test('F9c members who only watch (observer, mission manager) get full-size live video in the console', async ({ page, consoleErrors }) => {
    void consoleErrors;
    for (const email of ['owen@athena-sky.local', 'maya@athena-sky.local']) {
      for (const width of [1440, 1024, 820, 390]) {
        await page.context().clearCookies();
        await page.setViewportSize({ width, height: width > 400 ? 900 : 844 });
        await login(page, email);
        await page.goto('/live');
        await expect(page.getByTestId('video-stack').locator('.vtile')).toHaveCount(3);
        // The top bar fits (long names and roles included) and so does the account menu.
        expect(await page.evaluate(() => document.documentElement.scrollWidth), `${email} at ${width} px`).toBeLessThanOrEqual(width);
        // A long organisation name ends in an ellipsis; a two-digit unread count leaves the bell visible.
        expect(await page.locator('.topbar select').evaluate((el) => getComputedStyle(el).textOverflow)).toBe('ellipsis');
        const bell = await page.getByTestId('notification-bell').evaluate((btn) => {
          let c = btn.querySelector('.bell-count');
          if (!c) {
            c = document.createElement('span');
            c.className = 'bell-count';
            btn.appendChild(c);
          }
          c.textContent = '12';
          const icon = btn.querySelector('svg')!.getBoundingClientRect();
          return { iconCenter: icon.left + icon.width / 2, badgeLeft: c.getBoundingClientRect().left };
        });
        expect(bell.badgeLeft, `${email} at ${width} px`).toBeGreaterThanOrEqual(bell.iconCenter);
        await page.getByRole('button', { name: 'Account menu' }).click();
        const menu = (await page.getByRole('menu').boundingBox())!;
        expect(menu.x).toBeGreaterThanOrEqual(0);
        expect(menu.x + menu.width).toBeLessThanOrEqual(width);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await page.keyboard.press('Escape');
        // No command column for them, and the video uses the tile's width.
        await expect(page.getByRole('button', { name: 'Take off Falcon-1' })).toHaveCount(0);
        const tile = (await page.getByTestId('video-stack').locator('.vtile').first().boundingBox())!;
        const video = (await page.getByTestId('tile-video-Falcon-1').boundingBox())!;
        expect(video.width, `${email} at ${width} px`).toBeGreaterThan(tile.width - 30);
        expect(video.height).toBeGreaterThan(100);
      }
    }
  });

  test('F9d the 3D opening shot shows the whole fleet clear of the video stack; tile names stay readable', async ({ page, consoleErrors }) => {
    void consoleErrors;
    type Win = { __athenaLive3D?: { viewer: any; tracks: Map<string, unknown> } };
    for (const [width, height] of [
      [1100, 800],
      [700, 900],
    ] as const) {
      await page.context().clearCookies();
      await page.setViewportSize({ width, height });
      await login(page, 'pia@athena-sky.local');
      await page.evaluate(() => localStorage.setItem('athena.live.view', '3d'));
      await page.goto('/live');
      await expect(page.getByTestId('video-stack').locator('.vtile')).toHaveCount(3);
      // The drone names are shown in full in the tiles (the status chips give way).
      const names = await page.$$eval('.vtile-head b', (els) => els.map((e) => ({ name: e.textContent, clipped: e.scrollWidth > e.clientWidth + 1 })));
      expect(names.map((n) => n.name).sort()).toEqual(['Falcon-1', 'Falcon-2', 'Heron-3']);
      expect(names.filter((n) => n.clipped), `${width} px`).toEqual([]);
      await page.waitForFunction(() => ((window as unknown as Win).__athenaLive3D?.tracks.size ?? 0) >= 3, null, { timeout: 60_000 });
      // Wait for the opening flight to end (the camera stops moving), then every drone is on screen
      // between the toolbar, the video stack and the event log.
      const where = () =>
        page.evaluate(() => {
          const v = (window as unknown as Win).__athenaLive3D!.viewer;
          const t = v.clock.currentTime;
          const canvas = v.scene.canvas.getBoundingClientRect();
          const pts = v.entities.values
            .filter((e: any) => String(e.id).startsWith('drone:'))
            .map((e: any) => v.scene.cartesianToCanvasCoordinates(e.position.getValue(t)))
            .map((c: any) => (c ? { x: Math.round(c.x + canvas.left), y: Math.round(c.y + canvas.top) } : null));
          const cam = v.camera.positionWC;
          return { pts, cam: `${Math.round(cam.x)},${Math.round(cam.y)},${Math.round(cam.z)}` };
        });
      let last = '';
      await expect
        .poll(
          async () => {
            const w = await where();
            const settled = w.cam === last && w.pts.every(Boolean);
            last = w.cam;
            return settled;
          },
          { timeout: 30_000, intervals: [1000] },
        )
        .toBe(true);
      const { pts } = await where();
      const stack = (await page.getByTestId('video-stack').boundingBox())!;
      const bar = (await page.locator('.console-toolbar').boundingBox())!;
      const log = (await page.locator('.console-log').boundingBox())!;
      for (const p of pts as { x: number; y: number }[]) {
        expect(p.x, `${width} px: drone left of the video stack`).toBeLessThan(stack.x - 10);
        expect(p.x).toBeGreaterThan(10);
        expect(p.y, `${width} px: drone below the toolbar`).toBeGreaterThan(bar.y + bar.height);
        expect(p.y, `${width} px: drone above the event log`).toBeLessThan(log.y);
      }
    }
  });

  test('F9e the live console draws the plan loaded on the drone – not the mission as edited since', async ({ page, consoleErrors }) => {
    void consoleErrors;
    await login(page, 'pia@athena-sky.local');
    const headers = { 'x-csrf-token': (await page.context().cookies()).find((c) => c.name === 'athena_csrf')!.value };
    const orgId = (await (await page.request.get('/api/v2/auth/me')).json()).memberships[0].orgId;
    const heron = (await (await page.request.get(`/api/v2/organisations/${orgId}/drones`)).json()).find((d: { name: string }) => d.name === 'Heron-3');
    const plan = (to: { lat: number; lon: number }) => ({
      home: { ...DEMO_HOME, alt: 0 },
      items: [{ type: 'takeoff', alt: 20 }, { type: 'waypoint', ...to, alt: 20 }, { type: 'rtl' }],
      rallyPoints: [],
      defaultSpeed: 8,
      defaultAlt: 20,
    });
    const created = await page.request.post(`/api/v2/organisations/${orgId}/missions`, { headers, data: { name: 'Edited after upload', plan: plan(destinationPoint(DEMO_HOME, 0, 300)) } });
    const missionId = (await created.json()).id;
    const upload = () => page.request.post(`/api/v2/organisations/${orgId}/missions/${missionId}/upload`, { headers, data: { droneId: heron.id } });
    expect((await (await upload()).json()).result).toBe('accepted');
    // Edited afterwards: the waypoint moves east – but the drone still holds the northern one.
    const edited = await page.request.put(`/api/v2/organisations/${orgId}/missions/${missionId}`, { headers, data: { plan: plan(destinationPoint(DEMO_HOME, 90, 300)) } });
    expect(edited.status()).toBe(200);
    await page.evaluate(() => localStorage.setItem('athena.live.view', 'map'));
    await page.goto('/live');
    const route = page.locator(`path.map-line-route-${heron.id}`);
    await expect(route).toHaveCount(1);
    // Direction of the route's first leg on screen (from the take-off point to the waypoint).
    const leg = async () => {
      const pts = [...((await route.getAttribute('d')) ?? '').matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
      const to = pts.find((q) => Math.hypot(q.x - pts[0]!.x, q.y - pts[0]!.y) > 5);
      return to ? { dx: to.x - pts[0]!.x, dy: to.y - pts[0]!.y } : null;
    };
    const north = async () => {
      const l = await leg();
      return !!l && l.dy < 0 && Math.abs(l.dy) > 2 * Math.abs(l.dx);
    };
    const east = async () => {
      const l = await leg();
      return !!l && l.dx > 0 && Math.abs(l.dx) > 2 * Math.abs(l.dy);
    };
    await expect.poll(north).toBe(true);
    // Uploading the edited mission replaces it on the drone – and on the map, without a reload.
    expect((await (await upload()).json()).result).toBe('accepted');
    await expect.poll(east).toBe(true);
  });

  test('F9f a crowded console on a phone: 3D tags clear of the overlays, whole status chips, tiles of drones without a camera', async ({ page, consoleErrors }) => {
    void consoleErrors;
    type Win = { __athenaLive3D?: { viewer: any; tracks: Map<string, unknown> } };
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    const headers = { 'x-csrf-token': (await page.context().cookies()).find((c) => c.name === 'athena_csrf')!.value };
    const orgId = (await (await page.request.get('/api/v2/auth/me')).json()).memberships[0].orgId;
    const wsBase = String(test.info().project.use.baseURL).replace(/^http/, 'ws');
    // Twelve more drones side by side at the demo home – one with a long name – none with a camera.
    const clients: LinkClient[] = [];
    const ids: string[] = [];
    const LONG = 'Survey-Hexacopter-North-Sector-07';
    try {
      for (let i = 0; i < 12; i++) {
        const created = await page.request.post(`/api/v2/organisations/${orgId}/drones`, { headers, data: { name: i === 0 ? LONG : `Crowd-${i}`, model: 'X4' } });
        expect(created.status()).toBe(201);
        const d = await created.json();
        ids.push(d.id);
        const c = new LinkClient({ url: `${wsBase}/api/v2/link`, key: d.linkKey, drone: new VirtualDrone({ home: destinationPoint(DEMO_HOME, 200 + i * 7, 15 + i * 3), groundAltMsl: 10, seed: 40 + i }), video: false });
        clients.push(c);
        c.start();
      }
      await page.evaluate(() => localStorage.setItem('athena.live.view', '3d'));
      await page.goto('/live');
      await expect(page.getByTestId('video-stack').locator('.vtile')).toHaveCount(15);
      await page.waitForFunction(() => ((window as unknown as Win).__athenaLive3D?.tracks.size ?? 0) >= 15, null, { timeout: 60_000 });

      // No camera: the tile says so (instead of waiting for video forever) and offers no video.
      const crowd = page.getByTestId('tile-Crowd-3');
      await crowd.scrollIntoViewIfNeeded();
      await expect(page.getByTestId('tile-video-Crowd-3')).toContainText('No camera on this drone');
      await expect(crowd.getByRole('button', { name: 'Live video' })).toBeDisabled();

      // The 3D tags: none under the toolbar, the video strip, the event log or the imagery switch,
      // none on another – a tag without room is left out until there is some.
      const tags = async () =>
        page.evaluate(() => {
          const v = (window as unknown as Win).__athenaLive3D!.viewer;
          const t = v.clock.currentTime;
          const box = v.scene.canvas.getBoundingClientRect();
          const ctx = document.createElement('canvas').getContext('2d')!;
          ctx.font = '600 12px sans-serif';
          const out: { id: string; l: number; r: number; t: number; b: number }[] = [];
          for (const e of v.entities.values) {
            if (!String(e.id).startsWith('drone:') || !e.label) continue;
            if (e.label.show && e.label.show.getValue(t) === false) continue;
            const c = v.scene.cartesianToCanvasCoordinates(e.position.getValue(t));
            if (!c) continue;
            const off = e.label.pixelOffset.getValue(t);
            const w = ctx.measureText(String(e.label.text.getValue(t))).width + 12;
            const x = box.left + c.x + off.x;
            const y = box.top + c.y + off.y;
            out.push({ id: String(e.id), l: x - w / 2, r: x + w / 2, t: y - 11, b: y + 11 });
          }
          const overlays = [...document.querySelectorAll('.console-toolbar, .console-videos .vtile, .console-log, .live3d .map-overlay')]
            .map((el) => el.getBoundingClientRect())
            .filter((r) => r.width > 0 && r.height > 0)
            .map((r) => ({ l: r.left, r: r.right, t: r.top, b: r.bottom }));
          return { tags: out, overlays, top: box.top, bottom: box.bottom };
        });
      const cut = (a: { l: number; r: number; t: number; b: number }, b: { l: number; r: number; t: number; b: number }) => a.l < b.r - 2 && b.l < a.r - 2 && a.t < b.b - 2 && b.t < a.b - 2;
      // Tags moved away from their drone are tied to it by a leader line.
      const leaders = () =>
        page.evaluate(() => {
          const v = (window as unknown as Win).__athenaLive3D!.viewer;
          const t = v.clock.currentTime;
          return v.entities.values
            .filter((e: any) => String(e.id).startsWith('drone:'))
            .map((e: any) => {
              const id = String(e.id).slice(6);
              const shown = !(e.label.show && e.label.show.getValue(t) === false);
              const off = e.label.pixelOffset.getValue(t);
              const line = v.entities.getById(`leader:${id}`)?.polyline?.positions?.getValue(t)?.length ?? 0;
              return { id, shown, moved: Math.abs(off.y) > 48, line };
            });
        });
      await expect.poll(async () => (await tags()).tags.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
      await page.waitForTimeout(4000); // the opening flight to the fleet
      const seen = await tags();
      for (const tag of seen.tags) {
        expect(seen.overlays.filter((o) => cut(tag, o)), `${tag.id} under an overlay`).toEqual([]);
        expect(tag.t).toBeGreaterThanOrEqual(seen.top);
        expect(seen.tags.filter((o) => o !== tag && cut(tag, o)), `${tag.id} on another tag`).toEqual([]);
      }
      const tied = await leaders();
      expect(tied.some((l) => l.shown && l.moved), 'the crowd moves some tags away').toBe(true);
      expect(tied.filter((l) => l.shown && l.moved && l.line !== 2), 'moved tags without a leader line').toEqual([]);

      // Tiles at phone and tablet widths: the long name gives way (ellipsis), and a status chip is
      // shown whole or not at all – never cut mid-word; the arm state is always there.
      await page.evaluate(() => localStorage.setItem('athena.live.view', '2d'));
      for (const [width, height] of [
        [390, 844],
        [820, 1180],
        [1024, 768],
      ] as const) {
        await page.setViewportSize({ width, height });
        await page.goto('/live');
        const tile = page.getByTestId(`tile-${LONG}`);
        await tile.scrollIntoViewIfNeeded();
        await expect(tile.locator('.vtile-chips .chip').first()).toBeVisible();
        const head = await tile.evaluate((el) => {
          const chips = el.querySelector('.vtile-chips')!.getBoundingClientRect();
          const name = el.querySelector('.vtile-name') as HTMLElement;
          return {
            nameClipped: name.scrollWidth > name.clientWidth + 1,
            chips: [...el.querySelectorAll('.vtile-chips > *')].map((c) => {
              const r = c.getBoundingClientRect();
              return { text: c.textContent, whole: r.right <= chips.right + 0.5 && r.bottom <= chips.bottom + 0.5, hidden: r.top >= chips.bottom - 0.5 };
            }),
          };
        });
        expect(head.nameClipped, `${width} px`).toBe(true);
        expect(head.chips[0], `${width} px: arm state`).toMatchObject({ text: 'Disarmed', whole: true });
        expect(head.chips.filter((c) => !c.whole && !c.hidden), `${width} px: chips cut mid-word`).toEqual([]);
        // There is room for the arm state and the flight mode: the name gives way, not they.
        expect(head.chips.filter((c) => c.whole && !c.hidden).length, `${width} px: chips shown`).toBeGreaterThanOrEqual(2);
      }
    } finally {
      for (const c of clients) await c.stop();
      for (const id of ids) await page.request.delete(`/api/v2/organisations/${orgId}/drones/${id}`, { headers });
    }
  });

  test('F9g map imagery: tile servers get the site as referrer; Cesium ion aerial imagery over HTTPS on a plain-HTTP site; unreachable tiles are reported', async ({ page, consoleErrors }) => {
    void consoleErrors;
    type Win = { __athenaLive3D?: { viewer: unknown; tracks: Map<string, unknown> } };
    const origin = new URL(String(test.info().project.use.baseURL)).origin;
    // Other sites get the site's origin – never a path or query, which can carry a token.
    expect((await page.request.get('/live')).headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');

    // OpenStreetMap tiles are asked for with the site as referrer: OSM answers requests without
    // one with "Access blocked" tiles.
    const osmReferrers: string[] = [];
    await page.route(/^https:\/\/tile\.openstreetmap\.org\//, async (route) => {
      osmReferrers.push((await route.request().allHeaders())['referer'] ?? '(none)');
      await route.fulfill({ body: TILE_PNG, contentType: 'image/png' });
    });
    await login(page);
    await page.evaluate(() => localStorage.setItem('athena.live.view', '2d'));
    await page.goto('/live');
    await expect.poll(() => osmReferrers.length, { timeout: 30_000 }).toBeGreaterThan(0);
    expect([...new Set(osmReferrers)]).toEqual([`${origin}/`]);

    // With a Cesium ion token the aerial imagery is Bing Maps through ion: its tiles are loaded
    // over HTTPS although this site is plain HTTP (the CSP allows HTTPS only).
    await page.route('**/api/v2/config', async (route) => {
      const r = await route.fetch();
      await route.fulfill({ response: r, json: { ...(await r.json()), cesiumIonToken: 'e2e-ion-token' } });
    });
    await page.route(/^https:\/\/api\.cesium\.com\//, async (route) => {
      if (/\/v1\/assets\/2\/endpoint/.test(route.request().url())) {
        await route.fulfill({ json: { type: 'IMAGERY', externalType: 'BING', options: { url: 'https://dev.virtualearth.net', key: 'e2e-bing-key', mapStyle: 'Aerial' }, attributions: [] } });
      } else {
        await route.abort('failed'); // world terrain and buildings are not part of this test
      }
    });
    await page.route(/^https:\/\/dev\.virtualearth\.net\//, async (route) => {
      // Like Bing: tile URLs with the scheme the client asks for.
      const scheme = new URL(route.request().url()).searchParams.get('uriScheme') ?? 'http';
      await route.fulfill({
        json: { resourceSets: [{ resources: [{ imageUrl: `${scheme}://ecn.{subdomain}.tiles.virtualearth.net/tiles/a{quadkey}.jpeg?g=1`, imageUrlSubdomains: ['t0', 't1', 't2', 't3'], imageWidth: 256, imageHeight: 256, zoomMin: 1, zoomMax: 21 }] }] },
      });
    });
    const bingSchemes: string[] = [];
    await page.route(/tiles\.virtualearth\.net\//, async (route) => {
      bingSchemes.push(new URL(route.request().url()).protocol);
      await route.fulfill({ body: TILE_PNG, contentType: 'image/png' });
    });
    await page.evaluate(() => localStorage.setItem('athena.live.view', '3d'));
    await page.goto('/live');
    await page.waitForFunction(() => ((window as unknown as Win).__athenaLive3D?.tracks.size ?? 0) >= 3, null, { timeout: 60_000 });
    const overlay = page.locator('.live3d .map-overlay');
    await overlay.getByRole('button', { name: 'Satellite' }).click();
    await expect.poll(() => bingSchemes.length, { timeout: 30_000 }).toBeGreaterThan(0);
    expect([...new Set(bingSchemes)]).toEqual(['https:']);
    await expect(page.getByTestId('imagery-unavailable')).toHaveCount(0);

    // A tile server this browser cannot reach: the view says so instead of showing a bare globe.
    await page.route(/^https:\/\/tile\.openstreetmap\.org\//, (route) => route.abort('failed'));
    await overlay.getByRole('button', { name: 'Map' }).click();
    await expect(page.getByTestId('imagery-unavailable')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('imagery-unavailable')).toHaveAttribute('title', /tile\.openstreetmap\.org/);
  });

  test('F7 3D mission planning: click to add waypoints, save, export and check airspace', async ({ page, consoleErrors }) => {
    void consoleErrors;
    // The longest planner scenario (software-rendered 3D with terrain and imagery): room for a busy machine.
    test.setTimeout(240_000);
    await login(page);
    await page.getByRole('link', { name: '3D Mission Planning' }).click();
    await page.getByRole('button', { name: 'New mission' }).click();
    await page.getByLabel('Mission name').fill('E2E corridor');
    await page.getByRole('button', { name: 'Create & open planner' }).click();
    const canvas = page.getByTestId('planner-3d').locator('canvas').first();
    await expect(canvas).toBeVisible({ timeout: 60_000 });
    await page.waitForFunction(() => !!(window as unknown as { __athenaPlanner?: unknown }).__athenaPlanner);
    // The organisation's airspace zones and hazards are drawn (also when they load before the 3D view).
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const v = (window as unknown as { __athenaPlanner: { viewer: any } }).__athenaPlanner.viewer;
            return (v.dataSources.getByName('airspace')[0]?.entities.values ?? []).map((e: any) => String(e.name));
          }),
        { timeout: 20_000 },
      )
      .toEqual(expect.arrayContaining([expect.stringContaining('Demo hospital helipad'), expect.stringContaining('Demo 161 kV power line')]));
    await page.waitForTimeout(1500);
    const box = (await canvas.boundingBox())!;
    for (const [fx, fy] of [[0.45, 0.55], [0.55, 0.5], [0.6, 0.6]] as const) {
      await canvas.click({ position: { x: box.width * fx, y: box.height * fy } });
      await page.waitForTimeout(300);
    }
    await expect(page.getByTestId('waypoint-count')).toHaveText('3');
    // Shift + drag of the selected waypoint changes its altitude (0.5 m per pixel).
    const selectedAlt = page.locator('.item-row.selected input[aria-label="Altitude"]');
    const altBefore = Number(await selectedAlt.inputValue());
    const dragUp = async () => {
      // Where the selected (larger) waypoint is drawn now – read after the scene has updated.
      const pt = await page.evaluate(() => {
        const v = (window as unknown as { __athenaPlanner: { viewer: any } }).__athenaPlanner.viewer;
        const ds = v.dataSources.getByName('mission')[0];
        const e = ds.entities.values.find((x: any) => String(x.id).startsWith('wp:') && x.point?.pixelSize?.getValue(v.clock.currentTime) === 16);
        const c = v.scene.cartesianToCanvasCoordinates(e.position.getValue(v.clock.currentTime));
        return { x: c.x as number, y: c.y as number };
      });
      await page.keyboard.down('Shift');
      await page.mouse.move(box.x + pt.x, box.y + pt.y);
      await page.mouse.down();
      await page.mouse.move(box.x + pt.x, box.y + pt.y - 80, { steps: 8 });
      await page.mouse.up();
      await page.keyboard.up('Shift');
    };
    // On a slow software renderer the selection may still be redrawing: retry the drag.
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.waitForTimeout(500);
      await dragUp();
      const raised = await expect
        .poll(async () => Number(await selectedAlt.inputValue()), { timeout: 4000 })
        .toBeGreaterThanOrEqual(altBefore + 30)
        .then(
          () => true,
          () => false,
        );
      if (raised) break;
    }
    expect(Number(await selectedAlt.inputValue())).toBeGreaterThanOrEqual(altBefore + 30);
    await expect(page.getByTestId('waypoint-count')).toHaveText('3');
    await page.getByRole('button', { name: '+ RTL' }).click();
    await page.getByRole('button', { name: 'Top (orthographic)' }).click();
    await page.getByRole('button', { name: 'Surface view' }).click();
    await page.getByRole('button', { name: 'Tilt' }).click();
    // Map-first panel: summary bar, Resume only once saved, Mission setting, item list.
    await expect(page.getByTestId('planner-foot')).toContainText('3 waypoints');
    await expect(page.getByRole('button', { name: 'Resume' })).toBeDisabled();
    await expect(page.getByTestId('mission-settings').getByLabel('Vehicle type')).toBeVisible();
    await page.getByRole('button', { name: '+ loiter' }).click();
    await page.getByLabel('Loiter end condition').selectOption('unlimited');
    await expect(page.getByTestId('waypoint-count')).toHaveText('4');
    await page.getByRole('button', { name: /^Delete item \d+$/ }).nth(4).click();
    await expect(page.getByTestId('waypoint-count')).toHaveText('3');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Resume' })).toBeEnabled();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '.plan' }).click();
    expect((await download).suggestedFilename()).toBe('E2E_corridor.plan');
    await page.getByRole('button', { name: 'Check airspace' }).click();
    await expect(page.getByTestId('airspace-check')).toBeVisible();
    // The corridor is requested from the planner: the dialog says who decides (no external authority
    // here), and its Submit sends one request however often it is clicked while the server works.
    // It is the corridor of the mission as stored: unsaved edits are saved first.
    await page.getByLabel('Mission name').fill('E2E corridor (authorised)');
    const savedFirst = page.waitForRequest((r) => r.method() === 'PUT' && /\/api\/v2\/organisations\/[^/]+\/missions\/[^/?]+$/.test(r.url()));
    await page.getByRole('button', { name: 'Request authorisation' }).click();
    expect((await savedFirst).postDataJSON().name).toBe('E2E corridor (authorised)');
    await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();
    const dialog = page.getByRole('dialog', { name: 'Request flight authorisation (corridor)' });
    await expect(dialog.getByTestId('authorize-how')).toContainText('The others are approved instantly and published on the public safety map');
    let posts = 0;
    await page.route(/\/airspace\/authorizations$/, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      posts++;
      await new Promise((r) => setTimeout(r, 3000));
      await route.continue();
    });
    // A double click: the second click finds the button already waiting for the server.
    await dialog.getByRole('button', { name: 'Submit' }).dblclick();
    await expect(dialog.getByRole('button', { name: 'Submitting…' })).toBeDisabled();
    await expect(page.getByText(/^Authorisation ATH-/)).toBeVisible({ timeout: 15_000 });
    expect(posts).toBe(1);
    await page.unroute(/\/airspace\/authorizations$/);

    // An edit made while Save is under way is not taken for saved: Save stays offered, Resume waits.
    const missionPut = /\/api\/v2\/organisations\/[^/]+\/missions\/[^/?]+$/;
    await page.route(missionPut, async (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      await new Promise((r) => setTimeout(r, 2000));
      await route.continue();
    });
    await page.getByLabel('Mission name').fill('E2E corridor v2');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByLabel('Mission name').fill('E2E corridor v3');
    await expect(page.getByText('Mission saved – but not the changes made meanwhile: save again')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Resume' })).toBeDisabled();
    await page.unroute(missionPut);
    const saved = page.waitForRequest((r) => r.method() === 'PUT' && missionPut.test(r.url()));
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    expect((await saved).postDataJSON().name).toBe('E2E corridor v3');
    await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Resume' })).toBeEnabled();
  });

  test('F7b 3D planner frames the mission clear of the panel and toolbars and keeps labels apart', async ({ page, consoleErrors }) => {
    void consoleErrors;
    await login(page);
    type Win = { __athenaPlanner?: { viewer: any } };
    for (const [mission, size] of [
      ['Field survey – North parcel', { width: 1440, height: 900 }],
      ['Field survey – North parcel', { width: 1200, height: 900 }],
      ['Field survey – North parcel', { width: 390, height: 844 }],
      // A long north–south corridor: the hardest case for the phone's narrow visible band.
      ['Pipeline corridor patrol', { width: 390, height: 844 }],
      ['Pipeline corridor patrol', { width: 360, height: 740 }],
    ] as const) {
      await page.setViewportSize(size);
      await page.goto('/missions');
      await page.getByTestId('missions-table').getByRole('link', { name: mission }).click();
      await expect(page.getByTestId('planner-3d').locator('canvas').first()).toBeVisible({ timeout: 60_000 });
      await page.waitForFunction(() => !!(window as unknown as Win).__athenaPlanner);
      // The map's data attribution stays reachable – also above the panel's sheet on a phone.
      const credits = (await page.locator('.cesium-viewer-bottom').boundingBox())!;
      const sheet = (await page.getByTestId('planner-panel').boundingBox())!;
      if (sheet.y > size.height / 3) expect(credits.y + credits.height, `${size.width} px: attribution above the panel`).toBeLessThanOrEqual(sheet.y + 1);
      await expect(page.locator('.cesium-viewer-bottom a, .cesium-viewer-bottom button').first()).toBeVisible();
      for (const view of ['Fit mission', 'Top (orthographic)']) {
        await page.getByRole('button', { name: view }).click();
        await page.waitForTimeout(1000);
        const r = await page.evaluate(() => {
          const v = (window as unknown as Win).__athenaPlanner!.viewer;
          const t = v.clock.currentTime;
          const cv = v.scene.canvas.getBoundingClientRect();
          const panel = document.querySelector('.planner-side:not(.collapsed)')!.getBoundingClientRect();
          const rows = [...document.querySelector('.planner-toolbar')!.children].map((c) => c.getBoundingClientRect()).filter((b) => b.height > 0);
          const top = Math.max(cv.top, ...rows.map((b) => b.bottom));
          const ds = v.dataSources.getByName('mission')[0];
          const hidden: string[] = [];
          const ctx = document.createElement('canvas').getContext('2d')!;
          const labels: { id: string; l: number; r: number; t: number; b: number }[] = [];
          for (const e of ds.entities.values) {
            const id = String(e.id);
            if (!/^(wp:|home$|rally:)/.test(id)) continue;
            const c = v.scene.cartesianToCanvasCoordinates(e.position.getValue(t));
            if (!c) {
              hidden.push(id);
              continue;
            }
            const x = cv.left + c.x;
            const y = cv.top + c.y;
            const underPanel = x > panel.left && x < panel.right && y > panel.top && y < panel.bottom;
            if (id.startsWith('wp:') && (x < cv.left || x > cv.right || y < top || y > cv.bottom || underPanel)) hidden.push(id);
            if (e.label && e.label.show?.getValue(t) !== false) {
              const wp = id.startsWith('wp:');
              ctx.font = wp ? '600 12px sans-serif' : '13px sans-serif';
              const w = ctx.measureText(String(e.label.text.getValue(t))).width + (wp ? 10 : 6) - 2;
              const h = (wp ? 19 : 17) - 2;
              const off = e.label.pixelOffset.getValue(t);
              labels.push({ id, l: c.x + off.x - w / 2, r: c.x + off.x + w / 2, t: c.y + off.y - h / 2, b: c.y + off.y + h / 2 });
            }
          }
          const clashes: string[] = [];
          for (let i = 0; i < labels.length; i++)
            for (let j = i + 1; j < labels.length; j++) {
              const a = labels[i]!;
              const b = labels[j]!;
              if (a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b) clashes.push(`${a.id} × ${b.id}`);
            }
          return { hidden, clashes, shown: labels.length };
        });
        expect(r.hidden, `${mission} at ${size.width} px · ${view}: waypoints outside the visible part`).toEqual([]);
        expect(r.clashes, `${mission} at ${size.width} px · ${view}: overlapping labels`).toEqual([]);
        expect(r.shown).toBeGreaterThan(0);
      }
    }
  });

  test('F6 flight logs: analytics, ULog field plotting and exports', async ({ page, consoleErrors }) => {
    void consoleErrors;
    await login(page);
    await page.getByRole('link', { name: 'Flight Logs', exact: true }).click();
    await page.getByLabel('Drone').selectOption({ label: 'Heron-3' });
    await page.getByTestId('flights-table').locator('tbody tr').first().getByRole('link').click();
    await expect(page.getByTestId('analysis')).toContainText(/imbalance/i);
    // open a flight with an on-board ULog attached
    await page.goto('/flights');
    const rows = page.getByTestId('flights-table').locator('tbody tr');
    await expect(rows.first()).toBeVisible();
    const n = await rows.count();
    let found = false;
    for (let i = 0; i < n && !found; i++) {
      await page.goto('/flights');
      await page.getByTestId('flights-table').locator('tbody tr').nth(i).getByRole('link').click();
      // wait until the file list has loaded (either a log file or the "no log" notice)
      await expect(page.getByText(/No original log attached|\.ulg/).first()).toBeVisible();
      if (await page.getByLabel('Topic').count()) found = true;
    }
    expect(found).toBe(true);
    await page.getByLabel('Topic').selectOption('battery_status#0');
    await page.getByLabel('Field').selectOption('voltage_v');
    await page.getByRole('button', { name: 'Plot' }).click();
    await expect(page.getByRole('button', { name: 'Export PNG' })).toBeVisible();
    const dl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'KML' }).click();
    expect((await dl).suggestedFilename()).toMatch(/\.kml$/);
  });

  test('F8 airspace: request a cylinder authorisation and see it on the public safety map', async ({ page, consoleErrors }) => {
    void consoleErrors;
    await login(page);
    await page.getByRole('link', { name: 'Airspace & UTM' }).click();
    await expect(page.getByText('Demo hospital helipad')).toBeVisible();
    await page.getByRole('button', { name: 'Cylinder plan' }).click();
    const map = page.getByTestId('airspace-map');
    const box = (await map.boundingBox())!;
    await map.click({ position: { x: box.width * 0.2, y: box.height * 0.2 } });
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(page.getByText(/clear|review|blocked/).first()).toBeVisible();
    await page.getByRole('button', { name: 'Submit request' }).click();
    const row = page.getByTestId('authorizations').locator('tbody tr').first();
    await expect(row).toContainText(/approved|pending|rejected/);
    const ref = (await row.locator('b').first().textContent())!;
    expect(ref).toMatch(/^ATH-/);
    if ((await row.textContent())!.includes('approved')) {
      await page.goto('/safety-map');
      await expect(page.getByText(ref)).toBeVisible();
    }
  });

  test('F8c an authorisation can be cancelled by its requester or a mission manager only', async ({ page, consoleErrors }) => {
    void consoleErrors;
    // The demo reservation was requested by the demo owner: a pilot sees no Cancel, the manager does.
    for (const [email, cancel] of [
      ['pia@athena-sky.local', 0],
      ['maya@athena-sky.local', 1],
    ] as const) {
      await page.context().clearCookies();
      await login(page, email);
      await page.goto('/airspace');
      const row = page.locator('tr', { hasText: 'ATH-DEMO0001' });
      await expect(row).toBeVisible();
      // Its history: when it was approved (automatically: by nobody).
      await expect(row.getByTestId('auth-approved')).toHaveText(/^Approved \S/);
      await expect(row.getByTestId('auth-cancelled')).toHaveCount(0);
      await expect(row.getByRole('button', { name: 'Cancel' }), email).toHaveCount(cancel);
      // The action cell is a normal table cell: the row's separator lines line up.
      const cells = await row.locator('td').evaluateAll((tds) => tds.map((td) => getComputedStyle(td).display));
      expect(new Set(cells)).toEqual(new Set(['table-cell']));
    }
  });

  // Without the check for browser errors: the failures answered below are logged by the browser.
  test('F8e the Airspace page says what could not be loaded – never "no data" – and keeps the requests shown when more fail to load', async ({ page }) => {
    await login(page);
    // More than 500 requests (a real one, many times over); a longer part of the list can be slow or fail.
    let sample: Record<string, unknown> | null = null;
    let failMore = true;
    let slowMore = false;
    await page.route(/\/airspace\/authorizations\?limit=\d+$/, async (route) => {
      const limit = Number(new URL(route.request().url()).searchParams.get('limit'));
      if (!sample) sample = ((await (await route.fetch()).json()) as Record<string, unknown>[])[0]!;
      if (limit > 501) {
        if (slowMore) await new Promise((r) => setTimeout(r, 1500));
        if (failMore) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'unavailable', message: 'List unavailable' }) });
      }
      const rows = Array.from({ length: Math.min(limit, 700) }, (_, i) => ({ ...sample, id: `x-${i}`, reference: `ATH-${String(i).padStart(8, '0')}` }));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
    });
    await page.route(/\/airspace\/zones$/, (route) =>
      route.request().method() === 'GET' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'unavailable', message: 'Zones unavailable' }) }) : route.continue(),
    );
    await page.goto('/airspace');
    // The zones: their error – in the list and on the map – not "No airspace data".
    await expect(page.getByRole('alert').filter({ hasText: 'Airspace zones could not be loaded: Zones unavailable' })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'Airspace zones (not drawn) could not be loaded' })).toBeVisible();
    await expect(page.getByText('No airspace data. Draw zones or import GeoJSON.')).toHaveCount(0);
    // The requests: the 500 most recent, and a notice.
    const partial = page.getByTestId('authorizations-partial');
    const rows = page.getByTestId('authorizations').locator('tbody tr');
    await expect(partial).toContainText('Showing the 500 most recent requests');
    await expect(rows).toHaveCount(500);
    // 500 more, slow and then failing: meanwhile and afterwards the 500 stay, with the notice – and the error.
    slowMore = true;
    await partial.getByRole('button', { name: 'Show 500 more' }).click();
    await expect(partial.getByRole('button')).toHaveText('Loading…');
    await expect(rows).toHaveCount(500);
    await expect(page.getByRole('alert').filter({ hasText: 'More requests could not be loaded: List unavailable' })).toBeVisible();
    await expect(rows).toHaveCount(500);
    await expect(partial.getByRole('button', { name: 'Show 500 more' })).toBeEnabled();
    await expect(page.getByText('No requests yet.')).toHaveCount(0);
    // Trying again works.
    failMore = false;
    slowMore = false;
    await partial.getByRole('button', { name: 'Show 500 more' }).click();
    await expect(rows).toHaveCount(700);
    await expect(page.getByTestId('authorizations-partial')).toHaveCount(0);
    await expect(page.getByRole('alert').filter({ hasText: 'More requests could not be loaded' })).toHaveCount(0);
  });

  test('F8b a mission through a restricted area is not uploaded unless the owner overrides the airspace check', async ({ page, consoleErrors }) => {
    await login(page);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'athena_csrf')!.value;
    const orgId = (await (await page.request.get('/api/v2/auth/me')).json()).memberships[0].orgId;
    // Straight south through the demo hospital helipad (restricted, 1.2 km south of home).
    const through = destinationPoint(DEMO_HOME, 180, 1700);
    const created = await page.request.post(`/api/v2/organisations/${orgId}/missions`, {
      headers: { 'x-csrf-token': csrf },
      data: { name: 'E2E helipad crossing', plan: { home: { ...DEMO_HOME, alt: 8 }, items: [{ type: 'takeoff', alt: 30 }, { type: 'waypoint', ...through, alt: 30 }, { type: 'rtl' }], rallyPoints: [], defaultSpeed: 8, defaultAlt: 30 } },
    });
    expect(created.status()).toBe(201);
    await page.goto(`/missions/${(await created.json()).id}`);
    await expect(page.getByTestId('planner-foot')).toContainText('1 waypoints');
    await page.getByRole('button', { name: 'Resume' }).click();
    const modal = page.locator('.modal');
    await modal.getByRole('button', { name: 'Upload for later', exact: true }).click();
    const blocked = page.getByTestId('upload-airspace-blocked');
    await expect(blocked).toContainText('Demo hospital helipad');
    await expect(modal.getByRole('button', { name: 'Override and upload for later' })).toBeDisabled();
    await blocked.getByRole('checkbox').check();
    await modal.getByRole('button', { name: 'Override and upload for later' }).click();
    await expect(page.getByText('Mission uploaded to the drone')).toBeVisible();
    const audit = await (await page.request.get(`/api/v2/organisations/${orgId}/audit?limit=20`)).json();
    expect(audit.items.some((e: { action: string }) => e.action === 'mission.airspace_override')).toBe(true);
    // The refused upload (409) is the only browser error.
    const unexpected = consoleErrors.filter((e) => !/status of 409/.test(e));
    consoleErrors.splice(0, consoleErrors.length, ...unexpected);
  });

  test('Security: organisation names in map labels are shown as text, never executed (stored XSS regression)', async ({ page, consoleErrors }) => {
    void consoleErrors;
    const evil = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';
    const signup = await page.request.post('/api/v2/auth/signup', {
      data: { email: `xss-${Date.now()}@example.com`, password: 'correct-horse-battery', name: 'Mallory', organisationName: evil },
    });
    expect(signup.status()).toBe(201);
    const { csrfToken, memberships } = await signup.json();
    const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
    const auth = await page.request.post(`/api/v2/organisations/${memberships[0].orgId}/airspace/authorizations`, {
      headers: { 'x-csrf-token': csrfToken },
      data: { geometry: { kind: 'cylinder', center: { lat: 25.0335, lon: 121.5645 }, radiusM: 400 }, maxAltM: 60, startAt: at(-1), endAt: at(120), isPublic: true },
    });
    expect(auth.status()).toBe(201);
    const { reference, status } = await auth.json();
    expect(status).toBe('approved');
    await page.request.post('/api/v2/auth/logout', { headers: { 'x-csrf-token': csrfToken } });

    // Opens the tooltip of every shape and reads it in the same task: other layers may cover
    // the reservation, and live updates re-render the layers (closing open tooltips).
    const hoverAll = async (mapTestId: string) => {
      await expect(page.getByTestId(mapTestId).locator('path.leaflet-interactive').first()).toBeVisible();
      const find = () =>
        page.evaluate(
          ({ id, ref }) => {
            for (const p of document.querySelectorAll(`[data-testid="${id}"] path.leaflet-interactive`)) {
              p.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
              const t = [...document.querySelectorAll('.leaflet-tooltip')].find((x) => x.textContent?.includes(ref));
              if (t) return { text: t.textContent ?? '', elements: t.querySelectorAll('img, script, svg').length };
              p.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
            }
            return null;
          },
          { id: mapTestId, ref: reference },
        );
      // The reservations may arrive after the first shapes (the zones): looked for until they are drawn.
      let tip: { text: string; elements: number } | null = null;
      await expect.poll(async () => (tip = await find()) !== null, { timeout: 15_000, message: `tooltip of ${reference}` }).toBe(true);
      const found = tip as unknown as { text: string; elements: number };
      expect(found.text).toContain(evil);
      expect(found.elements).toBe(0);
      await page.waitForTimeout(500);
    };

    const index = await page.request.get('/safety-map');
    expect(index.headers()['content-security-policy']).toMatch(/script-src 'self'(?! 'unsafe-inline')/);

    // public safety map (no login) …
    await page.goto('/safety-map');
    await expect(page.getByText(reference)).toBeVisible();
    await hoverAll('safety-map');
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    // … and another operator's airspace page
    await login(page);
    await page.getByRole('link', { name: 'Airspace & UTM' }).click();
    await hoverAll('airspace-map');
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  });

  test('F10/F12 API tokens and webhooks from settings; Swagger reference', async ({ page, consoleErrors }) => {
    void consoleErrors;
    await login(page);
    await page.getByRole('link', { name: 'Settings & API' }).click();
    await page.getByRole('button', { name: 'API tokens' }).click();
    await page.getByPlaceholder('Token name, e.g. ERP integration').fill('e2e token');
    await page.getByRole('button', { name: 'Create token' }).click();
    const token = (await page.getByTestId('api-token').textContent())!;
    expect(token).toMatch(/^ast_/);
    const res = await page.request.get('/api/v2/organisations', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status()).toBe(200);
    await page.getByRole('button', { name: 'Members & roles' }).click();
    await expect(page.getByTestId('members-table')).toContainText('Maya Lin');
    await page.getByRole('button', { name: 'Webhooks' }).click();
    await page.getByLabel('Webhook URL').fill('https://example.com/athena/hook');
    await page.getByRole('button', { name: 'Add webhook' }).click();
    await expect(page.locator('.secret')).toHaveText(/^whsec_/);
    await expect(page.getByText('https://example.com/athena/hook')).toBeVisible();
    // Buttons that wait for the server send one request, also on a double click – and stay busy
    // until the list shows the change (no second request for a webhook or token already gone).
    const sent: string[] = [];
    page.on('request', (r) => {
      if ((r.method() === 'PATCH' || r.method() === 'DELETE') && /\/(webhooks|tokens)\//.test(r.url())) sent.push(r.method());
    });
    const hookRow = page.getByRole('row').filter({ hasText: 'https://example.com/athena/hook' });
    await hookRow.getByRole('button', { name: 'Pause' }).dblclick();
    await expect(hookRow.getByRole('button', { name: 'Resume' })).toBeVisible();
    await hookRow.getByRole('button', { name: 'Delete' }).dblclick();
    await expect(page.getByText('https://example.com/athena/hook')).toHaveCount(0);
    await page.getByRole('button', { name: 'API tokens' }).click();
    const tokenRow = page.getByRole('row').filter({ hasText: 'e2e token' });
    await tokenRow.getByRole('button', { name: 'Revoke' }).dblclick();
    await expect(tokenRow).toHaveCount(0);
    expect(sent).toEqual(['PATCH', 'DELETE', 'DELETE']);
    await expect(page.getByText(/not found/i)).toHaveCount(0);
    const swagger = await page.request.get('/api/v2/docs/');
    expect(swagger.status()).toBe(200);
    const schema = await page.request.get('/api/v2/schema/');
    expect(Object.keys((await schema.json()).paths).length).toBeGreaterThan(60);
  });

  test('F9.8 drone swarm: formation preview, synchronised take-off, notifications and a common return', async ({ page, consoleErrors }) => {
    void consoleErrors;
    test.setTimeout(240_000);
    await login(page);
    await page.getByRole('link', { name: 'Real-Time Flights' }).click();
    await expect(page.getByTestId('video-stack').locator('.vtile')).toHaveCount(3);
    await page.getByRole('button', { name: /^Swarm/ }).click();
    const panel = page.getByTestId('swarm-panel');
    await panel.getByLabel('Swarm mission').selectOption({ label: 'Pipeline corridor patrol' });
    await panel.getByLabel('Formation spacing').fill('25');
    await panel.getByRole('button', { name: 'Preview' }).click();
    await expect(page.getByTestId('swarm-preview')).toContainText('leader');
    await expect(page.getByTestId('swarm-separation')).toContainText('Closest approach');
    await panel.getByRole('button', { name: 'Upload to 3 drones' }).click();
    await expect(page.getByTestId('swarm-state')).toHaveText('ready', { timeout: 30_000 });
    await panel.getByRole('button', { name: /Synchronised take-off/ }).click();
    await expect(page.getByTestId('swarm-state')).toHaveText('running', { timeout: 30_000 });
    await expect(page.getByTestId('tile-swarm-Falcon-1')).toBeVisible();
    // A member is released by the operation, not by its own start / resume button.
    const own = page.getByTestId('tile-Falcon-1').getByRole('button', { name: /^(Resume Falcon-1|Start mission on Falcon-1)$/ });
    await expect(own).toBeDisabled();
    await expect(own).toHaveAttribute('title', /Flies in a swarm operation/);
    // The take-off barrier: drones wait for the highest one, then all pass it.
    await expect(page.getByTestId('swarm-operation')).toContainText('waiting', { timeout: 60_000 });
    for (const name of ['Falcon-1', 'Falcon-2', 'Heron-3']) await expect(page.getByTestId(`swarm-sync-${name}`)).toHaveText(/^\s*[1-9]\/\d+\s*$/, { timeout: 60_000 });
    // Notification centre.
    await page.getByTestId('notification-bell').click();
    await expect(page.getByTestId('notification-panel')).toContainText('Swarm operation started');
    await page.getByRole('button', { name: 'Mark all read' }).click();
    await expect(page.getByTestId('notification-bell')).toHaveAccessibleName('Notifications (0 unread)');
    await page.getByTestId('notification-bell').click();
    await panel.getByRole('button', { name: /Return all/ }).click();
    await expect(page.getByTestId('swarm-state')).toHaveText(/returning|completed/);
    await expect(page.getByTestId('swarm-state')).toHaveText('completed', { timeout: 120_000 });
  });

  test('F9.8b a group take-off asks first and sends one take-off per drone, however often it is clicked', async ({ page, consoleErrors }) => {
    void consoleErrors;
    // Take-off commands are answered here and never reach the drones: they stay on the ground.
    const takeoffs: { droneId: string; alt: number }[] = [];
    await page.routeWebSocket(/\/api\/v2\/live/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => {
        let msg: { type?: string; command?: string; droneId?: string; requestId?: string; params?: { alt?: number } } | null = null;
        try {
          msg = typeof m === 'string' ? JSON.parse(m) : null;
        } catch {
          msg = null;
        }
        if (msg?.type === 'command' && msg.command === 'takeoff') {
          takeoffs.push({ droneId: String(msg.droneId), alt: Number(msg.params?.alt) });
          ws.send(JSON.stringify({ type: 'ack', droneId: msg.droneId, requestId: msg.requestId, command: 'takeoff', result: 'accepted' }));
          return;
        }
        server.send(m);
      });
    });
    const dialogs: string[] = [];
    page.on('dialog', (d) => dialogs.push(d.message()));
    await login(page);
    await page.getByRole('link', { name: 'Real-Time Flights' }).click();
    await expect(page.getByTestId('video-stack').locator('.vtile')).toHaveCount(3);
    await page.getByRole('button', { name: /^Swarm/ }).click();
    const panel = page.getByTestId('swarm-panel');
    await panel.getByLabel('Group take-off altitude').fill('20');
    await panel.getByLabel('Group altitude stagger').fill('5');
    await panel.getByRole('button', { name: 'Take off selected' }).dblclick();
    await expect(page.getByText('takeoff sent to 3 drones')).toBeVisible();
    await page.waitForTimeout(1000);
    expect(dialogs).toEqual(['Take off Falcon-1 to 20 m, Falcon-2 to 25 m, Heron-3 to 30 m?']);
    expect(takeoffs.map((t) => t.alt).sort((a, b) => a - b)).toEqual([20, 25, 30]);
    expect(new Set(takeoffs.map((t) => t.droneId)).size).toBe(3);
  });

  test('F9.9 AI vision: detect people and vehicles in the live video, recognise and follow a person', async ({ page, consoleErrors }) => {
    void consoleErrors;
    test.setTimeout(240_000);
    await login(page);
    await page.getByRole('link', { name: 'Real-Time Flights' }).click();
    const tile = page.getByTestId('tile-Falcon-2');
    await expect(tile.getByText('Disarmed', { exact: true })).toBeVisible({ timeout: 60_000 });
    await tile.getByRole('button', { name: 'Take off Falcon-2' }).click();
    const alt = async () => Number(((await page.getByTestId('tile-foot-Falcon-2').locator('[title="Altitude above home"]').textContent()) ?? '').match(/(\d+) m/)?.[1] ?? 0);
    await expect.poll(alt, { timeout: 30_000 }).toBeGreaterThan(12);
    await tile.getByRole('button', { name: 'AI detection Falcon-2' }).click();
    await expect(page.getByTestId('tile-ai-Falcon-2')).toContainText('AI');
    // Fly to a point 14 m south of where a walking person will be, facing north.
    const world = new SimWorld(worldAnchor(DEMO_HOME));
    const start = destinationPoint(DEMO_HOME, 90, 40);
    const personBox = tile.locator('.det-box.person').first();
    for (let attempt = 0; attempt < 3 && !(await personBox.isVisible()); attempt++) {
      const arrival = Date.now() + 14_000;
      const person = world
        .targetsAt(arrival)
        .filter((t) => t.kind === 'person')
        .sort((a, b) => haversineDistance(start, world.positionOf(a)) - haversineDistance(start, world.positionOf(b)))[0]!;
      const view = destinationPoint(world.positionOf(person), 180, 14);
      await tile.getByRole('button', { name: 'Reposition Falcon-2' }).click();
      const form = page.getByTestId('reposition-form');
      await form.getByLabel('Reposition altitude').fill('14');
      await form.getByLabel('Reposition speed').fill('10');
      await form.getByLabel('Reposition heading').fill('0');
      await form.getByLabel('Reposition latitude').fill(view.lat.toFixed(7));
      await form.getByLabel('Reposition longitude').fill(view.lon.toFixed(7));
      await form.getByRole('button', { name: 'Reposition' }).click();
      await personBox.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => undefined);
    }
    await expect(personBox).toBeVisible();
    // Recognition: class and colour of the picked object, then follow-me.
    await personBox.click();
    const bar = page.getByTestId('tile-ai-bar-Falcon-2');
    await expect(bar).toContainText('person');
    await bar.getByRole('button', { name: 'Follow' }).click();
    await expect(page.getByTestId('tile-ai-Falcon-2')).toContainText(/#\d+/);
    await expect(page.getByTestId('console-log')).toContainText('Follow-me: following person');
    await page.waitForTimeout(6000);
    await bar.getByRole('button', { name: 'Stop following' }).click();
    await expect(page.getByTestId('tile-ai-Falcon-2')).toContainText(/^AI \d+$/);
    await tile.getByRole('button', { name: 'AI detection Falcon-2' }).click();
    await expect(page.getByTestId('tile-ai-Falcon-2')).toHaveCount(0);
    await tile.getByRole('button', { name: 'Land Falcon-2' }).click();
  });

  test('F2.5/F5.7/F6.8 customisable dashboard, maintenance schedule and compliance reports', async ({ page, consoleErrors }) => {
    void consoleErrors;
    await login(page);
    // Dashboard widgets: hide one, the layout is saved per user, then reset it.
    await expect(page.getByTestId('widget-flights-by-pilot')).toBeVisible();
    await expect(page.getByTestId('flights-by-pilot').locator('path.bar').first()).toBeVisible();
    // The heatmap is drawn on a canvas layer.
    await expect(page.getByTestId('widget-heatmap')).toContainText(/\d[\d,]* samples/);
    await expect(page.getByTestId('heatmap').locator('canvas').first()).toBeVisible();
    await page.getByRole('button', { name: 'Customize' }).click();
    await page.getByRole('button', { name: 'Hide Flights by pilot' }).click();
    await expect(page.getByTestId('widget-flights-by-pilot')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('widget-kpis')).toBeVisible();
    await expect(page.getByTestId('widget-flights-by-pilot')).toHaveCount(0);
    await page.getByRole('button', { name: 'Customize' }).click();
    await page.getByRole('button', { name: 'Reset layout' }).click();
    await expect(page.getByTestId('widget-flights-by-pilot')).toBeVisible();

    // Maintenance: Heron-3 has an overdue task assigned to its pilot; record that it was done.
    await page.locator('nav').getByRole('link', { name: 'Maintenance' }).click();
    await page.getByTestId('maint-drone-Heron-3').click();
    const tasks = page.getByTestId('maintenance-tasks');
    // Where the table has no room for all its columns, each task is a block: nothing is cut off.
    for (const width of [1280, 1180, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const wrap = page.locator('.maint-wrap');
      expect(await wrap.evaluate((e) => e.scrollWidth - e.clientWidth), `${width} px: no sideways scrolling`).toBeLessThanOrEqual(1);
      const box = (await wrap.boundingBox())!;
      for (const b of await tasks.getByRole('button').all()) {
        const r = (await b.boundingBox())!;
        expect(r.x + r.width, `${width} px: ${await b.getAttribute('aria-label')} in view`).toBeLessThanOrEqual(box.x + box.width + 1);
      }
    }
    const row = tasks.locator('tr', { hasText: 'Motor 1 & ESC check' });
    await expect(row).toContainText('Overdue');
    await expect(row).toContainText('Pia Chen');
    await row.getByRole('button', { name: 'Mark Motor 1 & ESC check done' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Notes').fill('Motor 1 bearing replaced');
    await dialog.getByRole('button', { name: 'Mark done' }).click();
    await expect(row).toContainText('OK');
    await expect(page.getByText('Motor 1 bearing replaced')).toBeVisible();
    await expect(page.getByTestId('health-motorImbalance')).toBeVisible();

    // Reports: preview, choose sections, export the flights as CSV.
    await page.locator('nav').getByRole('link', { name: 'Reports' }).click();
    await expect(page.getByTestId('report-compliant-pct')).toHaveText(/\d+ %/);
    await expect(page.getByTestId('report-flights').locator('tbody tr').first()).toBeVisible();
    await page.getByRole('button', { name: 'Flight list' }).click();
    await expect(page.getByTestId('report-flights')).toHaveCount(0);
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()]);
    expect(download.suggestedFilename()).toMatch(/^athena-flights_.*\.csv$/);
    const csv = await (await download.createReadStream()).toArray();
    const text = Buffer.concat(csv).toString('utf8');
    expect(text.split('\n')[0]).toContain('Started (UTC),Drone,Pilot');
    expect(text.trim().split('\n').length).toBeGreaterThan(20);
  });

  test('Responsive: phone and tablet navigation, panels and live console menus', async ({ page, consoleErrors }) => {
    void consoleErrors;
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    // No page scrolls sideways on a phone – neither the document nor the content area (wide
    // tables scroll inside their own frame); the side column of two-column pages moves below.
    const noSideScroll = async (label: string) => {
      await page.waitForLoadState('networkidle');
      const m = await page.evaluate(() => {
        const c = document.querySelector('.content');
        return { doc: document.documentElement.scrollWidth, content: c ? c.scrollWidth - c.clientWidth : 0 };
      });
      expect(m.doc, label).toBeLessThanOrEqual(390);
      expect(m.content, `${label} (content area)`).toBeLessThanOrEqual(0);
    };
    for (const path of ['/', '/fleet', '/airspace', '/locations', '/maintenance', '/reports', '/flights', '/missions', '/analytics']) {
      await page.goto(path);
      await noSideScroll(path);
    }
    await page.goto('/fleet');
    await page.getByTestId('fleet-table').getByRole('link').first().click();
    await expect(page).toHaveURL(/\/fleet\/[0-9a-f-]{36}$/);
    await noSideScroll('drone detail');
    await page.goto('/flights');
    await page.getByTestId('flights-table').getByRole('link').first().click();
    await expect(page).toHaveURL(/\/flights\/[0-9a-f-]{36}$/);
    await noSideScroll('flight detail');
    await page.goto('/settings');
    for (const tab of ['Members & roles', 'Fleets', 'API tokens', 'Webhooks', 'Integrations', 'Audit trail']) {
      await page.locator('.tabs').getByRole('button', { name: tab }).click();
      await noSideScroll(`settings: ${tab}`);
    }
    await page.goto('/airspace');
    expect((await page.getByTestId('airspace-map').boundingBox())!.width).toBeGreaterThan(300);
    // Navigation drawer.
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.locator('nav').getByRole('link', { name: 'Flight Logs' }).click();
    await expect(page).toHaveURL(/\/flights$/);
    await expect(page.locator('.sidebar.open')).toHaveCount(0);
    // The notification centre fits the screen.
    await page.getByTestId('notification-bell').click();
    const panel = (await page.getByTestId('notification-panel').boundingBox())!;
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(390);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('notification-panel')).toHaveCount(0);

    // Phones: every command of a video tile in the bottom strip is inside the tile (none cut off).
    for (const width of [390, 360]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/live');
      await expect(page.getByTestId('video-stack').locator('.vtile')).toHaveCount(3);
      const cut = await page.$$eval('.vtile', (tiles) =>
        tiles.flatMap((t) => {
          const box = t.getBoundingClientRect();
          return [...t.querySelectorAll('.vtile-actions button')].filter((b) => b.getBoundingClientRect().bottom > box.bottom + 0.5).map((b) => b.getAttribute('aria-label'));
        }),
      );
      expect(cut, `${width} px`).toEqual([]);
    }

    // Tablet: the console's menus open over the map (not clipped by the toolbar).
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.goto('/live');
    await expect(page.getByTestId('video-stack').locator('.vtile')).toHaveCount(3);
    for (const name of [/Vehicles/, /Layers/]) {
      await page.locator('.console-toolbar summary', { hasText: name }).click();
      const menu = page.locator('.console-toolbar details[open] .dropdown-menu');
      await expect(menu).toBeVisible();
      const b = (await menu.boundingBox())!;
      expect(b.height).toBeGreaterThan(60);
      const hit = await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.dropdown-menu'), { x: b.x + b.width / 2, y: b.y + b.height / 2 });
      expect(hit).toBe(true);
      await page.locator('.console-toolbar summary', { hasText: name }).click();
    }
    // One side panel at a time.
    await page.getByRole('button', { name: /^Swarm/ }).click();
    await expect(page.getByTestId('swarm-panel')).toBeVisible();
    await page.locator('.console-toolbar').getByRole('button', { name: 'Reposition' }).click();
    await expect(page.getByTestId('reposition-form')).toBeVisible();
    await expect(page.getByTestId('swarm-panel')).toHaveCount(0);
    await page.locator('.console-toolbar').getByRole('button', { name: 'Reposition' }).click();
    await expect(page.getByTestId('reposition-form')).toHaveCount(0);

    // Console toolbar: labelled on one row when there is room, icons otherwise; on a small phone
    // it takes a second row rather than leaving the screen; panels end above the event log.
    const toolbar = async () =>
      page.evaluate(() => {
        const tb = document.querySelector('.console-toolbar')!.getBoundingClientRect();
        const kids = [...document.querySelector('.console-toolbar')!.children].map((k) => k.getBoundingClientRect()).filter((r) => r.width > 0);
        return { height: tb.height, outside: kids.filter((r) => r.right > tb.right + 0.5 || r.right > window.innerWidth).length };
      });
    for (const [width, height] of [
      [1600, 900],
      [1440, 900],
      [360, 740],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto('/live');
      await expect(page.getByTestId('video-stack').locator('.vtile')).toHaveCount(3);
      await page.getByRole('group', { name: 'Live view' }).getByRole('button', { name: /3D view/ }).click();
      await page.waitForTimeout(1500);
      const tb = await toolbar();
      expect(tb.outside, `${width} px`).toBe(0);
      if (width > 400) expect(tb.height, `${width} px: one row`).toBeLessThan(60);
    }
    await page.getByRole('button', { name: /^Swarm/ }).click();
    const swarmBox = (await page.getByTestId('swarm-panel').boundingBox())!;
    const logBox = (await page.getByTestId('console-log').boundingBox())!;
    expect(swarmBox.y + swarmBox.height).toBeLessThanOrEqual(logBox.y);
  });
  test('F9h many vehicles: the menu ends inside the console and scrolls; on a phone the closed main menu is not in the Tab order', async ({ page }) => {
    // An organisation of its own with forty registered drones.
    const signup = await page.request.post('/api/v2/auth/signup', { data: { email: `many-${Date.now()}@example.com`, password: 'correct-horse-battery', name: 'Max Many' } });
    expect(signup.status()).toBe(201);
    const { csrfToken, memberships } = await signup.json();
    const orgId = memberships[0].orgId;
    for (let i = 1; i <= 40; i++) {
      const created = await page.request.post(`/api/v2/organisations/${orgId}/drones`, { headers: { 'x-csrf-token': csrfToken }, data: { name: `Many-${String(i).padStart(2, '0')}`, model: 'X4' } });
      expect(created.status()).toBe(201);
    }
    await page.goto('/');
    await page.evaluate(() => localStorage.setItem('athena.live.view', 'map'));
    for (const [width, height] of [
      [1366, 768],
      [1440, 900],
      [820, 1100],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto('/live');
      await page.locator('.console-toolbar summary', { hasText: /Vehicles/ }).click();
      const menu = page.locator('.console-toolbar details[open] .dropdown-menu');
      await expect(menu.getByTestId('select-Many-40')).toHaveCount(1);
      const m = await menu.evaluate((el) => {
        const c = document.querySelector('.console')!.getBoundingClientRect();
        return { bottom: el.getBoundingClientRect().bottom, consoleBottom: c.bottom, scrollable: el.scrollHeight > el.clientHeight };
      });
      expect(m.bottom, `${width}×${height}`).toBeLessThanOrEqual(m.consoleBottom);
      expect(m.scrollable, `${width}×${height}`).toBe(true);
      // The wheel scrolls the list: the last drone and who is online come into view.
      await menu.hover();
      await page.mouse.wheel(0, 6000);
      await expect(menu.getByTestId('select-Many-40')).toBeInViewport();
      await expect(menu.getByText('Online now')).toBeInViewport();
    }

    // One menu at a time; Escape or a click elsewhere closes it.
    const vehicles = page.locator('.console-toolbar details', { hasText: /Vehicles/ });
    const layers = page.locator('.console-toolbar details', { hasText: /Layers/ });
    await page.goto('/live');
    await vehicles.locator('summary').click();
    await layers.locator('summary').click();
    await expect(layers).toHaveAttribute('open', '');
    await expect(vehicles).not.toHaveAttribute('open', '');
    await page.keyboard.press('Escape');
    await expect(layers).not.toHaveAttribute('open', '');
    await expect(layers.locator('summary')).toBeFocused();
    await vehicles.locator('summary').click();
    await page.mouse.click(700, 500);
    await expect(vehicles).not.toHaveAttribute('open', '');

    // Phone: Tab goes through the page, not through the links of the closed menu.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/fleet');
    await expect(page.getByTestId('fleet-table')).toBeVisible();
    const inMenu: string[] = [];
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      const where = await page.evaluate(() => (document.activeElement?.closest('.sidebar') ? document.activeElement.textContent?.trim() ?? '?' : null));
      if (where) inMenu.push(where);
    }
    expect(inMenu).toEqual([]);
    // Opened from the keyboard, the menu has the focus and keeps it; Escape gives it back.
    const menuButton = page.getByRole('button', { name: 'Menu', exact: true });
    await menuButton.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('nav').getByRole('link', { name: 'Fleet Management' })).toBeFocused();
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('.sidebar')), `Tab ${i + 1}`).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(page.locator('.sidebar.open')).toHaveCount(0);
    await expect(menuButton).toBeFocused();
    // The link of the page already shown closes the drawer too (the page is usable again).
    await page.keyboard.press('Enter');
    await page.locator('nav').getByRole('link', { name: 'Fleet Management' }).click();
    await expect(page.locator('.sidebar.open')).toHaveCount(0);
    await expect(page.locator('.main')).not.toHaveAttribute('inert', /.*/);
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await expect(page.locator('nav').getByRole('link', { name: 'Fleet Management' })).toBeFocused();
    // Following a link leads the focus to the new page's heading.
    await page.locator('nav').getByRole('link', { name: 'Flight Logs' }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/flights$/);
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  });

  test('F2.5b a dashboard with every widget hidden stays so; a changed role shows at once; refused settings say why', async ({ page, browser }) => {
    const stamp = Date.now();
    const owner = await browser.newContext({ baseURL: String(test.info().project.use.baseURL) });
    const signup = await owner.request.post('/api/v2/auth/signup', { data: { email: `wid-${stamp}@example.com`, password: 'correct-horse-battery', name: 'Wanda Widgets' } });
    const { csrfToken, memberships } = await signup.json();
    const orgId = memberships[0].orgId;
    const invited = await owner.request.post(`/api/v2/organisations/${orgId}/members`, { headers: { 'x-csrf-token': csrfToken }, data: { email: `pilot-${stamp}@example.com`, role: 'pilot' } });
    const inviteToken = new URL((await invited.json()).invitation.acceptUrl).searchParams.get('invite')!;
    // The pilot works in the page.
    expect((await page.request.post('/api/v2/auth/signup', { data: { email: `pilot-${stamp}@example.com`, password: 'correct-horse-battery', name: 'Piet Pilot', inviteToken } })).status()).toBe(201);
    await page.goto('/');
    await page.getByRole('button', { name: 'Customize' }).click();
    for (;;) {
      const hide = page.getByRole('button', { name: /^Hide / });
      if ((await hide.count()) === 0) break;
      await hide.first().click();
    }
    await page.getByRole('button', { name: 'Done' }).click();
    await page.reload();
    await expect(page.getByTestId('dashboard-empty')).toContainText('Every widget is hidden');
    await expect(page.locator('[data-testid^="widget-"]')).toHaveCount(0);
    // The owner makes the pilot an observer: the top bar says so without a reload.
    await expect(page.locator('.role-badge')).toHaveText('Pilot / operator');
    const pilotId = (await (await page.request.get('/api/v2/auth/me')).json()).user.id;
    expect((await owner.request.patch(`/api/v2/organisations/${orgId}/members/${pilotId}`, { headers: { 'x-csrf-token': csrfToken }, data: { role: 'viewer' } })).status()).toBe(200);
    await expect(page.locator('.role-badge')).toHaveText('Observer', { timeout: 15_000 });
    // "My profile" in the account menu opens that tab of the settings.
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'My profile' }).click();
    await expect(page).toHaveURL(/\/settings\?tab=profile$/);
    await expect(page.getByRole('heading', { name: 'Change password' })).toBeVisible();
    // A tab the role cannot use, given in the address, opens the organisation's instead.
    for (const tab of ['webhooks', 'integrations', 'audit']) {
      await page.goto(`/settings?tab=${tab}`);
      await expect(page.locator('.tabs button.active')).toHaveText('Organisation');
      await expect(page.getByRole('heading', { name: 'New webhook' })).toHaveCount(0);
      await expect(page.locator('.tabs').getByRole('button', { name: /Webhooks|Integrations|Audit trail/ })).toHaveCount(0);
    }
    // A refused action in the settings says why.
    await page.goto('/settings');
    await page.locator('.tabs').getByRole('button', { name: 'API tokens' }).click();
    await page.route('**/api/v2/tokens', (route) => (route.request().method() === 'POST' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'unavailable', message: 'Token service is down for maintenance' }) }) : route.continue()));
    await page.getByPlaceholder(/Token name/).fill('Robot');
    await page.getByRole('button', { name: 'Create token' }).click();
    await expect(page.getByText('Token service is down for maintenance')).toBeVisible();
    // Removed from the organisation: the page follows at once (no organisation left to show) and
    // the live connection is not tried again.
    let sockets = 0;
    page.on('websocket', () => sockets++);
    expect((await owner.request.delete(`/api/v2/organisations/${orgId}/members/${pilotId}`, { headers: { 'x-csrf-token': csrfToken } })).status()).toBe(200);
    await expect(page.getByText('You are not a member of any organisation yet')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(4000);
    expect(sockets).toBe(0);
    await owner.close();
  });

  // Without the check for browser errors: the failures answered below are logged by the browser.
  test('F2.5c each organisation shows its own Dashboard layout – nothing is saved into another; failed loads outside the pages say so', async ({ page }) => {
    const stamp = Date.now();
    const signup = await page.request.post('/api/v2/auth/signup', { data: { email: `orgs-${stamp}@example.com`, password: 'correct-horse-battery', name: 'Olga Orgs' } });
    expect(signup.status()).toBe(201);
    const { csrfToken, memberships } = await signup.json();
    const orgA = memberships[0].orgId as string;
    const orgB = (await (await page.request.post('/api/v2/organisations', { headers: { 'x-csrf-token': csrfToken }, data: { name: `Second ${stamp}` } })).json()).id as string;
    // A: the key figures only; B: maintenance only.
    for (const [org, widgets] of [[orgA, ['kpis']], [orgB, ['maintenance']]] as const) {
      expect((await page.request.put(`/api/v2/organisations/${org}/preferences/dashboard`, { headers: { 'x-csrf-token': csrfToken }, data: { value: { widgets } } })).ok()).toBe(true);
    }
    const puts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'PUT' && /\/preferences\/dashboard$/.test(r.url())) puts.push(r.url());
    });
    await page.goto('/');
    await page.getByLabel('Organisation').selectOption(orgA);
    await expect(page.getByTestId('widget-kpis')).toBeVisible();
    await expect(page.locator('[data-testid^="widget-"]')).toHaveCount(1);
    await page.getByLabel('Organisation').selectOption(orgB);
    await expect(page.getByTestId('widget-maintenance')).toBeVisible();
    await expect(page.locator('[data-testid^="widget-"]')).toHaveCount(1);
    // Back to A without a reload, then a change: stored for A, B untouched.
    await page.getByLabel('Organisation').selectOption(orgA);
    await expect(page.getByTestId('widget-kpis')).toBeVisible();
    await expect(page.locator('[data-testid^="widget-"]')).toHaveCount(1);
    await page.getByRole('button', { name: 'Customize' }).click();
    await page.getByRole('button', { name: /^Hide / }).first().click();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect.poll(() => puts.length).toBe(1);
    expect(puts[0]).toContain(`/organisations/${orgA}/`);
    expect((await (await page.request.get(`/api/v2/organisations/${orgB}/preferences/dashboard`)).json()).value.widgets).toEqual(['maintenance']);

    const down = (message: string) => (route: import('@playwright/test').Route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'unavailable', message }) });
    // The notification centre: its error, not "No notifications."
    await page.route(/\/notifications\?limit=30$/, down('Bell down'));
    await page.reload();
    await expect(page.getByTestId('notification-bell')).toHaveAccessibleName('Notifications (could not be loaded)');
    await page.getByTestId('notification-bell').click();
    await expect(page.getByTestId('notification-panel')).toContainText('The notifications could not be loaded: Bell down');
    await expect(page.getByTestId('notification-panel')).not.toContainText('No notifications.');
    await page.unroute(/\/notifications\?limit=30$/);
    // The public safety map: its error, not an empty map.
    await page.route(/\/api\/v2\/public\/safety-map/, down('Map down'));
    await page.goto('/safety-map');
    await expect(page.getByRole('alert').filter({ hasText: 'The reservations could not be loaded: Map down' })).toBeVisible();
    await expect(page.getByText('No reservations in this window.')).toHaveCount(0);
    await expect(page.getByText('Reserved airspace (0)')).toHaveCount(0);
    await page.unroute(/\/api\/v2\/public\/safety-map/);
    // A session check that fails is not taken for being signed out.
    await page.route(/\/api\/v2\/auth\/session$/, down('Auth down'));
    await page.goto('/fleet');
    await expect(page.getByTestId('session-unavailable')).toContainText('could not check your session: Auth down');
    await expect(page).toHaveURL(/\/fleet$/);
    await page.unroute(/\/api\/v2\/auth\/session$/);
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { name: 'Fleet Management' })).toBeVisible();
  });

  test('F1c an administrator sees the owner read-only; a licence that is not saved is put back', async ({ page }) => {
    const stamp = Date.now();
    const owner = await page.request.post('/api/v2/auth/signup', { data: { email: `owner-${stamp}@example.com`, password: 'correct-horse-battery', name: 'Olga Owner' } });
    const { csrfToken, memberships } = await owner.json();
    const orgId = memberships[0].orgId;
    const headers = { 'x-csrf-token': csrfToken };
    const invite = async (who: string, role: string) => {
      const r = await page.request.post(`/api/v2/organisations/${orgId}/members`, { headers, data: { email: `${who}-${stamp}@example.com`, role } });
      expect(r.status()).toBe(201);
      return new URL((await r.json()).invitation.acceptUrl).searchParams.get('invite')!;
    };
    const adminToken = await invite('admin', 'admin');
    const pilotToken = await invite('pilot', 'pilot');
    const join = async (who: string, name: string, inviteToken: string) => {
      const r = await page.request.post('/api/v2/auth/signup', { data: { email: `${who}-${stamp}@example.com`, password: 'correct-horse-battery', name, inviteToken } });
      expect(r.status()).toBe(201);
      return (await r.json()).csrfToken as string;
    };
    await page.request.post('/api/v2/auth/logout', { headers });
    await page.request.post('/api/v2/auth/logout', { headers: { 'x-csrf-token': await join('pilot', 'Pia Pilot', pilotToken) } });
    await join('admin', 'Adam Admin', adminToken);

    await page.goto('/settings');
    await page.locator('.tabs').getByRole('button', { name: 'Members & roles' }).click();
    const table = page.getByTestId('members-table');
    const ownerRow = table.locator('tbody tr', { hasText: 'Olga Owner' });
    await expect(ownerRow).toContainText('Owner');
    // Shown, not editable: no role choice, licence field or Remove for the owner.
    await expect(ownerRow.locator('select, input, button')).toHaveCount(0);
    // Roles an administrator can give: up to administrator.
    const grantable = ['Administrator', 'Mission manager', 'Pilot / operator', 'Observer'];
    await expect(page.getByLabel('Role', { exact: true }).locator('option')).toHaveText(grantable);
    const pilotRow = table.locator('tbody tr', { hasText: 'Pia Pilot' });
    await expect(pilotRow.getByLabel('Role of Pia Pilot').locator('option')).toHaveText(grantable);
    await expect(pilotRow.getByRole('button', { name: 'Remove' })).toBeVisible();

    // A licence the server does not save is put back, with the reason.
    await page.route('**/api/v2/organisations/*/members/*', (route) =>
      route.request().method() === 'PATCH' ? route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'forbidden', message: 'You cannot modify a member with a higher role' }) }) : route.continue(),
    );
    const licence = pilotRow.getByLabel('Pilot licence of Pia Pilot');
    await licence.fill('UAS-123');
    await licence.blur();
    await expect(page.getByText('You cannot modify a member with a higher role')).toBeVisible();
    await expect(licence).toHaveValue('');
    await page.unroute('**/api/v2/organisations/*/members/*');
    await licence.fill('UAS-123');
    await licence.blur();
    await expect(page.getByText('Licence saved')).toBeVisible();
    await page.reload();
    await page.locator('.tabs').getByRole('button', { name: 'Members & roles' }).click();
    await expect(page.getByTestId('members-table').getByLabel('Pilot licence of Pia Pilot')).toHaveValue('UAS-123');
  });

  test('F8d a GeoJSON import lists every feature it skipped or simplified, and why', async ({ page, consoleErrors }) => {
    void consoleErrors;
    const signup = await page.request.post('/api/v2/auth/signup', { data: { email: `zones-${Date.now()}@example.com`, password: 'correct-horse-battery', name: 'Zed Zones' } });
    expect(signup.status()).toBe(201);
    const point = (i: number) => [DEMO_HOME.lon + i * 0.01, DEMO_HOME.lat - 0.05];
    const features = [
      ...Array.from({ length: 8 }, (_, i) => ({ type: 'Feature', properties: { name: `Mast ${i + 1}` }, geometry: { type: 'Point', coordinates: point(i) } })),
      { type: 'Feature', properties: { name: 'Upside down', radiusM: 100, floor: 120, ceiling: 60 }, geometry: { type: 'Point', coordinates: point(9) } },
      { type: 'Feature', properties: { name: 'Fair', radiusM: 100 }, geometry: { type: 'Point', coordinates: point(10) } },
    ];
    await page.goto('/airspace');
    await page.getByRole('button', { name: 'Airspace zone', exact: true }).click();
    await page.locator('input[type=file][accept=".json,.geojson"]').setInputFiles({ name: 'zones.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify({ type: 'FeatureCollection', features })) });
    const report = page.getByTestId('import-report');
    await expect(report).toContainText('Imported 2 zone(s), skipped 8');
    await expect(report.locator('li')).toHaveCount(9);
    for (let i = 1; i <= 8; i++) await expect(report.locator('li', { hasText: `Skipped Mast ${i}: a Point needs its radius` })).toHaveCount(1);
    await expect(report.locator('li').last()).toHaveText('Upside down: floor 120 m is above the ceiling 60 m – the zone covers 60–120 m');
    await report.getByRole('button', { name: 'Dismiss' }).click();
    await expect(report).toHaveCount(0);
  });

  test('F9i a mission uploaded for later starts from the live console on the ground', async ({ page }) => {
    const signup = await page.request.post('/api/v2/auth/signup', { data: { email: `later-${Date.now()}@example.com`, password: 'correct-horse-battery', name: 'Lea Later' } });
    const { csrfToken, memberships } = await signup.json();
    const orgId = memberships[0].orgId;
    const headers = { 'x-csrf-token': csrfToken };
    const d = await (await page.request.post(`/api/v2/organisations/${orgId}/drones`, { headers, data: { name: 'Later-1', model: 'X4' } })).json();
    const wsBase = String(test.info().project.use.baseURL).replace(/^http/, 'ws');
    const home = destinationPoint(DEMO_HOME, 135, 2500);
    const client = new LinkClient({ url: `${wsBase}/api/v2/link`, key: d.linkKey, drone: new VirtualDrone({ home, groundAltMsl: 10, seed: 77 }), video: false });
    client.start();
    try {
      const plan = { home: { ...home, alt: 0 }, items: [{ type: 'takeoff', alt: 20 }, { type: 'waypoint', ...destinationPoint(home, 0, 200), alt: 20 }, { type: 'rtl' }], rallyPoints: [], defaultSpeed: 8, defaultAlt: 20 };
      const missionId = (await (await page.request.post(`/api/v2/organisations/${orgId}/missions`, { headers, data: { name: 'For later', plan } })).json()).id;
      await expect.poll(async () => (await (await page.request.get(`/api/v2/organisations/${orgId}/drones/${d.id}`)).json()).online, { timeout: 20_000 }).toBe(true);
      expect((await (await page.request.post(`/api/v2/organisations/${orgId}/missions/${missionId}/upload`, { headers, data: { droneId: d.id } })).json()).result).toBe('accepted');
      await page.goto('/');
      await page.evaluate(() => localStorage.setItem('athena.live.view', 'map'));
      await page.goto('/live');
      const tile = page.getByTestId('tile-Later-1');
      await expect(tile).toBeVisible();
      // On the ground the tile offers to start the loaded mission (the details' Resume is for the air).
      const start = tile.getByRole('button', { name: 'Start mission on Later-1' });
      await expect(start).toBeEnabled();
      page.once('dialog', (dialog) => {
        expect(dialog.message()).toBe('Start mission "For later" on Later-1? It arms and takes off.');
        void dialog.accept();
      });
      await start.click();
      await expect.poll(async () => (await (await page.request.get(`/api/v2/organisations/${orgId}/drones/${d.id}`)).json()).inFlight, { timeout: 20_000 }).toBe(true);
      // In the air the same button resumes.
      await expect(tile.getByRole('button', { name: 'Resume Later-1' })).toBeVisible({ timeout: 20_000 });
      await page.request.post(`/api/v2/organisations/${orgId}/drones/${d.id}/commands`, { headers, data: { command: 'land' } });
    } finally {
      await client.stop();
    }
  });
});
