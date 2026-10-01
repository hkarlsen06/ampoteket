/** Actual pages and gateway, disposable PostgreSQL/Auth, trusted HTTPS and real browser storage. */
import { firefox, expect, type BrowserContext } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fieldLabel, signIn, fits, captureFailure, proofEnvironment } from './web-proof/harness';
import { generateSeedSql, seedProductId, seedProductCode, seedBinId } from './seed-test-data';
import { en } from '../src/lib/i18n/en';
import { nb } from '../src/lib/i18n/nb';

const { directory, origin, api, password, ca, sql, createUser, startWorker } = await proofEnvironment();
const staffEmail = 'labels-staff@example.test';
const nonstaffEmail = 'labels-nonstaff@example.test';
const staffId = await createUser(staffEmail);
await createUser(nonstaffEmail);
await sql(`INSERT INTO app.staff_members(auth_user_id,display_name) VALUES ('${staffId}', 'Browser operator');`);
let context: BrowserContext | undefined;
const { ready, close } = await startWorker(() => context);
const artifacts = resolve('test-results/labels');
await mkdir(artifacts, { recursive: true });


async function verifyBootAssets() {
  const response = await fetch(`${origin}/en/admin/login`, { tls: { ca } });
  assert.ok(response.ok);
  const html = await response.text();
  const paths = [...new Set(html.match(/_app\/immutable\/[^"'\s<>)]*\.(?:js|css)/g) ?? [])];
  assert.ok(paths.some(path => path.endsWith('.js')) && paths.some(path => path.endsWith('.css')), 'SSR provides production JavaScript and CSS');
  await Promise.all(paths.map(async path => {
    const asset = await fetch(`${origin}/${path}`, { tls: { ca } });
    assert.ok(asset.ok, `Production bootstrap asset is available: ${path} (${asset.status})`);
    assert.match(asset.headers.get('Content-Type') ?? '', path.endsWith('.css') ? /text\/css/ : /javascript/);
  }));
}

const diagnostics: string[] = [];
async function snapshot() {
  const tables = (await sql("SELECT tablename FROM pg_tables WHERE schemaname='app' ORDER BY tablename")).split('\n');
  return await sql(tables.map(name => `SELECT '${name}:' || md5(coalesce(string_agg(value::text, E'\\n' ORDER BY value::text), '')) FROM (SELECT to_jsonb(t) AS value FROM app.${name} t) rows;`).join('\n'));
}
async function inspectPdf(path: string, expectedCodes: string[], width: number, margin: number, gap: number) {
  const python = Bun.spawn(['python3', '-c', `
import pymupdf, json, pathlib, sys
source, output = sys.argv[1:]
doc = pymupdf.open(source)
result = []
for index, page in enumerate(doc):
    pixmap = page.get_pixmap(matrix=pymupdf.Matrix(3,3), alpha=False)
    png = str(pathlib.Path(output) / ('pdf-page-' + str(index + 1) + '.png'))
    pixmap.save(png)
    drawings = page.get_drawings()
    guides = [list(drawing['rect']) for drawing in drawings if drawing['type']=='s' and drawing['dashes'] != '[] 0']
    result.append({'width':page.rect.width,'height':page.rect.height,'png':png,'drawings':len(drawings),'guides':guides})
print(json.dumps(result))
`, path, artifacts], { stdout: 'pipe', stderr: 'pipe' });
  const [code, output, error] = await Promise.all([python.exited, new Response(python.stdout).text(), new Response(python.stderr).text()]);
  assert.equal(code, 0, `PyMuPDF validates the downloaded file: ${error}`);
  const pages = JSON.parse(output) as { width: number; height: number; png: string; drawings: number; guides: number[][] }[];
  const horizontal = pages[0].guides.filter(guide => Math.abs(guide[3] - guide[1]) < 0.01);
  const firstRows = horizontal.length - 1;
  const verticalExtent = Math.max(...horizontal.map(guide => guide[1])) - Math.min(...horizontal.map(guide => guide[1]));
  const height = (verticalExtent * 25.4 / 72 - (firstRows - 1) * gap) / firstRows;
  const columns = Math.floor((210 - 2 * margin + gap) / (width + gap));
  const rows = Math.floor((297 - 2 * margin + gap) / (height + gap));
  expect(pages).toHaveLength(Math.ceil(expectedCodes.length / (rows * columns)));
  const { prepareZXingModule, readBarcodes } = await import('zxing-wasm/reader');
  prepareZXingModule({ overrides: { wasmBinary: await Bun.file('node_modules/zxing-wasm/dist/reader/zxing_reader.wasm').arrayBuffer() } });
  const decoded: string[] = [];
  for (const [pageIndex, page] of pages.entries()) {
    const count = Math.min(columns * rows, expectedCodes.length - pageIndex * columns * rows);
    const usedColumns = Math.min(columns, count), usedRows = Math.ceil(count / columns);
    const vertical = page.guides.filter(guide => Math.abs(guide[2] - guide[0]) < 0.01);
    const horizontal = page.guides.filter(guide => Math.abs(guide[3] - guide[1]) < 0.01);
    expect(vertical).toHaveLength(usedColumns + 1);
    expect(horizontal).toHaveLength(usedRows + 1);
    for (const [index, guide] of vertical.entries()) {
      const x = index === 0 ? margin : index === usedColumns ? margin + usedColumns * width + (usedColumns - 1) * gap : margin + index * (width + gap) - gap / 2;
      expect(guide[0] * 25.4 / 72).toBeCloseTo(x, 2);
    }
    for (const [index, guide] of horizontal.entries()) {
      const y = index === 0 ? margin : index === usedRows ? margin + usedRows * height + (usedRows - 1) * gap : margin + index * (height + gap) - gap / 2;
      expect(guide[1] * 25.4 / 72).toBeCloseTo(y, 2);
    }
    expect(page.width * 25.4 / 72).toBeCloseTo(210, 2);
    expect(page.height * 25.4 / 72).toBeCloseTo(297, 2);
    expect(page.drawings).toBeGreaterThan(0);
    const symbols = await readBarcodes(await Bun.file(page.png).bytes(), { formats: ['QRCode'], tryHarder: true, maxNumberOfSymbols: 255 });
    decoded.push(...symbols.map(symbol => symbol.text));
  }
  expect(decoded.sort()).toEqual(expectedCodes.map(code => `ampoteket.no/p/${code}`).sort());
  console.log(`PASS: downloaded ${pages.length}-page A4 PDF contains exactly ${decoded.length} independently decoded product QR addresses`);
}

// Everything is synthetic and belongs to this test's disposable project.
await sql("SET ampoteket.test_seed = 'disposable-only';\n" + generateSeedSql());
await sql(`
UPDATE app.products SET bin_id='${seedBinId(0)}' WHERE id IN ('${seedProductId(0)}','${seedProductId(1)}','${seedProductId(2)}');
UPDATE app.products SET is_active=false WHERE id='${seedProductId(2)}';
UPDATE app.products SET is_active=false,bin_id=NULL WHERE id='${seedProductId(29)}';
UPDATE app.products SET bin_id=(SELECT b.id FROM app.bins b JOIN app.cabinets c ON c.id=b.cabinet_id WHERE c.outer_row=1 AND c.outer_col=2 ORDER BY b.inner_row,b.inner_col LIMIT 1) WHERE id='${seedProductId(28)}';
UPDATE app.product_attributes SET text_value=repeat('Very long specification ', 80) WHERE product_id='${seedProductId(0)}' AND attribute_id=(SELECT id FROM app.attribute_definitions WHERE code='package');
UPDATE app.products SET name_nb='Langt norsk produktnavn med æ, ø og å for kontroll på en smal mobilskjerm',name_en='Deliberately long component name for the narrowest supported phone screen' WHERE id='${seedProductId(0)}';
`);
// Resolve the actual production chunks containing writer/font delivery so the
// lazy-load check verifies JavaScript too, not merely absence of asset requests.
const exportChunks = new Set<string>();
for await (const filename of new Bun.Glob('**/*.js').scan(`${directory}/site/cloudflare/_app/immutable`)) {
  const source = await Bun.file(`${directory}/site/cloudflare/_app/immutable/${filename}`).text();
  if (source.includes('zxing_writer') || source.includes('Lato-Regular')) exportChunks.add(`/_app/immutable/${filename}`);
}
assert.ok(exportChunks.size, 'The production build contains identifiable lazy label-export chunks');
const fixtureState = await snapshot();
const writes: string[] = [];
const requests: string[] = [];
try {
  await ready();
  await verifyBootAssets();
  context = await firefox.launchPersistentContext(`${directory}/profile`, { headless: true, ignoreHTTPSErrors: false, acceptDownloads: true });
  context.on('page', tab => {
    tab.on('pageerror', error => diagnostics.push(error.message));
    tab.on('response', response => {
      const url = new URL(response.url());
      if (url.origin === origin && url.pathname.startsWith('/_app/immutable/') && /\.(css|js)$/.test(url.pathname) && !response.ok()) diagnostics.push(`Static asset ${response.status}: ${url.pathname}`);
    });
    tab.on('request', request => {
      requests.push(request.url());
      const path = new URL(request.url()).pathname;
      // Read-only RPCs use POST transport.
      const rpcRead = request.method() === 'POST' && ['/rest/v1/rpc/amp_shelf_map', '/rest/v1/rpc/amp_admin_statistics'].includes(path);
      if (request.url().startsWith(`${api.origin}/rest/v1/`) && !['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && !rpcRead) writes.push(`${request.method()} ${path}`);
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  await signIn(page, origin, nonstaffEmail, password);
  await expect(page.getByText(en.admin.noAccess, { exact: false })).toBeVisible();
  await page.goto(`${origin}/en/admin/products/labels`);
  await expect(page.getByRole('button', { name: 'Create labels', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await signIn(page, origin, staffEmail, password);
  await expect(page.getByRole('heading', { name: en.admin.overview, exact: true })).toBeVisible();

  const m = en.adminLabels;
  const productsPattern = `${api.origin}/rest/v1/amp_products*`;
  let refused = 0;
  await page.route(productsPattern, async route => { refused++; await route.abort('failed'); });
  await page.goto(`${origin}/en/admin/products/labels`);
  await expect(page.getByRole('button', { name: m.retry, exact: true })).toBeVisible();
  expect(refused).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: m.generate, exact: true, disabled: false })).toHaveCount(0);
  await page.unroute(productsPattern);
  await page.getByRole('button', { name: m.retry, exact: true }).click();
  const wall = page.getByRole('group', { name: m.wall, exact: true });
  await expect(wall).toBeVisible();
  expect(requests.filter(url => /\.wasm(?:\?|$)|Lato-Regular/.test(url) || exportChunks.has(new URL(url).pathname))).toEqual([]);

  // A failure after one successful page must never look like a complete result.
  let partialRead = 0;
  await page.route(productsPattern, async route => {
    partialRead++;
    if (new URL(route.request().url()).searchParams.has('and')) await route.abort('failed');
    else await route.continue();
  });
  await page.reload();
  await expect(page.getByRole('button', { name: m.retry, exact: true })).toBeVisible();
  expect(partialRead).toBeGreaterThan(1);
  await expect(page.getByRole('button', { name: m.generate, exact: true, disabled: false })).toHaveCount(0);
  await page.unroute(productsPattern);
  await page.getByRole('button', { name: m.retry, exact: true }).click();
  await expect(wall).toBeVisible();
  console.log('PASS: real non-staff denial, initial/partial read failures and complete traversal under a two-row cap');

  const clear = page.getByRole('button', { name: m.clearSelection, exact: true });
  const selectAll = page.getByRole('button', { name: m.selectAll, exact: true });
  await wall.getByRole('checkbox', { name: m.selectCabinet('A1'), exact: true }).click();
  await expect(wall.getByRole('checkbox', { name: m.selectCabinet('A1'), exact: true })).toBeChecked();
  await expect(page.getByText(m.selectedDrawers(48), { exact: true })).toBeVisible();
  await wall.getByRole('checkbox', { name: m.selectCabinet('C1'), exact: true }).click({ modifiers: ['Shift'] });
  await expect(page.getByText(m.selectedDrawers(144), { exact: true })).toBeVisible();
  await expect(wall.getByRole('checkbox', { name: m.selectCabinet('B1'), exact: true })).toBeChecked();
  await clear.click();
  await expect(page.getByText(m.selectedDrawers(0), { exact: true })).toBeVisible();
  // The component checkbox shares the same parent selection state for keys and clicks.
  await wall.getByRole('checkbox', { name: m.selectCabinet('A1'), exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(page.getByText(m.selectedDrawers(48), { exact: true })).toBeVisible();
  await wall.getByRole('checkbox', { name: m.selectCabinet('C1'), exact: true }).focus();
  await page.keyboard.press('Shift+Space');
  await expect(page.getByText(m.selectedDrawers(144), { exact: true })).toBeVisible();
  await clear.click();
  await wall.getByRole('button', { name: m.cabinet('A1'), exact: true }).click();
  const drawers = page.getByRole('group', { name: m.cabinet('A1'), exact: true });
  await drawers.getByRole('button', { name: 'A1', exact: true }).click();
  await page.getByRole('button', { name: en.shelfMap.showWall, exact: true }).click();
  await expect(wall.getByRole('checkbox', { name: m.selectCabinet('A1'), exact: true })).toBeChecked({ indeterminate: true });
  await expect(wall.getByRole('button', { name: m.cabinet('A1'), exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await drawers.getByRole('button', { name: 'D1', exact: true }).click({ modifiers: ['Shift'] });
  await expect(page.getByText(m.selectedDrawers(4), { exact: true })).toBeVisible();
  await expect(drawers.getByRole('button', { name: `B1 · ${m.emptyDrawer}`, exact: true })).toHaveAttribute('aria-pressed', 'true');
  // Modifier-aware keyboard selection uses the same inclusive visual range.
  await clear.click();
  await drawers.getByRole('button', { name: 'A1', exact: true }).focus();
  await page.keyboard.press('Space');
  await drawers.getByRole('button', { name: 'D1', exact: true }).focus();
  await page.keyboard.press('Shift+Space');
  await expect(page.getByText(m.selectedDrawers(4), { exact: true })).toBeVisible();
  await clear.click();
  await drawers.getByRole('button', { name: `A12 · ${m.emptyDrawer}`, exact: true }).click();
  await expect(page.getByText(m.selectedDrawers(1), { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: m.generate, exact: true })).toBeDisabled();
  await selectAll.click();
  await expect(page.getByText(m.selectedDrawers(492), { exact: true })).toBeVisible();
  console.log('PASS: whole cabinets, inclusive Shift mouse/keyboard ranges, drawer drill-down, partial states and empty drawers');
  await expect(page.getByLabel(fieldLabel(m.includeUnplaced))).toBeChecked();
  await expect(page.getByText(m.summary(30, 2), { exact: true })).toBeVisible();
  await page.getByLabel(fieldLabel(`${m.width} (mm)`)).fill('45');
  const widthControl = page.getByLabel(fieldLabel(`${m.width} (mm)`));
  await widthControl.focus();
  await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  const focused = await widthControl.evaluate(element => element === document.activeElement && element.matches(':focus-visible') && parseFloat(getComputedStyle(element.closest('[data-slot="input-group"]') ?? element).outlineWidth) >= 2);
  expect(focused).toBe(true);
  const resumed = page.waitForResponse(response => response.url().startsWith(`${api.origin}/rest/v1/amp_products?`) && response.ok());
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await resumed;
  await expect(page.getByText(m.summary(30, 2), { exact: true })).toBeVisible();
  await expect(widthControl).toBeFocused();
  await page.getByLabel(fieldLabel(m.includeUnplaced)).uncheck();
  await expect(page.getByText(m.summary(29, 1), { exact: true })).toBeVisible();
  expect(requests.filter(url => /\.wasm(?:\?|$)|Lato-Regular/.test(url) || exportChunks.has(new URL(url).pathname))).toEqual([]);
  await page.getByRole('button', { name: m.generate, exact: true }).click();
  const download = page.getByRole('link', { name: m.download, exact: true });
  await expect(download).toBeVisible();
  await expect(page.getByText(m.ready(29, 2, 4, 5), { exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: new RegExp(`^${m.previewAlt('', '')}`) })).toHaveCount(29);
  const downloaded = page.waitForEvent('download');
  await download.click();
  const file = await downloaded;
  const pdfPath = `${artifacts}/labels-assigned.pdf`;
  await file.saveAs(pdfPath);
  const assignedCodes = (await sql('SELECT code FROM app.products WHERE bin_id IS NOT NULL ORDER BY code')).split('\n');
  await inspectPdf(pdfPath, assignedCodes, 45, 10, 2);
  expect(requests.filter(url => url.endsWith('.wasm')).every(url => new URL(url).origin === origin)).toBe(true);
  expect(requests.some(url => url.endsWith('.wasm'))).toBe(true);
  console.log('PASS: no font/WASM fetch before generation, warm read preserves selection/input/focus, inactive parts included and stock never becomes copies');

  await page.getByLabel(fieldLabel(m.includeUnplaced)).check();
  await expect(download).toHaveCount(0);
  await page.getByRole('button', { name: m.generate, exact: true }).click();
  await expect(page.getByText(m.ready(30, 2, 4, 5), { exact: true })).toBeVisible();
  const allDownload = page.waitForEvent('download');
  await download.click();
  await (await allDownload).saveAs(`${artifacts}/labels-all.pdf`);
  await inspectPdf(`${artifacts}/labels-all.pdf`, (await sql('SELECT code FROM app.products ORDER BY code')).split('\n'), 45, 10, 2);
  console.log('PASS: Select all also includes the unplaced component, producing all 30 labels');

  // Changing selection or dimensions invalidates the earlier downloadable file.
  await page.getByLabel(fieldLabel(`${m.width} (mm)`)).fill('20');
  await expect(download).toHaveCount(0);
  await page.getByRole('button', { name: m.generate, exact: true }).click();
  // Decimal text input: out-of-range widths are refused with a field error and focus.
  await expect(widthControl).toHaveAttribute('aria-invalid', 'true');
  await expect(widthControl).toBeFocused();
  await expect(page.getByText(m.widthInvalid, { exact: true })).toBeVisible();
  await expect(download).toHaveCount(0);
  await page.getByLabel(fieldLabel(`${m.width} (mm)`)).fill('45');
  await clear.click();
  await drawers.getByRole('button', { name: 'A1', exact: true }).click();
  await expect(page.getByText(m.summary(3, 1), { exact: true })).toBeVisible();
  await page.getByRole('button', { name: m.generate, exact: true }).click();
  await expect(download).toBeVisible();
  await expect(page.getByText(m.summary(3, 1), { exact: true })).toBeVisible();
  await page.getByRole('button', { name: m.generate, exact: true }).click();
  await expect(page.getByText(m.ready(3, 1, 4, 5), { exact: true })).toBeVisible();
  const repeatedDownload = page.waitForEvent('download');
  await download.click();
  await (await repeatedDownload).saveAs(`${artifacts}/labels-drawer-copies.pdf`);
  await inspectPdf(`${artifacts}/labels-drawer-copies.pdf`, [0, 1, 2].map(index => seedProductCode(index)), 45, 10, 2);
  console.log('PASS: invalid dimensions prevent downloads; one drawer produces exactly one label for each of its three components');


  async function duringAssetLoad() {
    const pending = await context!.newPage();
    pending.setDefaultTimeout(30000);
    await pending.addInitScript(() => {
      const original = window.fetch;
      const aborted: string[] = [];
      Object.defineProperty(window, 'labelAssetAborts', { value: aborted });
      Object.defineProperty(window, 'fetch', { value: function (input: RequestInfo | URL, init?: RequestInit) {
        const url = input instanceof Request ? input.url : String(input);
        if (/Lato-Regular|zxing_writer.*\.wasm/.test(url)) init?.signal?.addEventListener('abort', () => aborted.push(url), { once: true });
        return original.call(window, input, init);
      } });
    });
    await pending.goto(`${origin}/en/admin/products/labels`);
    await expect(pending.getByRole('group', { name: m.wall, exact: true })).toBeVisible();
    await pending.getByRole('button', { name: m.selectAll, exact: true }).click();
    const pattern = /Lato-Regular|zxing_writer.*\.wasm/;
    let held = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await pending.route(pattern, async route => { held++; await gate; await route.continue().catch(() => {}); });
    await pending.getByRole('button', { name: m.generate, exact: true }).click();
    await expect.poll(() => held, { timeout: 30000 }).toBe(2);
    return { pending, async resume() { release(); await pending.unrouteAll({ behavior: 'wait' }); } };
  }
  const cancellation = await duringAssetLoad();
  await cancellation.pending.getByRole('button', { name: m.cancel, exact: true }).click();
  await expect(cancellation.pending.getByRole('button', { name: m.generate, exact: true })).toBeEnabled();
  expect(await cancellation.pending.evaluate(() => (Reflect.get(window, 'labelAssetAborts') as string[]).length)).toBe(2);
  await expect(cancellation.pending.getByRole('link', { name: m.download, exact: true })).toHaveCount(0);
  await cancellation.resume();
  await cancellation.pending.getByRole('button', { name: m.generate, exact: true }).click();
  await expect(cancellation.pending.getByRole('link', { name: m.download, exact: true })).toBeVisible();
  await cancellation.pending.close();

  const language = await duringAssetLoad();
  // The language picker lives in the header menu at every width.
  await language.pending.locator('.menu-toggle').click();
  await language.pending.locator('#site-menu').getByRole('link', { name: nb.locale.name, exact: true }).click();
  await expect(language.pending).toHaveURL(`${origin}/admin/products/labels`);
  await expect(language.pending.getByRole('button', { name: nb.adminLabels.generate, exact: true })).toBeEnabled();
  expect(await language.pending.evaluate(() => (Reflect.get(window, 'labelAssetAborts') as string[]).length)).toBe(2);
  await language.resume();
  await expect(language.pending.getByRole('link', { name: nb.adminLabels.download, exact: true })).toHaveCount(0);
  await language.pending.getByRole('button', { name: nb.adminLabels.generate, exact: true }).click();
  await expect(language.pending.getByRole('link', { name: nb.adminLabels.download, exact: true })).toBeVisible();
  await expect(language.pending.getByRole('img', { name: new RegExp(`^${nb.adminLabels.previewAlt('', '')}`) }).first()).toBeVisible();
  await language.pending.close();

  const navigation = await duringAssetLoad();
  await navigation.pending.getByRole('navigation', { name: en.admin.navigation }).getByRole('link', { name: en.adminProducts.heading, exact: true }).click();
  await expect(navigation.pending).toHaveURL(`${origin}/en/admin/products`);
  expect(await navigation.pending.evaluate(() => (Reflect.get(window, 'labelAssetAborts') as string[]).length)).toBe(2);
  await navigation.resume();
  await expect(navigation.pending.getByRole('link', { name: m.download, exact: true })).toHaveCount(0);
  await navigation.pending.close();
  console.log('PASS: slow initial asset loading aborts both fetches on Cancel, locale change and client navigation; cancelled export retries and new locale regenerates correctly');

  const geometry = await context.newPage();
  geometry.setDefaultTimeout(30000);
  // Each layout starts from no selection; the tab otherwise restores the last one.
  await geometry.addInitScript(() => { for (const key of Object.keys(sessionStorage)) if (key.startsWith('ampoteket:draft:')) sessionStorage.removeItem(key); });
  for (const [prefix, messages] of [['', nb], ['/en', en]] as const) for (const colorScheme of ['light', 'dark'] as const) for (const width of [360, 1280]) {
    await geometry.setViewportSize({ width, height: 900 });
    await geometry.emulateMedia({ colorScheme });
    await geometry.goto(`${origin}${prefix}/admin/products/labels`);
    const copy = messages.adminLabels;
    await expect(geometry.getByRole('group', { name: copy.wall, exact: true })).toBeVisible();
    // Zooming into a cabinet keeps the stage heading where the wall heading was.
    const top = await geometry.getByRole('heading', { name: copy.wall, exact: true }).evaluate(element => element.getBoundingClientRect().top + window.scrollY);
    await geometry.getByRole('button', { name: copy.cabinet('A1'), exact: true }).click();
    expect(await geometry.getByRole('heading', { name: copy.cabinet('A1'), exact: true }).evaluate(element => element.getBoundingClientRect().top + window.scrollY)).toBeCloseTo(top, 2);
    await geometry.getByRole('group', { name: copy.cabinet('A1'), exact: true }).getByRole('button', { name: 'A1', exact: true }).click();
    await expect(geometry.getByText(copy.summary(3, 1), { exact: true })).toBeVisible();
    const widthInput = geometry.getByLabel(fieldLabel(`${copy.width} (mm)`));
    await widthInput.focus(); await geometry.keyboard.press('Tab'); await geometry.keyboard.press('Shift+Tab');
    expect(await geometry.evaluate(() => { const element = document.activeElement!; return element.matches(':focus-visible') && parseFloat(getComputedStyle(element.closest('[data-slot="input-group"]') ?? element).outlineWidth) >= 2; })).toBe(true);
    await fits(geometry);
    const suffix = `${prefix ? 'en' : 'nb'}-${colorScheme}-${width}`;
    await geometry.locator('.label-shelf-selection').screenshot({ path: `${artifacts}/selection-${suffix}.png` });
    await geometry.getByRole('button', { name: copy.generate, exact: true }).click();
    await expect(geometry.getByRole('link', { name: copy.download, exact: true })).toBeVisible();
    await fits(geometry);
    await geometry.screenshot({ path: `${artifacts}/labels-${suffix}.png`, fullPage: true });
  }
  await geometry.close();
  expect(writes).toEqual([]);
  expect(await snapshot()).toBe(fixtureState);
  expect(diagnostics).toEqual([]);
  console.log('PASS: both locales/themes at 360/1280, stable drawer disclosure, visible keyboard focus, no horizontal overflow and no application writes');


} catch (error) {
  for (const [index, page] of (context?.pages() ?? []).entries()) await captureFailure(page, artifacts, String(index));
  throw error;
} finally { await close(); }
