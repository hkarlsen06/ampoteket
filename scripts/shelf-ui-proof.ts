/** Spatial shelf editing against a disposable Convex backend and the production Worker. */
import { firefox, expect as baseExpect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { captureFailure, proofEnvironment, signIn } from './web-proof/harness';
import { convexSocket } from './web-proof/convex-faults';
import { en } from '../src/lib/i18n/en';
import { nb } from '../src/lib/i18n/nb';

// Sign-in and reads share a disposable backend with parallel proofs; allow for a loaded machine.
const expect = baseExpect.configure({ timeout: 15_000 });

const { directory, origin, convexUrl, password, fixtures, createStaff, startWorker } = await proofEnvironment();
const email = 'shelf-ui@example.test';
await createStaff(email, 'Shelf UI operator');
type Cabinet = { id: string; outer_row: number | null; outer_col: number | null; inner_rows: number; inner_cols: number; is_archived: boolean };
type Bin = { id: string; cabinet_id: string | null; inner_row: number | null; inner_col: number | null; row_span: number; col_span: number; label: string | null; is_archived: boolean };
const [{ id: cabinetId }] = (await fixtures.rows<Cabinet>('cabinets', { inner_rows: 12, inner_cols: 4, is_archived: false }))
  .sort((a, b) => a.outer_row! - b.outer_row! || a.outer_col! - b.outer_col!);
const bin = async (id: string) => { const [row] = await fixtures.rows<Bin>('bins', { id }); assert.ok(row); return row; };
const binId = async (row: number, col: number) => {
  const [found] = await fixtures.rows<Bin>('bins', { cabinet_id: cabinetId, inner_row: row, inner_col: col, is_archived: false });
  assert.ok(found); return found.id;
};
const ids = (rows: { id: string }[]) => rows.map(row => row.id).sort();
/** Rows of the two swapped drawers, from one read. */
const swapRows = async () => { const bins = await fixtures.rows<Bin>('bins'); return [swapFirst, swapSecond].map(id => bins.find(row => row.id === id)?.inner_row); };
const first = await binId(1, 1), swapFirst = await binId(1, 4), swapSecond = await binId(2, 4);
// Two identical empty drawers do not swap (a slipped drag changes nothing visible); a label tells these apart.
await fixtures.patch('bins', { id: swapFirst }, { label: 'Shelf proof' });
const product = (code: string, binId: string) => {
  const now = new Date().toISOString().replace('Z', '000Z');
  return { id: randomUUID(), code, name_nb: 'Testdel', name_en: 'Test part', description: null, category_id: null, bin_id: binId, location_note: null,
    unit_code: 'pcs', stock_step: '1', sale_step: '1', sale_unit_price_nok: '0', minimum_stock: '0', datasheet_url: null, purchase_url: null,
    is_active: true, metadata_revision: 1, created_at: now, updated_at: now };
};
let context: BrowserContext | undefined;
const { ready, close } = await startWorker(() => context);
const artifacts = resolve('test-results/shelf');
await mkdir(artifacts, { recursive: true });
const errors: string[] = [];
const m = en.adminShelf;
// One CSS pixel plus floating-point noise from browser bounding-box coordinates.
const pixelTolerance = 1 + 1e-5;
async function center(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox(); assert.ok(box);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
async function startMove(page: Page, handle: Locator, x: number, y: number) {
  const start = await center(handle);
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(start.x + x, start.y + y, { steps: 5 });
}
async function dragSwap(page: Page, source: Locator, target: Locator) {
  await source.scrollIntoViewIfNeeded(); await target.scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox(), targetBox = await target.boundingBox(); assert.ok(sourceBox && targetBox);
  const start = { x: sourceBox.x + sourceBox.width * .35, y: sourceBox.y + sourceBox.height * .4 };
  const original = await source.locator('.drawer').boundingBox(); assert.ok(original);
  const destination = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 };
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(destination.x, destination.y, { steps: 8 });
  const lifted = page.locator('[data-drawer-drag-preview]');
  await expect(lifted).toBeVisible();
  await expect(source.locator('.drawer')).toHaveCSS('visibility', 'hidden');
  await expect(source).toHaveClass(/border-dashed/);
  const floating = await lifted.boundingBox(); assert.ok(floating);
  expect(Math.abs(floating.x - (original.x + destination.x - start.x))).toBeLessThanOrEqual(pixelTolerance);
  expect(Math.abs(floating.y - (original.y + destination.y - start.y))).toBeLessThanOrEqual(pixelTolerance);
  expect(floating.width).toBeCloseTo(original.width, 0); expect(floating.height).toBeCloseTo(original.height, 0);
  expect(await lifted.evaluate(element => getComputedStyle(element).pointerEvents)).toBe('none');
  await expect(target.locator('.drawer')).toHaveClass(/outline-dashed/);
  // The lifted drawer stays visible beyond the scroll region, without intercepting pointer targets.
  const viewport = await source.locator('xpath=ancestor::*[contains(@class, "shelf-viewport")]').boundingBox(); assert.ok(viewport);
  const outside = { x: viewport.x - 12, y: destination.y };
  await page.mouse.move(outside.x, outside.y, { steps: 3 });
  expect(Math.abs((await lifted.boundingBox())!.x - (original.x + outside.x - start.x))).toBeLessThanOrEqual(pixelTolerance);
  expect(await lifted.evaluate(element => {
    const box = element.getBoundingClientRect();
    return document.elementsFromPoint(box.left + box.width / 2, box.top + box.height / 2).every(hit => !element.contains(hit));
  })).toBe(true);
  await page.mouse.move(destination.x, destination.y, { steps: 3 });
  await expect(target.locator('.drawer')).toHaveClass(/outline-dashed/);
}
try {
  await ready();
  context = await firefox.launchPersistentContext(`${directory}/profile`, { headless: true, ignoreHTTPSErrors: false, hasTouch: true });
  // Shelf writes travel over the app's one Convex WebSocket, which HTTP routes cannot see.
  const socket = await convexSocket(context, convexUrl);
  const swaps = () => socket.sent('shelf:swapBins');
  context.on('page', tab => tab.on('pageerror', error => errors.push(error.message)));
  const page = await context.newPage();
  await signIn(page, origin, email, password);
  await expect(page.getByRole('heading', { name: en.admin.overview, exact: true })).toBeVisible();
  await page.goto(`${origin}/en/admin/shelf`);
  await page.locator(`[data-item-id="${cabinetId}"]`).click();
  const editor = page.locator('[data-cabinet-editor]');
  const picker = page.getByRole('dialog');
  await expect(editor).toBeVisible();
  await expect(picker).toHaveCount(0);
  // Drawer actions belong to a selected drawer; none is selected yet.
  const moveDrawer = editor.getByRole('button', { name: m.moveDrawer, exact: true });
  const archiveDrawer = editor.getByRole('button', { name: m.archiveBin, exact: true });
  await expect(moveDrawer).toHaveCount(0);
  await page.screenshot({ path: `${artifacts}/editor-initial.png` });
  const rows = editor.getByRole('slider', { name: m.resizeRows, exact: true });
  const cols = editor.getByRole('slider', { name: m.resizeCols, exact: true });
  await expect(rows).toHaveAttribute('aria-valuenow', '12');
  await expect(editor.getByText(m.grid(12, 4), { exact: true })).toBeVisible();
  await rows.evaluate(element => element.setAttribute('data-proof-persistent', 'true'));
  // A product placed meanwhile in another drawer shows once the tab regains focus, without remounting the editor.
  const topDrawer = editor.locator(`[data-item-id="${await binId(12, 1)}"]`), emptyFace = new RegExp(` · ${m.emptyDrawer}$`);
  await expect(topDrawer).toHaveAttribute('aria-label', emptyFace);
  await fixtures.insert('products', [product('SHELF-FOCUS', await binId(12, 1))]);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(topDrawer).not.toHaveAttribute('aria-label', emptyFace);
  await expect(rows).toBeEnabled();
  await expect(rows).toHaveAttribute('data-proof-persistent', 'true');
  const frameLocator = editor.locator('.cabinet-frame');
  const initialFrame = await frameLocator.boundingBox(), rowGrip = await rows.boundingBox(), colGrip = await cols.boundingBox(); assert.ok(initialFrame && rowGrip && colGrip);
  expect(Math.abs(rowGrip.y + rowGrip.height / 2 - initialFrame.y)).toBeLessThanOrEqual(pixelTolerance);
  expect(Math.abs(colGrip.x + colGrip.width / 2 - initialFrame.x - initialFrame.width)).toBeLessThanOrEqual(pixelTolerance);
  expect(initialFrame.height).toBeCloseTo(384, 0);
  await rows.focus(); await page.keyboard.press('ArrowUp'); await expect(rows).toHaveAttribute('aria-valuenow', '13');
  await page.keyboard.press('ArrowDown'); await expect(rows).toHaveAttribute('aria-valuenow', '12');
  await startMove(page, rows, 0, -40);
  await expect(rows).not.toHaveAttribute('aria-valuenow', '12');
  const activeRows = await rows.boundingBox(), activeFrame = await frameLocator.boundingBox(); assert.ok(activeRows && activeFrame);
  expect(activeFrame.height).toBeCloseTo(initialFrame.height, 0);
  expect(Math.abs(activeRows.y + activeRows.height / 2 - activeFrame.y)).toBeLessThanOrEqual(pixelTolerance);
  await rows.dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse' }); await page.mouse.up(); await expect(page.locator('[data-drawer-drag-preview]')).toHaveCount(0);
  await expect(rows).toHaveAttribute('aria-valuenow', '12');
  await startMove(page, rows, 0, -40); await page.keyboard.press('Escape'); await page.mouse.up(); await expect(page.locator('[data-drawer-drag-preview]')).toHaveCount(0);
  await expect(editor).toBeVisible(); await expect(rows).toHaveAttribute('aria-valuenow', '12');
  const frame = await editor.locator('.cabinet-frame').boundingBox(); assert.ok(frame);
  const cellBefore = await editor.locator(`[data-item-id="${first}"]`).boundingBox(); assert.ok(cellBefore);
  await startMove(page, cols, 64, 0);
  await expect(cols).toHaveAttribute('aria-valuenow', '5');
  const liveFrame = await frameLocator.boundingBox(), liveCell = await editor.locator(`[data-item-id="${first}"]`).boundingBox(); assert.ok(liveFrame && liveCell);
  const activeCols = await cols.boundingBox(); assert.ok(activeCols);
  expect(Math.abs(activeCols.x + activeCols.width / 2 - liveFrame.x - liveFrame.width)).toBeLessThanOrEqual(pixelTolerance);
  expect(activeCols.y + activeCols.height / 2).toBeCloseTo(liveFrame.y + liveFrame.height / 2, 0);
  expect(liveFrame.width - frame.width).toBeCloseTo(64, 0); expect(liveFrame.height).toBeCloseTo(frame.height, 0);
  expect(Math.abs(liveCell.width - cellBefore.width)).toBeLessThan(1);
  await page.keyboard.press('Escape'); await page.mouse.up(); await expect(page.locator('[data-drawer-drag-preview]')).toHaveCount(0);
  await expect(cols).toHaveAttribute('aria-valuenow', '4'); expect((await frameLocator.boundingBox())!.width).toBeCloseTo(frame.width, 0);
  await startMove(page, cols, 64, 0); await page.mouse.up(); await expect(page.locator('[data-drawer-drag-preview]')).toHaveCount(0);
  await expect(cols).toHaveAttribute('aria-valuenow', '5');
  await cols.focus(); await page.keyboard.press('ArrowLeft'); await expect(cols).toHaveAttribute('aria-valuenow', '4');
  await editor.locator(`[data-item-id="${first}"]`).click();
  const width = editor.getByRole('slider', { name: m.resizeHandle, exact: true });
  await width.focus(); await page.keyboard.press('ArrowRight'); await expect(width).toHaveAttribute('aria-valuenow', '2');
  expect((await bin(first)).col_span).toBe(1);
  await expect(page.getByRole('button', { name: m.newCabinet, exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: en.shelfMap.showWall, exact: true })).toBeDisabled();
  await dragSwap(page, editor.locator(`[data-item-id="${swapFirst}"]`), editor.locator(`[data-item-id="${swapSecond}"]`)); await page.mouse.up(); await expect(page.locator('[data-drawer-drag-preview]')).toHaveCount(0);
  await expect(editor.getByText(m.saveBeforeSwap, { exact: true })).toBeVisible();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await editor.getByRole('button', { name: m.save, exact: true }).click();
  await expect.poll(async () => (await bin(first)).col_span).toBe(2);
  await expect(editor.getByRole('button', { name: m.discardChanges, exact: true })).toBeHidden();
  await expect(editor).toBeVisible();
  await expect(rows).toHaveAttribute('aria-valuenow', '12');
  console.log('PASS: inline editor; keyboard/pointer grid resizing and cancellation; drawer widening saves through the real layout mutation without closing editor');

  await page.locator(`[data-item-id="${first}"]`).click();
  await page.getByRole('slider', { name: m.resizeHandle, exact: true }).focus(); await page.keyboard.press('ArrowRight');
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('slider', { name: m.resizeHandle, exact: true })).toHaveAttribute('aria-valuenow', '3');
  await editor.getByRole('button', { name: m.discardChanges, exact: true }).click(); await expect(editor).toBeVisible();
  await editor.locator(`[data-item-id="${first}"]`).click();
  await expect(editor.getByRole('slider', { name: m.resizeHandle, exact: true })).toHaveAttribute('aria-valuenow', '2');
  expect((await bin(first)).col_span).toBe(2);
  await expect(editor.getByRole('button', { name: m.discardChanges, exact: true })).toBeHidden();
  const source = page.locator(`[data-item-id="${swapFirst}"]`), target = page.locator(`[data-item-id="${swapSecond}"]`);
  const beforeTouchViewport = page.viewportSize()!;
  await page.setViewportSize({ width: 360, height: 640 });
  await expect(source).toHaveCSS('touch-action', 'auto');
  await source.click();
  const touchHandle = page.locator('.drawer-move-handle');
  await expect(touchHandle).toHaveCSS('touch-action', 'none');
  await startMove(page, touchHandle, 12, 12);
  await expect(page.locator('[data-drawer-drag-preview]')).toBeVisible();
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(page.locator('[data-drawer-drag-preview]')).toHaveCount(0);
  await page.setViewportSize(beforeTouchViewport);
  await dragSwap(page, source, target); await page.keyboard.press('Escape'); await page.mouse.up(); await expect(page.locator('[data-drawer-drag-preview]')).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0); expect(swaps()).toHaveLength(0);
  await dragSwap(page, source, target); await source.dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse' }); await page.mouse.up(); await expect(page.locator('[data-drawer-drag-preview]')).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0); expect(swaps()).toHaveLength(0);
  await dragSwap(page, source, target); await page.mouse.up(); await expect(page.locator('[data-drawer-drag-preview]')).toHaveCount(0);
  const confirm = page.getByRole('alertdialog'); await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: m.cancelAction, exact: true }).click();
  expect(swaps()).toHaveLength(0); await expect(page.getByText(m.positionsSwapped, { exact: true })).toHaveCount(0);
  await dragSwap(page, source, target); await page.mouse.up(); await expect(page.locator('[data-drawer-drag-preview]')).toHaveCount(0);
  // Committed but not yet acknowledged: no success toast until the reply arrives.
  const swapReply = socket.hold('shelf:swapBins');
  await confirm.getByRole('button', { name: m.swap, exact: true }).click();
  await expect.poll(swapRows).toEqual([2, 1]);
  await expect(page.getByText(m.positionsSwapped, { exact: true })).toHaveCount(0);
  swapReply.release();
  await expect(page.getByText(m.positionsSwapped, { exact: true })).toBeVisible();
  await expect(confirm).toHaveCount(0); expect(swaps()).toHaveLength(1);
  await source.click(); await page.locator('.drawer-move-handle').focus(); await page.keyboard.press('Enter');
  await expect(picker).toHaveCount(0); await expect(editor.getByText(m.chooseSwap, { exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(editor.getByText(m.chooseSwap, { exact: true })).toBeHidden();
  const moveHandle = await center(page.locator('.drawer-move-handle')); await page.touchscreen.tap(moveHandle.x, moveHandle.y);
  await expect(picker).toHaveCount(0); await expect(editor.getByText(m.chooseSwap, { exact: true })).toBeVisible();
  await target.click(); await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: m.cancelAction, exact: true }).click(); expect(swaps()).toHaveLength(1);
  await page.keyboard.press('Escape');
  const editorSource = editor.locator(`[data-item-id="${swapFirst}"]`), editorTarget = editor.locator(`[data-item-id="${swapSecond}"]`);
  await dragSwap(page, editorSource, editorTarget); await page.mouse.up(); await expect(page.locator('[data-drawer-drag-preview]')).toHaveCount(0);
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: m.swap, exact: true }).click();
  await expect.poll(swapRows).toEqual([1, 2]);
  await expect(editor).toBeVisible(); expect(swaps()).toHaveLength(2);
  console.log('PASS: drawer drag target outline, Escape/pointer cancellation, confirmation cancel/commit, persisted swap and keyboard/touch inline target selection');

  await source.click(); await moveDrawer.click();
  await expect(editor.getByText(m.chooseSwap, { exact: true })).toBeVisible();
  await editor.getByRole('button', { name: m.cancelAction, exact: true }).click();
  await expect(editor.getByText(m.chooseSwap, { exact: true })).toBeHidden();
  await moveDrawer.click();
  await page.getByRole('button', { name: en.shelfMap.showWall, exact: true }).click();
  const anotherCabinet = page.locator(`[data-shelf-wall] [data-item-id]:not([data-item-id="${cabinetId}"])`).first();
  await expect(anotherCabinet).toBeEnabled(); await anotherCabinet.click();
  await expect(editor.getByText(m.chooseSwap, { exact: true })).toBeVisible();
  await editor.locator('[data-item-id]').first().click(); await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: m.cancelAction, exact: true }).click(); expect(swaps()).toHaveLength(2);
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: en.shelfMap.showWall, exact: true }).click();
  await page.locator(`[data-item-id="${cabinetId}"]`).click(); await source.click();
  await expect(editor.getByText(m.noProducts, { exact: true })).toBeVisible();
  await expect(archiveDrawer).toBeEnabled();
  // A drafted layout change blocks immediate drawer commands until it is saved or discarded.
  await rows.focus(); await page.keyboard.press('ArrowUp');
  await expect(moveDrawer).toBeDisabled(); await expect(archiveDrawer).toBeDisabled();
  await editor.getByRole('button', { name: m.discardChanges, exact: true }).click();
  await source.click(); await expect(archiveDrawer).toBeEnabled();
  await fixtures.insert('products', [product('SHELF-PROOF', swapFirst)]);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(source).not.toHaveAttribute('aria-label', emptyFace);
  await expect(source).toBeEnabled(); await source.click();
  await expect(archiveDrawer).toBeDisabled();
  await expect(editor.getByRole('button', { name: m.narrowDrawer, exact: true })).toBeDisabled();
  await expect(editor.getByText('SHELF-PROOF', { exact: true })).toBeVisible();
  console.log('PASS: drawer actions beside the selected drawer: move, draft guard, contents and occupied archive guard');

  const vacantBin = await binId(3, 4);
  const contentsBeforeMove = ids(await fixtures.rows<{ id: string }>('products', { bin_id: swapFirst }));
  await editor.locator(`[data-item-id="${vacantBin}"]`).click();
  await archiveDrawer.click(); await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: m.confirmAction, exact: true }).click();
  await expect.poll(async () => (await bin(vacantBin)).is_archived).toBe(true);
  await expect(editor.locator(`[data-item-id="${vacantBin}"]`)).toHaveCount(0);
  await source.click(); await moveDrawer.click();
  await editor.locator('[data-item-id="vacant:3:4"]').click(); await expect(confirm).toBeVisible();
  await expect(picker).toHaveCount(0);
  await confirm.getByRole('button', { name: m.confirmAction, exact: true }).click();
  await expect.poll(async () => { const moved = await bin(swapFirst); return [moved.cabinet_id, moved.inner_row, moved.inner_col, moved.is_archived]; })
    .toEqual([cabinetId, 3, 4, false]);
  await expect(editor.getByText(m.chooseSwap, { exact: true })).toBeHidden();
  expect(ids(await fixtures.rows<{ id: string }>('products', { bin_id: swapFirst }))).toEqual(contentsBeforeMove);
  expect(await fixtures.rows('bins', { cabinet_id: cabinetId, inner_row: 1, inner_col: 4, is_archived: false })).toHaveLength(0);
  console.log('PASS: archive empty drawer then move assigned drawer into vacant position, preserving identity and products');

  for (const locale of ['nb', 'en'] as const) for (const colorScheme of ['light', 'dark'] as const) for (const width of [360, 1280]) {
    const messages = (locale === 'nb' ? nb : en).adminShelf;
    await page.setViewportSize({ width, height: width === 360 ? 640 : 900 }); await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.goto(`${origin}${locale === 'nb' ? '' : '/en'}/admin/shelf`);
    await page.locator(`[data-item-id="${cabinetId}"]`).click();
    await page.locator(`[data-item-id="${swapFirst}"]`).click();
    await page.locator('.drawer-move-handle').scrollIntoViewIfNeeded();
    expect(await editor.locator('.shelf-viewport').evaluate(element => element.scrollWidth <= element.clientWidth), `Standard cabinet fits ${locale}/${colorScheme}/${width}`).toBe(true);
    await page.screenshot({ path: `${artifacts}/drawers-${locale}-${colorScheme}-${width}.png` });
    await expect(picker).toHaveCount(0);
    await expect(editor.getByRole('slider', { name: messages.resizeRows, exact: true })).toBeVisible();
    // Admin pages carry no floating buyer scanner, so nothing covers the shelf grips (design-system §4.1).
    await expect(page.locator('.scanner-trigger')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(await editor.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: `${artifacts}/cabinet-${locale}-${colorScheme}-${width}.png` });
  }
  expect(errors).toEqual([]);
  console.log('PASS: localized light/dark inline cabinet editors at 360/1280px with no page or editor horizontal overflow');

  const retiringCabinet = randomUUID(), retiringBins = [randomUUID(), randomUUID()];
  await fixtures.insert('cabinets', [{ id: retiringCabinet, code: `C-${retiringCabinet}`, outer_row: 3, outer_col: 1, inner_rows: 1, inner_cols: 2, label: null, is_archived: false }]);
  await fixtures.insert('bins', retiringBins.map((id, index) => ({ id, code: `B-${id}`, cabinet_id: retiringCabinet, inner_row: 1, inner_col: index + 1,
    row_span: 1, col_span: 1, label: null, is_archived: false })));
  await page.reload();
  await page.locator(`[data-shelf-wall] [data-item-id="${retiringCabinet}"]`).click();
  await page.getByRole('button', { name: m.archiveCabinetWithDrawers, exact: true }).click();
  await expect(confirm).toContainText(m.archiveCabinetWithDrawersConfirm(2));
  await confirm.getByRole('button', { name: m.confirmAction, exact: true }).click();
  await expect.poll(async () => (await fixtures.rows<Cabinet>('cabinets', { id: retiringCabinet }))[0].is_archived).toBe(true);
  await expect(page.locator(`[data-shelf-wall] [data-item-id="${retiringCabinet}"]`)).toHaveCount(0);
  expect(await Promise.all(retiringBins.map(async id => (await bin(id)).is_archived))).toEqual([true, true]);
  console.log('PASS: cabinet and two empty drawers archive through one confirmed mutation');

  // Move cabinet: the wall picker offers vacant positions as well as cabinets to swap with.
  const liveBins = async () => ids(await fixtures.rows<Bin>('bins', { cabinet_id: cabinetId, is_archived: false }));
  const binsBeforeMove = await liveBins();
  await page.locator(`[data-shelf-wall] [data-item-id="${cabinetId}"]`).click();
  await page.getByRole('button', { name: m.moveCabinet, exact: true }).click();
  const mover = page.getByRole('dialog', { name: m.moveCabinet, exact: true });
  await mover.getByRole('button', { name: `A3 · ${m.emptyDrawer}`, exact: true }).click();
  await expect(mover).toContainText(m.cabinet('A3'));
  await mover.getByRole('button', { name: m.move, exact: true }).click();
  await confirm.getByRole('button', { name: m.confirmAction, exact: true }).click();
  await expect.poll(async () => { const [moved] = await fixtures.rows<Cabinet>('cabinets', { id: cabinetId }); return [moved.outer_row, moved.outer_col]; }).toEqual([3, 1]);
  await expect(mover).toBeHidden();
  // The zoomed stage names the cabinet at its new position above its open editor.
  await expect(page.locator('[data-shelf-stage]').getByRole('heading', { name: m.cabinet('A3'), exact: true, level: 2 })).toBeVisible();
  await expect(editor).toBeVisible();
  expect(await liveBins()).toEqual(binsBeforeMove);
  expect(errors).toEqual([]);
  console.log('PASS: cabinet moves to a vacant wall position through the wall picker, keeping its drawers');
} catch (error) {
  for (const [index, page] of (context?.pages() ?? []).entries()) await captureFailure(page, artifacts, String(index), 'body');
  throw error;
} finally { await close(); }
