/** Staff statistics over real disposable Auth/PostgREST, production pages and trusted HTTPS. */
import { firefox, expect, type BrowserContext } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fieldLabel, signIn, captureFailure, proofEnvironment } from './web-proof/harness';
import { generateSeedSql, seedProductId, seedProductCode } from './seed-test-data';
import { en } from '../src/lib/i18n/en';
import { nb } from '../src/lib/i18n/nb';
import { formatDecimal, formatMoney } from '../src/lib/format';
import type { AdminStatistics } from '../src/lib/admin-statistics';

const { directory, origin, api, publicKey, anonKey, serviceKey, password, secrets, sql, createUser, startWorker } = await proofEnvironment();
const staffEmail = 'statistics-staff@example.test';
const nonstaffEmail = 'statistics-nonstaff@example.test';
const staffId = await createUser(staffEmail);
await createUser(nonstaffEmail);
await sql(`INSERT INTO app.staff_members(auth_user_id,display_name) VALUES ('${staffId}', 'Statistics operator');`);
await sql("SET ampoteket.test_seed = 'disposable-only';\n" + generateSeedSql());
const productId = seedProductId(0);
const wireId = seedProductId(29);
const outOfStockId = seedProductId(10);
const longName = 'Browser statistics resistor with a deliberately long descriptive name that must fit a narrow phone screen';
const longNameNb = 'Motstand for statistikk i nettlesertest med et svært langt beskrivende navn som skal få plass på en smal mobilskjerm';
const longBatch = 'Stock count with a deliberately long descriptive title for a narrow phone screen';
await sql(`UPDATE app.products SET name_en='${longName}', name_nb='${longNameNb}', sale_unit_price_nok=999999999998.999999 WHERE id='${productId}';
  UPDATE app.products SET name_en='${longName} out of stock', name_nb='${longNameNb} uten beholdning' WHERE id='${outOfStockId}';`);
async function authToken(email: string) {
  const response = await fetch(`${api.origin}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: publicKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password })
  });
  assert.ok(response.ok, 'Disposable Supabase Auth issues a real session');
  const { access_token } = await response.json() as { access_token: string };
  secrets.push(access_token);
  return access_token;
}
async function rpc(name: string, body: unknown, token = serviceKey) {
  return fetch(`${api.origin}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { apikey: publicKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
}
const staffToken = await authToken(staffEmail);
const nonstaffToken = await authToken(nonstaffEmail);
let context: BrowserContext | undefined;
const { ready, close } = await startWorker(() => context);
const artifacts = resolve('test-results/statistics');
await mkdir(artifacts, { recursive: true });
const endpoint = `${api.origin}/rest/v1/rpc/amp_admin_statistics*`;
const errors: string[] = [];

try {
  await ready();
  for (const token of [anonKey, nonstaffToken, serviceKey]) {
    const response = await rpc('amp_admin_statistics', { p_product_id: null }, token);
    expect(response.ok, 'Statistics require active personal staff access').toBe(false);
    expect([401, 403]).toContain(response.status);
    await response.body?.cancel();
  }
  context = await firefox.launchPersistentContext(`${directory}/profile`, { headless: true, ignoreHTTPSErrors: false });
  context.on('page', tab => tab.on('pageerror', error => errors.push(error.message)));
  const page = await context.newPage();
  await signIn(page, origin, nonstaffEmail, password);
  await expect(page.getByText(en.admin.noAccess, { exact: true })).toBeVisible();
  await page.goto(`${origin}/en/admin/statistics`);
  await expect(page.getByText(en.admin.noAccess, { exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: en.adminStatistics.chartTitle })).toHaveCount(0);
  await page.getByRole('button', { name: en.admin.signOut, exact: true }).click();
  await signIn(page, origin, staffEmail, password);
  await expect(page.getByRole('heading', { name: en.admin.overview, exact: true })).toBeVisible();
  await page.goto(`${origin}/en/admin/statistics`);
  await expect(page.getByText(en.adminStatistics.emptySales, { exact: true })).toBeVisible();
  console.log('PASS: real Auth staff-only boundary and honest empty statistics');

  // Real registered snapshots supply mixed units and exact prices. Only their
  // dates are shifted by the disposable fixture owner to exercise the window.
  for (const daysAgo of [0, 1, 7, 29, 30]) {
    const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
    const prepared = await rpc('amp_prepare_checkout', {
      p_request_id: crypto.randomUUID(), p_token: token,
      p_items: [{ product_id: productId, quantity: '1' }, { product_id: wireId, quantity: '0.1' }],
      p_contact_text: 'private-statistics-contact@example.test'
    });
    assert.ok(prepared.ok, 'Prepare registered-sales fixture');
    const { checkout_id } = await prepared.json() as { checkout_id: string };
    const confirmed = await rpc('amp_confirm_checkout', { p_checkout_id: checkout_id, p_token: token });
    assert.ok(confirmed.ok, 'Register sales through the normal audited RPC');
    await confirmed.body?.cancel();
    if (daysAgo) await sql(`BEGIN; SET LOCAL session_replication_role=replica;
      UPDATE app.inventory_events SET recorded_at=(((now() AT TIME ZONE 'Europe/Oslo')::date-${daysAgo})+time '12:00') AT TIME ZONE 'Europe/Oslo'
      WHERE id=(SELECT event_id FROM app.sales WHERE checkout_id='${checkout_id}'); COMMIT;`);
  }
  const preparedOnly = await rpc('amp_prepare_checkout', {
    p_request_id: crypto.randomUUID(), p_token: 'b'.repeat(64), p_items: [{ product_id: productId, quantity: '1' }]
  });
  assert.ok(preparedOnly.ok); await preparedOnly.body?.cancel();
  const started = await rpc('amp_start_count_batch', { p_request_id: crypto.randomUUID(), p_title: longBatch }, staffToken);
  assert.ok(started.ok);
  const { batch_id } = await started.json() as { batch_id: string };
  // Current catalog changes must not rewrite frozen sale value.
  await sql(`UPDATE app.products SET sale_unit_price_nok=0 WHERE id='${productId}'`);

  const globalResponse = await rpc('amp_admin_statistics', { p_product_id: null }, staffToken);
  assert.ok(globalResponse.ok);
  const global = await globalResponse.json() as AdminStatistics;
  const productResponse = await rpc('amp_admin_statistics', { p_product_id: productId }, staffToken);
  assert.ok(productResponse.ok);
  const product = await productResponse.json() as AdminStatistics;
  const expected = JSON.parse(await sql(`SELECT jsonb_build_object('sale_count',count(DISTINCT s.checkout_id)::text,
    'total_nok',sum(round(l.quantity*l.unit_price_nok,2))::text)
    FROM app.sales s JOIN app.inventory_events e ON e.id=s.event_id JOIN app.checkout_lines l ON l.checkout_id=s.checkout_id
    WHERE (e.recorded_at AT TIME ZONE 'Europe/Oslo')::date BETWEEN (now() AT TIME ZONE 'Europe/Oslo')::date-29 AND (now() AT TIME ZONE 'Europe/Oslo')::date`));
  const expectedDays = JSON.parse(await sql(`SELECT jsonb_agg(jsonb_build_object(
    'date',d::date,'sale_count',(SELECT count(DISTINCT s.checkout_id)::text FROM app.sales s JOIN app.inventory_events e ON e.id=s.event_id WHERE (e.recorded_at AT TIME ZONE 'Europe/Oslo')::date=d::date),
    'total_nok',(SELECT coalesce(sum(round(l.quantity*l.unit_price_nok,2)),0.00)::text FROM app.sales s JOIN app.inventory_events e ON e.id=s.event_id JOIN app.checkout_lines l ON l.checkout_id=s.checkout_id WHERE (e.recorded_at AT TIME ZONE 'Europe/Oslo')::date=d::date),
    'quantity',NULL) ORDER BY d)
    FROM generate_series((now() AT TIME ZONE 'Europe/Oslo')::date-29,(now() AT TIME ZONE 'Europe/Oslo')::date,interval '1 day') d`));
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
  const refreshed = page.waitForResponse(response => response.url().includes('/rpc/amp_admin_statistics') && response.ok());
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await refreshed;
  await expect(daily).toHaveAttribute('aria-expanded', 'true');
  await expect(daily).toBeFocused();
  console.log('PASS: registered snapshots, exact rounded values, distinct purchases, mixed units, 30-day window and focus-preserving revalidation');

  await page.route(endpoint, route => route.abort('failed'));
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByText(en.adminStatistics.unavailable, { exact: true })).toBeVisible();
  await expect(chart).toBeVisible();
  await expect(daily).toHaveAttribute('aria-expanded', 'true');
  await expect(daily).toBeFocused();
  await expect(page.locator('time[datetime]')).toHaveCount(30);
  await page.goto(`${origin}/en/admin/statistics`);
  await expect(page.getByText(en.adminStatistics.unavailable, { exact: true })).toBeVisible();
  await expect(page.getByText(en.adminStatistics.emptySales, { exact: true })).toHaveCount(0);
  await page.unroute(endpoint);
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
        await expect(page.getByRole('link', { name: longBatch, exact: true })).toHaveAttribute('href', `${prefix}/admin/counts/${batch_id}`);
        await expect(page.getByRole('link', { name: `${locale === 'nb' ? longNameNb : longName} ${locale === 'nb' ? 'uten beholdning' : 'out of stock'}`, exact: false })).toHaveAttribute('href', `${prefix}/admin/products/${outOfStockId}`);
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
  let publicStatisticsReads = 0;
  page.on('request', request => { if (request.url().includes('/rpc/amp_admin_statistics')) publicStatisticsReads++; });
  await page.goto(`${origin}/en/p/${seedProductCode(0)}`);
  await expect(page.getByRole('heading', { name: longName, exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: en.adminStatistics.chartTitle })).toHaveCount(0);
  expect(publicStatisticsReads).toBe(0);
  await sql(`UPDATE app.staff_members SET is_active=false WHERE auth_user_id='${staffId}'`);
  const revoked = await rpc('amp_admin_statistics', { p_product_id: null }, staffToken);
  expect(revoked.status).toBe(403); await revoked.body?.cancel();
  expect(errors).toEqual([]);
  console.log('PASS: public product privacy and immediate revoked-staff API denial');
} catch (error) {
  for (const [index, page] of (context?.pages() ?? []).entries()) await captureFailure(page, artifacts, String(index));
  throw error;
} finally { await close(); }
