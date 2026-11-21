import { test, expect, login } from './fixtures';
import { destinationPoint, haversineDistance } from '@athena-sky/shared';
import { SimWorld, worldAnchor } from '@athena-sky/simulator';

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
    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page).toHaveURL(/\/login/);
    await login(page, email, 'e2e-password-1');
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

  test('F5 fleet management: live status, software version, register a drone', async ({ page, consoleErrors }) => {
    void consoleErrors;
    await login(page);
    await page.getByRole('link', { name: 'Fleet Management' }).click();
    const table = page.getByTestId('fleet-table');
    await expect(table.getByText('online').first()).toBeVisible();
    await expect(table).toContainText('athena-fc 2.4.0');
    await expect(table).toContainText('Heron-3');
    await page.getByRole('button', { name: '+ Register drone' }).click();
    await page.getByLabel('Name').fill('E2E Hawk');
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await expect(page.getByTestId('link-key')).toHaveText(/^adk_/);
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(table).toContainText('E2E Hawk');
    await page.getByRole('button', { name: 'Software updates' }).click();
    await expect(page.getByText('Upload firmware package')).toBeVisible();
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
    await card.getByRole('button', { name: '▶ Live video' }).click();
    await expect(page.getByTestId('video-Falcon-1').locator('img')).toBeVisible({ timeout: 20_000 });
    await card.getByLabel('Take-off altitude').fill('12');
    await card.getByRole('button', { name: 'Take off' }).click();
    await expect(card.getByText('Pilot in command:')).toContainText('Demo Pilot');
    await expect
      .poll(async () => Number(((await page.getByTestId('alt-Falcon-1').textContent()) ?? '0').replace(/[^\d.]/g, '')), { timeout: 30_000 })
      .toBeGreaterThan(8);
    await expect(card.getByRole('link', { name: '● recording' })).toBeVisible();
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
    await expect.poll(async () => Number(((await page.getByTestId('tile-foot-Falcon-1').textContent()) ?? '').match(/⇡ (\d+) m/)?.[1] ?? 0), { timeout: 30_000 }).toBeGreaterThanOrEqual(28);
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
    // Selecting a drone in the video stack highlights it in the scene and shows its camera frustum.
    await page.getByTestId('tile-Heron-3').click();
    await expect(page.getByTestId('tile-Heron-3')).toHaveClass(/selected/);
    await expect.poll(async () => (await scene()).highlighted).toEqual(['Heron-3']);
    await expect.poll(async () => (await scene()).frustums).toBeGreaterThan(0);
    await page.getByRole('group', { name: 'Live view' }).getByRole('button', { name: '2D map' }).click();
    await expect.poll(() => page.evaluate(() => !!(window as unknown as Win).__athenaLive3D)).toBe(false);
  });

  test('F7 3D mission planning: click to add waypoints, save, export and check airspace', async ({ page, consoleErrors }) => {
    void consoleErrors;
    await login(page);
    await page.getByRole('link', { name: '3D Mission Planning' }).click();
    await page.getByRole('button', { name: '+ New mission' }).click();
    await page.getByLabel('Mission name').fill('E2E corridor');
    await page.getByRole('button', { name: 'Create & open planner' }).click();
    const canvas = page.getByTestId('planner-3d').locator('canvas').first();
    await expect(canvas).toBeVisible({ timeout: 60_000 });
    await page.waitForFunction(() => !!(window as unknown as { __athenaPlanner?: unknown }).__athenaPlanner);
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
    await expect.poll(async () => Number(await selectedAlt.inputValue())).toBeGreaterThanOrEqual(altBefore + 30);
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
      const tip = await page.evaluate(
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
      expect(tip, `tooltip of ${reference}`).not.toBeNull();
      expect(tip!.text).toContain(evil);
      expect(tip!.elements).toBe(0);
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
    const swagger = await page.request.get('/api/v2/docs/');
    expect(swagger.status()).toBe(200);
    const schema = await page.request.get('/api/v2/schema/');
    expect(Object.keys((await schema.json()).paths).length).toBeGreaterThan(60);
  });

  test('F11 drone swarm: formation preview, synchronised take-off, notifications and a common return', async ({ page, consoleErrors }) => {
    void consoleErrors;
    test.setTimeout(240_000);
    await login(page);
    await page.getByRole('link', { name: 'Real-Time Flights' }).click();
    await expect(page.getByTestId('video-stack').locator('.vtile')).toHaveCount(3);
    await page.getByRole('button', { name: /⬡ Swarm/ }).click();
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
    // The take-off barrier: drones wait for the highest one, then all pass it.
    await expect(page.getByTestId('swarm-operation')).toContainText('waiting', { timeout: 60_000 });
    for (const name of ['Falcon-1', 'Falcon-2', 'Heron-3']) await expect(page.getByTestId(`swarm-member-${name}`)).toContainText(/⧗ [1-9]\//, { timeout: 60_000 });
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

  test('F13 AI vision: detect people and vehicles in the live video, recognise and follow a person', async ({ page, consoleErrors }) => {
    void consoleErrors;
    test.setTimeout(240_000);
    await login(page);
    await page.getByRole('link', { name: 'Real-Time Flights' }).click();
    const tile = page.getByTestId('tile-Falcon-2');
    await expect(tile.getByText('Disarmed', { exact: true })).toBeVisible({ timeout: 60_000 });
    await tile.getByRole('button', { name: 'Take off Falcon-2' }).click();
    const alt = async () => Number(((await page.getByTestId('tile-foot-Falcon-2').textContent()) ?? '').match(/⇡ (\d+) m/)?.[1] ?? 0);
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
    await expect(page.getByTestId('tile-ai-Falcon-2')).toContainText(/[↪⌕] #\d+/);
    await expect(page.getByTestId('console-log')).toContainText('Follow-me: following person');
    await page.waitForTimeout(6000);
    await bar.getByRole('button', { name: 'Stop following' }).click();
    await expect(page.getByTestId('tile-ai-Falcon-2')).toContainText(/^AI \d+$/);
    await tile.getByRole('button', { name: 'AI detection Falcon-2' }).click();
    await expect(page.getByTestId('tile-ai-Falcon-2')).toHaveCount(0);
    await tile.getByRole('button', { name: 'Land Falcon-2' }).click();
  });
});
