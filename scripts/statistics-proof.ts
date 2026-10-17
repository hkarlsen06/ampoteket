/** Staff statistics over a disposable Convex backend, production pages and trusted HTTPS. */
import { firefox, expect as baseExpect, type BrowserContext } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../convex/_generated/api';
import { fieldLabel, signIn, captureFailure, proofEnvironment } from './web-proof/harness';
import { interceptConvex } from './web-proof/convex-socket';
import { seedDemoData, seedProductId, seedProductCode } from './seed-test-data';
import { en } from '../src/lib/i18n/en';
import { nb } from '../src/lib/i18n/nb';
import { formatDecimal, formatMoney } from '../src/lib/format';
import { errorCode } from '../src/lib/convex';
import type { AdminStatistics } from '../src/lib/admin-statistics';

// Live backend round trips, not animations, set the pace; allow for a busy machine.
const expect = baseExpect.configure({ timeout: 15_000 });
const { directory, origin, convexUrl, serverKey, password, secrets, run, fixtures, createStaff, createUser, startWorker } = await proofEnvironment();
const staffEmail = 'statistics-staff@example.test';
const nonstaffEmail = 'statistics-nonstaff@example.test';
const { authUserId: staffId } = await createStaff(staffEmail, 'Statistics operator');
await createUser(nonstaffEmail);
await seedDemoData(run);
const productId = seedProductId(0);
const wireId = seedProductId(29);
const outOfStockId = seedProductId(10);
const longName = 'Browser statistics resistor with a deliberately long descriptive name that must fit a narrow phone screen';
const longNameNb = 'Motstand for statistikk i nettlesertest med et svært langt beskrivende navn som skal få plass på en smal mobilskjerm';
await fixtures.patch('products', { id: productId }, { name_en: longName, name_nb: longNameNb, sale_unit_price_nok: '999999999998.999999' });
await fixtures.patch('products', { id: outOfStockId }, { name_en: `${longName} out of stock`, name_nb: `${longNameNb} uten beholdning` });
/** A real Convex Auth session, signed in the way the admin login page does it. */
async function signedIn(email: string) {
  const client = new ConvexHttpClient(convexUrl, { logger: false });
  const { token } = await client.action(api.session.signIn, { email, password });
  secrets.push(token);
  client.setAuth(token);
  return client;
}
const statistics = (client: ConvexHttpClient, productId: string | null) => client.query(api.statistics.read, { productId }) as Promise<AdminStatistics>;
async function denied(read: Promise<unknown>) {
  await assert.rejects(read, (error: unknown) => { assert.equal(errorCode(error), 'STAFF_REQUIRED'); return true; });
}
const osloDate = (at: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo' }).format(at);
const daysBefore = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
// Independent of the backend's decimal code: exact cents by BigInt, half up.
const scaled = (value: string) => { const [whole, fraction = ''] = value.split('.'); assert.ok(fraction.length <= 6); return BigInt(whole + fraction.padEnd(6, '0')); };
const cents = (quantity: string, price: string) => (scaled(quantity) * scaled(price) + 5_000_000_000n) / 10_000_000_000n;
const money = (value: bigint) => `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
const staff = await signedIn(staffEmail);
const nonstaff = await signedIn(nonstaffEmail);
const guest = new ConvexHttpClient(convexUrl, { logger: false });
let context: BrowserContext | undefined;
const { ready, close } = await startWorker(() => context);
const artifacts = resolve('test-results/statistics');
await mkdir(artifacts, { recursive: true });
const errors: string[] = [];

try {
  await ready();
  // Statistics require active personal staff access; the guest gateway's key is no identity here.
  for (const client of [guest, nonstaff]) await denied(statistics(client, null));
  context = await firefox.launchPersistentContext(`${directory}/profile`, { headless: true, ignoreHTTPSErrors: false });
  const socket = await interceptConvex(context);
  context.on('page', tab => tab.on('pageerror', error => errors.push(error.message)));
  const page = await context.newPage();
  await signIn(page, origin, nonstaffEmail, password);
  await expect(page.getByText(en.admin.noAccess, { exact: true })).toBeVisible();
  await page.goto(`${origin}/en/admin/statistics`);
  await expect(page.getByText(en.admin.noAccess, { exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: en.adminStatistics.chartTitle })).toHaveCount(0);
  await page.getByRole('button', { name: en.admin.signOut, exact: true }).click();
  // Signing out returns to the login page; typing before it arrives would be reset.
  await expect(page).toHaveURL(/\/en\/admin\/login/);
  await signIn(page, origin, staffEmail, password);
  await expect(page.getByRole('heading', { name: en.admin.overview, exact: true })).toBeVisible();
  await page.goto(`${origin}/en/admin/statistics`);
  await expect(page.getByText(en.adminStatistics.emptySales, { exact: true })).toBeVisible();
  console.log('PASS: real Auth staff-only boundary and honest empty statistics');

  // Real registered snapshots supply mixed units and exact prices. Only their
  // dates are shifted by the disposable fixture owner to exercise the window.
  for (const daysAgo of [0, 1, 7, 29, 30]) {
    const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
    const { checkout_id } = await guest.mutation(api.checkout.prepare, {
      serverKey, requestId: crypto.randomUUID(), token, contact: 'private-statistics-contact@example.test',
      items: [{ productId, quantity: '1' }, { productId: wireId, quantity: '0.1' }]
    });
    const confirmed = await guest.mutation(api.checkout.confirm, { serverKey, checkoutId: checkout_id, token });
    assert.equal(confirmed.status, 'confirmed', 'Register sales through the normal guest checkout');
    if (daysAgo) {
      const [sale] = await fixtures.rows<{ event_id: string }>('sales', { checkout_id });
      // Ten o'clock UTC is late morning in Oslo, summer or winter.
      assert.equal(await fixtures.patch('inventory_events', { id: sale.event_id }, { recorded_at: `${daysBefore(osloDate(Date.now()), daysAgo)}T10:00:00.000000Z` }), 1);
    }
  }
  await guest.mutation(api.checkout.prepare, { serverKey, requestId: crypto.randomUUID(), token: 'b'.repeat(64), contact: null, items: [{ productId, quantity: '1' }] });
  // Current catalog changes must not rewrite frozen sale value.
  await fixtures.patch('products', { id: productId }, { sale_unit_price_nok: '0' });

  const global = await statistics(staff, null);
  const product = await statistics(staff, productId);
  // The expected window, computed from the stored rows rather than the statistics code.
  const today = osloDate(Date.now());
  const period = Array.from({ length: 30 }, (_, index) => daysBefore(today, 29 - index));
  const events = new Map((await fixtures.rows<{ id: string; recorded_at: string }>('inventory_events', { kind: 'sale' })).map(event => [event.id, osloDate(Date.parse(event.recorded_at))]));
  const lines = await fixtures.rows<{ checkout_id: string; quantity: string; unit_price_nok: string }>('checkout_lines');
  const sales = (await fixtures.rows<{ checkout_id: string; event_id: string }>('sales')).map(sale => ({ ...sale, day: events.get(sale.event_id)!,
    cents: lines.filter(line => line.checkout_id === sale.checkout_id).reduce((sum, line) => sum + cents(line.quantity, line.unit_price_nok), 0n) }));
  const summarize = (rows: typeof sales) => ({ sale_count: String(rows.length), total_nok: money(rows.reduce((sum, sale) => sum + sale.cents, 0n)) });
  const expectedDays = period.map(date => ({ date, ...summarize(sales.filter(sale => sale.day === date)), quantity: null }));
  const expected = summarize(sales.filter(sale => period.includes(sale.day)));
  expect(global.days).toEqual(expectedDays);
  expect(global.start_date).toBe(global.days[0].date);
  expect(global.end_date).toBe(global.days.at(-1)!.date);
  expect(global.summary.sale_count).toBe('4');
  expect(global.summary.total_nok).toBe(expected.total_nok);
  expect(global.summary.sale_count).toBe(expected.sale_count);
  expect(global.summary.quantity).toBeNull();
  expect(product.summary.quantity).toBe('4');
  expect(product.summary.total_nok).toBe('3999999999996.00');
  expect(JSON.stringify(global)).not.toContain('private-statistics-contact');

  await page.goto(`${origin}/en/admin/statistics`);
  await expect(page.getByText(formatMoney(global.summary.total_nok, 'en'), { exact: true }).first()).toBeVisible();
  const chart = page.getByRole('img', { name: en.adminStatistics.chartTitle });
  await expect(chart).toBeVisible();
  await expect(chart.locator('.lc-bar')).toHaveCount(30);
  expect(await chart.locator('.lc-bar').evaluateAll(bars => bars.filter(bar => bar.getBoundingClientRect().height > 0).length)).toBe(4);
  await chart.locator('.lc-bar').last().hover({ force: true });
  await expect(page.locator('.lc-tooltip-root')).toContainText(formatMoney(global.days.at(-1)!.total_nok, 'en'));
  await page.mouse.move(0, 0);
  await page.getByRole('button', { name: en.adminStatistics.dailyData, exact: true }).click();
  await expect(page.locator('time[datetime]')).toHaveCount(30);
  for (const day of global.days) {
    const row = page.getByRole('listitem').filter({ has: page.locator(`time[datetime="${day.date}"]`) });
    await expect(row.locator('dd')).toHaveText([formatDecimal(day.sale_count, 'en'), formatMoney(day.total_nok, 'en')]);
  }
  const daily = page.getByRole('button', { name: en.adminStatistics.dailyData, exact: true });
  await daily.focus();
  const readsBefore = socket.queries.length;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => socket.reads('statistics:read', readsBefore)).toBeGreaterThan(0);
  await expect(daily).toHaveAttribute('aria-expanded', 'true');
  await expect(daily).toBeFocused();
  console.log('PASS: registered snapshots, exact rounded values, distinct purchases, mixed units, 30-day window and focus-preserving revalidation');

  socket.fail('statistics:read');
  const failedFrom = socket.queries.length;
  // A read right after another may be answered from the client's cache of the
  // previous result; revalidate until one reaches the backend.
  await expect.poll(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    return socket.reads('statistics:read', failedFrom);
  }).toBeGreaterThan(0);
  await expect(page.getByText(en.adminStatistics.unavailable, { exact: true })).toBeVisible();
  await expect(chart).toBeVisible();
  await expect(daily).toHaveAttribute('aria-expanded', 'true');
  await expect(daily).toBeFocused();
  await expect(page.locator('time[datetime]')).toHaveCount(30);
  await page.goto(`${origin}/en/admin/statistics`);
  await expect(page.getByText(en.adminStatistics.unavailable, { exact: true })).toBeVisible();
  await expect(page.getByText(en.adminStatistics.emptySales, { exact: true })).toHaveCount(0);
  socket.restore('statistics:read');
  await page.getByRole('button', { name: en.adminStatistics.retry, exact: true }).click();
  await expect(page.getByRole('img', { name: en.adminStatistics.chartTitle })).toBeVisible();
  console.log('PASS: failed statistics are unavailable and contextual retry recovers');

  await page.goto(`${origin}/en/admin/products/${wireId}`);
  await page.getByRole('tab', { name: en.adminStatistics.heading, exact: true }).click();
  await expect(page.getByText('0.4 m', { exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: en.adminStatistics.chartTitle })).toHaveAttribute('aria-label', /0\.1 m/);

  let drafted = false; // The product draft survives each later reload.
  for (const locale of ['nb', 'en'] as const) for (const colorScheme of ['light', 'dark'] as const) for (const width of [360, 768, 1280]) {
    const messages = locale === 'nb' ? nb : en;
    const m = messages.adminStatistics;
    const prefix = locale === 'nb' ? '' : '/en';
    const suffix = `${locale}-${colorScheme}-${width}`;
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: 900 });
    for (const path of ['/admin', '/admin/statistics', `/admin/products/${productId}`]) {
      await page.goto(origin + prefix + path);
      if (path === '/admin') {
        await expect(page.getByRole('heading', { name: messages.admin.overview, exact: true })).toBeVisible();
        await expect(page.getByRole('heading', { name: m.attention, exact: true })).toBeVisible();
        await expect(page.getByRole('heading', { name: m.openCounts, exact: true })).toBeVisible();
        await expect(page.getByRole('heading', { name: m.period, exact: true })).toBeVisible();
        await expect(page.getByText(m.saleCount, { exact: true })).toBeVisible();
        await expect(page.getByText(m.value, { exact: true })).toBeVisible();
        await expect(page.getByRole('img', { name: m.chartTitle })).toHaveCount(0);
        await expect(page.getByRole('link', { name: m.allStatistics, exact: true })).toHaveAttribute('href', `${prefix}/admin/statistics`);
        await expect(page.getByRole('link', { name: m.openOrder, exact: true })).toHaveAttribute('href', `${prefix}/admin/orders?new`);
        // Freshly seeded parts are also listed as new products; this link belongs to the attention list.
        await expect(page.getByRole('list', { name: m.attention, exact: true }).getByRole('link', { name: `${locale === 'nb' ? longNameNb : longName} ${locale === 'nb' ? 'uten beholdning' : 'out of stock'}`, exact: false })).toHaveAttribute('href', `${prefix}/admin/products/${outOfStockId}`);
      } else if (path.endsWith(productId)) {
        const name = page.getByLabel(fieldLabel(messages.adminProducts.nameEn));
        await expect(name).toHaveValue(drafted ? `${longName} unsaved` : longName);
        await name.fill(`${longName} unsaved`);
        drafted = true;
        const tab = page.getByRole('tab', { name: m.heading, exact: true });
        const before = await tab.evaluate(el => el.getBoundingClientRect().top + window.scrollY);
        await tab.click();
        await expect(name).toBeHidden();
        expect(await tab.evaluate(el => el.getBoundingClientRect().top + window.scrollY)).toBeCloseTo(before, 1);
        await expect(page.getByText(formatMoney(product.summary.total_nok, locale), { exact: true }).first()).toBeVisible();
      }
      const name = path === '/admin' ? 'overview' : path.endsWith(productId) ? 'product' : 'statistics';
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: `${artifacts}/preview-${name}-${suffix}.png` });
      if (path !== '/admin') {
        await expect(page.getByRole('img', { name: m.chartTitle })).toBeVisible();
        await page.getByRole('img', { name: m.chartTitle }).screenshot({ path: `${artifacts}/chart-${path.endsWith(productId) ? 'product' : 'global'}-${suffix}.png` });
        const daily = page.getByRole('button', { name: m.dailyData, exact: true });
        const before = await daily.evaluate(el => el.getBoundingClientRect().top + window.scrollY);
        await daily.click();
        expect(await daily.evaluate(el => el.getBoundingClientRect().top + window.scrollY)).toBeCloseTo(before, 1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${path} fits ${suffix}`).toBe(true);
      await page.screenshot({ path: `${artifacts}/${name}-${suffix}.png`, fullPage: true });
      if (path.endsWith(productId)) {
        await page.getByRole('tab').first().click();
        await expect(page.getByLabel(fieldLabel(messages.adminProducts.nameEn))).toHaveValue(`${longName} unsaved`);
      }
    }
  }
  console.log('PASS: both locales/themes at 360/768/1280, long names, exact large money, stable disclosures and preserved product drafts');
  const publicReadsFrom = socket.queries.length;
  await page.goto(`${origin}/en/p/${seedProductCode(0)}`);
  await expect(page.getByRole('heading', { name: longName, exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: en.adminStatistics.chartTitle })).toHaveCount(0);
  expect(socket.reads('statistics:read', publicReadsFrom)).toBe(0);
  await fixtures.patch('staff_members', { auth_user_id: staffId }, { is_active: false });
  await denied(statistics(staff, null));
  expect(errors).toEqual([]);
  console.log('PASS: public product privacy and immediate revoked-staff API denial');
} catch (error) {
  for (const [index, page] of (context?.pages() ?? []).entries()) await captureFailure(page, artifacts, String(index));
  throw error;
} finally { await close(); }
