/** Actual pages and gateway, disposable Convex backend and Auth, trusted HTTPS and real browser storage. */
import { firefox, expect as playwrightExpect, type BrowserContext } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fieldLabel, signIn, fits, captureFailure, proofEnvironment } from './web-proof/harness';
import { convexSocket } from './web-proof/convex-faults';
import { seedDemoData, seedProductId, seedProductCode, seedBinId } from './seed-test-data';
import { en } from '../src/lib/i18n/en';
import { nb } from '../src/lib/i18n/nb';

// Several disposable backends and builds may share this machine; waits allow for that.
const expect = playwrightExpect.configure({ timeout: 20_000 });
const { directory, origin, convexUrl, password, ca, run, fixtures, createStaff, createUser, startWorker } = await proofEnvironment();
const staffEmail = 'labels-staff@example.test';
const nonstaffEmail = 'labels-nonstaff@example.test';
await createStaff(staffEmail, 'Browser operator');
await createUser(nonstaffEmail);
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
// Every application table. Auth accounts, sessions and sign-in rate limits change
// by signing in, which the old snapshot of the app schema never covered either.
const applicationTables = ['units', 'staff_members', 'help_contacts', 'categories', 'cabinets', 'bins', 'products',
  'attribute_definitions', 'product_attributes', 'command_requests', 'purchase_orders', 'purchase_order_lines',
  'purchase_order_cancellations', 'checkouts', 'checkout_lines', 'checkout_contacts', 'count_batches', 'inventory_events',
  'inventory_movements', 'movement_corrections', 'receipt_allocations', 'sales', 'stock_counts', 'audit_log', 'stock_levels', 'counters'];
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1).map(([key, item]) => [key, stable(item)]))
    : value;
async function snapshot() {
  const tables = await Promise.all(applicationTables.map(async table => [table, (await fixtures.rows(table)).map(row => JSON.stringify(stable(row))).sort()]));
  return JSON.stringify(tables);
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
await seedDemoData(run);
async function patchProduct(index: number, changes: Record<string, unknown>) {
  assert.equal(await fixtures.patch('products', { id: seedProductId(index) }, changes), 1, `Fixture product ${index} exists`);
}
// Three components share the wall's first drawer; one of them and the unplaced one are unpublished.
await patchProduct(0, { bin_id: seedBinId(0), name_nb: 'Langt norsk produktnavn med æ, ø og å for kontroll på en smal mobilskjerm',
  name_en: 'Deliberately long component name for the narrowest supported phone screen' });
await patchProduct(1, { bin_id: seedBinId(0) });
await patchProduct(2, { bin_id: seedBinId(0), is_active: false });
await patchProduct(29, { is_active: false, bin_id: null });
const [secondCabinet] = await fixtures.rows<{ id: string }>('cabinets', { outer_row: 1, outer_col: 2 });
const [secondCabinetBin] = (await fixtures.rows<{ id: string; inner_row: number; inner_col: number }>('bins', { cabinet_id: secondCabinet.id }))
  .sort((a, b) => a.inner_row - b.inner_row || a.inner_col - b.inner_col);
await patchProduct(28, { bin_id: secondCabinetBin.id });
const [packageDefinition] = await fixtures.rows<{ id: string }>('attribute_definitions', { code: 'package' });
assert.equal(await fixtures.patch('product_attributes', { product_id: seedProductId(0), attribute_id: packageDefinition.id },
  { text_value: 'Very long specification '.repeat(80) }), 1);
const productCodes = async (placedOnly: boolean) => (await fixtures.rows<{ code: string; bin_id: string | null }>('products'))
  .filter(product => !placedOnly || product.bin_id !== null).map(product => product.code).sort();
// Resolve the actual production chunks containing writer/font delivery so the
// lazy-load check verifies JavaScript too, not merely absence of asset requests.
const exportChunks = new Set<string>();
for await (const filename of new Bun.Glob('**/*.js').scan(`${directory}/site/cloudflare/_app/immutable`)) {
  const source = await Bun.file(`${directory}/site/cloudflare/_app/immutable/${filename}`).text();
  if (source.includes('zxing_writer') || source.includes('Lato-Regular')) exportChunks.add(`/_app/immutable/${filename}`);
}
assert.ok(exportChunks.size, 'The production build contains identifiable lazy label-export chunks');
// Every public mutation the browser could call (`products:save`), from the functions' sources.
const mutationPaths: string[] = [];
for await (const filename of new Bun.Glob('*.ts').scan('convex')) {
  for (const [, name] of (await Bun.file(`convex/${filename}`).text()).matchAll(/^export const (\w+) = mutation\(/gm)) mutationPaths.push(`${filename.replace(/\.ts$/, '')}:${name}`);
}
assert.ok(mutationPaths.includes('products:save') && mutationPaths.includes('stock:adjust'), 'Public mutations are discoverable');
const fixtureState = await snapshot();
const requests: string[] = [];
try {
  await ready();
  await verifyBootAssets();
  context = await firefox.launchPersistentContext(`${directory}/profile`, { headless: true, ignoreHTTPSErrors: false, acceptDownloads: true });
  // Routes only apply to sockets opened afterwards, so install before the first page.
  const socket = await convexSocket(context, convexUrl);
  context.on('page', tab => {
    tab.on('pageerror', error => diagnostics.push(error.message));
    tab.on('response', response => {
      const url = new URL(response.url());
      if (url.origin === origin && url.pathname.startsWith('/_app/immutable/') && /\.(css|js)$/.test(url.pathname) && !response.ok()) diagnostics.push(`Static asset ${response.status}: ${url.pathname}`);
    });
    tab.on('request', request => { requests.push(request.url()); });
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
  const retry = page.getByRole('button', { name: m.retry, exact: true });
  const wall = page.getByRole('group', { name: m.wall, exact: true });
  // The page reads products, references, the wall and specifications as four
  // Convex queries. A failed product read leaves nothing to select or generate.
  const productRead = socket.failReads('products:list');
  await page.goto(`${origin}/en/admin/products/labels`);
  await expect(retry).toBeVisible();
  await expect(wall).toHaveCount(0);
  await expect(page.getByRole('button', { name: m.generate, exact: true, disabled: false })).toHaveCount(0);
  productRead.stop();
  await retry.click();
  await expect(wall).toBeVisible();
  expect(requests.filter(url => /\.wasm(?:\?|$)|Lato-Regular/.test(url) || exportChunks.has(new URL(url).pathname))).toEqual([]);

  // Products arriving while another read fails must never look like a complete result.
  const specificationRead = socket.failReads('products:attributes');
  await page.reload();
  await expect(retry).toBeVisible();
  await expect(wall).toHaveCount(0);
  await expect(page.getByRole('button', { name: m.generate, exact: true, disabled: false })).toHaveCount(0);
  specificationRead.stop();
  await retry.click();
  await expect(wall).toBeVisible();
  // Nor may a failed background re-read leave the earlier data usable for a file.
  await page.getByRole('button', { name: m.selectAll, exact: true }).click();
  await expect(page.getByRole('button', { name: m.generate, exact: true })).toBeEnabled();
  const backgroundRead = socket.failReads('products:attributes');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(retry).toBeVisible();
  await expect(page.getByRole('button', { name: m.generate, exact: true })).toBeDisabled();
  backgroundRead.stop();
  await retry.click();
  await expect(retry).toHaveCount(0);
  await expect(page.getByRole('button', { name: m.generate, exact: true })).toBeEnabled();
  await page.getByRole('button', { name: m.clearSelection, exact: true }).click();
  console.log('PASS: real non-staff denial; failed product, specification and background reads never enable Generate, and Retry recovers');

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
  await expect(page.getByText(m.summary(30, 2), { exact: true }).and(page.locator('p'))).toBeVisible();
  // The same summary is announced from the polite live region as screen-reader text.
  await expect(page.locator('[aria-live="polite"] .sr-only').getByText(m.summary(30, 2), { exact: true })).toHaveCount(1);
  await page.getByLabel(fieldLabel(`${m.width} (mm)`)).fill('45');
  const widthControl = page.getByLabel(fieldLabel(`${m.width} (mm)`));
  await widthControl.focus();
  await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  const focused = await widthControl.evaluate(element => element === document.activeElement && element.matches(':focus-visible') && parseFloat(getComputedStyle(element.closest('[data-slot="input-group"]') ?? element).outlineWidth) >= 2);
  expect(focused).toBe(true);
  // Window focus re-reads in the background. A change made meanwhile (without
  // audit, restored below) shows that the read happened; selection, input and focus stay.
  await patchProduct(3, { is_active: false });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText(m.summary(30, 3), { exact: true }).and(page.locator('p'))).toBeVisible();
  await expect(widthControl).toBeFocused();
  await expect(widthControl).toHaveValue('45');
  await expect(page.getByText(m.selectedDrawers(492), { exact: true })).toBeVisible();
  await patchProduct(3, { is_active: true });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText(m.summary(30, 2), { exact: true }).and(page.locator('p'))).toBeVisible();
  await expect(widthControl).toBeFocused();
  await page.getByLabel(fieldLabel(m.includeUnplaced)).uncheck();
  await expect(page.getByText(m.summary(29, 1), { exact: true }).and(page.locator('p'))).toBeVisible();
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
  await inspectPdf(pdfPath, await productCodes(true), 45, 10, 2);
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
  await inspectPdf(`${artifacts}/labels-all.pdf`, await productCodes(false), 45, 10, 2);
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
  await expect(page.getByText(m.summary(3, 1), { exact: true }).and(page.locator('p'))).toBeVisible();
  await page.getByRole('button', { name: m.generate, exact: true }).click();
  await expect(download).toBeVisible();
  await expect(page.getByText(m.summary(3, 1), { exact: true }).and(page.locator('p'))).toBeVisible();
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
    await expect(geometry.getByText(copy.summary(3, 1), { exact: true }).and(geometry.locator('p'))).toBeVisible();
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
  // The browser sent no mutation over the Convex socket at any point.
  expect(mutationPaths.flatMap(path => socket.sent(path).map(args => `${path} ${args}`))).toEqual([]);
  expect(await snapshot()).toBe(fixtureState);
  expect(diagnostics).toEqual([]);
  console.log('PASS: both locales/themes at 360/1280, stable drawer disclosure, visible keyboard focus, no horizontal overflow and no application writes');


} catch (error) {
  for (const [index, page] of (context?.pages() ?? []).entries()) await captureFailure(page, artifacts, String(index));
  throw error;
} finally { await close(); }
