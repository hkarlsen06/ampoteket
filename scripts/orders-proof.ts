/** Real admin order/receipt pages against a disposable Convex backend. */
import { firefox, expect as baseExpect, type BrowserContext, type Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prepareZXingModule, writeBarcode } from 'zxing-wasm/writer';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../convex/_generated/api';
import { captureFailure, fieldLabel, signIn, fits, proofEnvironment } from './web-proof/harness';
import { interceptConvex } from './web-proof/convex-socket';
import { seedDemoData, seedProductCode, seedProductId } from './seed-test-data';
import { en } from '../src/lib/i18n/en';
import { nb } from '../src/lib/i18n/nb';
import { formatMeasurementText, unitLabel } from '../src/lib/format';
import { addDecimals, compareDecimals } from '../src/lib/decimal';

// Live backend round trips, not animations, set the pace; allow for a busy machine.
const expect = baseExpect.configure({ timeout: 15_000 });
const { directory, origin, convexUrl, password, secrets, run, fixtures, createStaff, createUser, startWorker } = await proofEnvironment();
const staffEmail = 'orders-staff@example.test';
const nonstaffEmail = 'orders-nonstaff@example.test';
const { authUserId: staffId } = await createStaff(staffEmail, 'Orders browser operator');
await createUser(nonstaffEmail);
await seedDemoData(run);
// Order progress is read the way the app reads it, with the staff member's own session.
const staffApi = new ConvexHttpClient(convexUrl, { logger: false });
const { token: staffToken } = await staffApi.action(api.session.signIn, { email: staffEmail, password });
secrets.push(staffToken);
staffApi.setAuth(staffToken);
let context: BrowserContext | undefined;
const { ready, close } = await startWorker(() => context);
const artifacts = resolve('test-results/orders');
await mkdir(artifacts, { recursive: true });
const m = en.adminOrders;
const diagnostics: string[] = [];
type Row = Record<string, string | number | null>;
/** Stored decimals without insignificant zeros, as the old SQL text compared them. */
const plain = (value: string) => value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
const stock = async (productId: string) => (await fixtures.rows<{ quantity: string }>('stock_levels', { product_id: productId }))[0]?.quantity ?? '0';
async function lines(orderId: string) { return (await staffApi.query(api.orders.detail, { orderId }))!.lines; }
async function progress(orderId: string, productId: string, fields: ('receivedQuantity' | 'outstandingQuantity' | 'cancelledQuantity')[]) {
	const line = (await lines(orderId)).find((item) => item.productId === productId)!;
	return fields.map((field) => plain(line[field])).join('|');
}
const receipts = async (where: Row) => (await fixtures.rows('inventory_events', { kind: 'receipt', ...where })).length;

async function headingClear(page: Page, heading: string) {
	await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
	await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
	const banner = await page.getByRole('banner').boundingBox();
	const title = await page.getByRole('heading', { name: heading, exact: true }).first().boundingBox();
	assert.ok(banner && title && title.y >= banner.y + banner.height - 1, 'The sticky header does not cover the page heading');
}
async function chooseProduct(page: Page, index: number, line = 0) {
	const picker = page.getByRole('combobox', { name: m.product, exact: true }).nth(line);
	await picker.click();
	const search = page.getByRole('combobox', { name: m.searchProduct, exact: true });
	await search.fill(seedProductCode(index));
	await expect(search).toHaveAttribute('data-slot', 'input-group-control');
	await fits(page);
	if (index === 0 && line === 0) await page.screenshot({ path: `${artifacts}/combobox-en-360.png` });
	await page.getByRole('option').filter({ hasText: seedProductCode(index) }).click();
	await expect(picker).toContainText(seedProductCode(index));
	await expect(picker).toBeFocused();
}

try {
	await ready();
	context = await firefox.launchPersistentContext(`${directory}/profile`, { headless: true, ignoreHTTPSErrors: false });
	context.on('page', (tab) => tab.on('pageerror', (error) => diagnostics.push(error.message)));
	const socket = await interceptConvex(context);
	const page = await context.newPage();
	page.setDefaultTimeout(30000);
	await signIn(page, origin, nonstaffEmail, password);
	await expect(page.getByText(en.admin.noAccess, { exact: false })).toBeVisible();
	await page.goto(`${origin}/en/admin/orders`);
	await expect(page.getByRole('button', { name: m.newOrder, exact: true })).toHaveCount(0);
	await page.getByRole('button', { name: en.admin.signOut, exact: true }).click();
	// Signing out returns to the login page; typing before it arrives would be reset.
	await expect(page).toHaveURL(/\/en\/admin\/login/);
	await signIn(page, origin, staffEmail, password);
	await expect(page.getByRole('heading', { name: en.admin.overview, exact: true })).toBeVisible();
	await page.goto(`${origin}/en/admin/orders`);
	await expect(page.getByRole('heading', { name: m.heading, exact: true })).toBeVisible();
	await expect(page.getByRole('link', { name: m.heading, exact: true }).first()).toBeVisible();
	await page.setViewportSize({ width: 360, height: 900 });
	await fits(page);
	await page.getByRole('button', { name: m.newOrder, exact: true }).click();
	await page.getByLabel(fieldLabel(m.supplier)).fill('Disposable parts supplier');
	await page.getByLabel(fieldLabel(m.reference)).fill('WEB-ORDER-1');
	await page.getByLabel(fieldLabel(`${m.additionalCost} (NOK)`)).fill('3.50');
	for (const viewport of [{ width: 360, height: 640 }, { width: 667, height: 375 }]) {
		await page.setViewportSize(viewport);
		await page.getByRole('combobox', { name: m.product, exact: true }).click();
		const search = page.getByRole('combobox', { name: m.searchProduct, exact: true });
		await expect(page.getByRole('option').nth(10)).toBeAttached();
		await expect(search).toBeInViewport({ ratio: 1 });
		await expect(page.locator('[data-slot="popover-content"]')).toBeInViewport({ ratio: 1 });
		if (viewport.width === 667) {
			// Simulate the keyboard shrinking only the visual viewport; the layout
			// stays 375px high and the product trigger remains behind the keyboard.
			try {
				await page.evaluate(() => {
					const visible = window.visualViewport;
					if (!visible) throw new Error('Visual viewport unavailable');
					Object.defineProperty(visible, 'height', { configurable: true, value: 86 });
					visible.dispatchEvent(new Event('resize'));
				});
				await expect.poll(() => search.evaluate(element => {
					const popup = element.closest('[data-slot="popover-content"]');
					return popup !== null && [element, popup].every(control => {
						const box = control.getBoundingClientRect();
						return box.height > 0 && box.top >= 0 && box.bottom <= 86;
					});
				})).toBe(true);
			} finally {
				await page.evaluate(() => {
					const visible = window.visualViewport!;
					Reflect.deleteProperty(visible, 'height');
					visible.dispatchEvent(new Event('resize'));
				});
			}
			await expect(search).toBeInViewport({ ratio: 1 });
		}
		await search.press('Escape');
		await fits(page);
	}
	await page.setViewportSize({ width: 360, height: 900 });
	await chooseProduct(page, 0);
	await page.getByLabel(fieldLabel(`${m.quantity} (pcs)`)).first().fill('10');
	await page.getByLabel(fieldLabel(`${m.unitCost} (NOK)`)).first().fill('1.25');
	// Choosing the first product opens line 2 without an Add line step.
	await chooseProduct(page, 29, 1);
	await page.getByLabel(fieldLabel(`${m.quantity} (m)`)).fill('1.25');
	await page.getByLabel(fieldLabel(`${m.unitCost} (NOK)`)).nth(1).fill('2.50');
	await fits(page);
	const orderSheet = page.getByRole('dialog', { name: m.newOrder, exact: true });
	await expect(orderSheet).toBeVisible();
	const nextLine = orderSheet.getByRole('combobox', { name: m.product, exact: true });
	await expect(nextLine).toHaveCount(3);
	await expect(nextLine.last()).toHaveText(m.selectProduct);
	await nextLine.last().scrollIntoViewIfNeeded();
	const nextBox = await nextLine.last().boundingBox(), footerBox = await orderSheet.locator('[data-slot="dialog-footer"]').boundingBox();
	assert.ok(nextBox && footerBox && footerBox.y >= nextBox.y + nextBox.height + 8, 'Save stays below the empty next line');
	await page.screenshot({ path: `${artifacts}/create-en-360.png` });
	const firstOrderQuantity = page.getByLabel(fieldLabel(`${m.quantity} (pcs)`)).first();
	await firstOrderQuantity.fill('0.5');
	await page.getByRole('button', { name: m.recordOrder, exact: true }).click();
	await expect(firstOrderQuantity).toHaveAttribute('aria-invalid', 'true');
	await expect(firstOrderQuantity).toBeFocused();
	await expect(orderSheet.getByText(m.invalidQuantity('1'), { exact: true })).toBeVisible();
	await firstOrderQuantity.fill('10');
	const beforeOrderStock = await stock(seedProductId(0));
	await page.getByRole('button', { name: m.recordOrder, exact: true }).click();
	await expect(page).toHaveURL(/\/en\/admin\/orders\/[0-9a-f-]{36}$/);
	const orderId = page.url().split('/').at(-1)!;
	assert.match(orderId, /^[0-9a-f-]{36}$/);
	const [order] = await fixtures.rows<Record<string, string>>('purchase_orders', { id: orderId });
	expect(`${order.supplier_name}|${order.supplier_reference}|${plain(order.additional_cost_nok)}`).toBe('Disposable parts supplier|WEB-ORDER-1|3.5');
	const orderLines = (await fixtures.rows<{ line_number: number; ordered_quantity: string; unit_cost_nok: string }>('purchase_order_lines', { order_id: orderId }))
		.sort((a, b) => a.line_number - b.line_number);
	expect(orderLines.map((line) => `${plain(line.ordered_quantity)} ${plain(line.unit_cost_nok)}`).join(', ')).toBe('10 1.25, 1.25 2.5');
	expect(await stock(seedProductId(0))).toBe(beforeOrderStock);
	console.log('PASS: English admin records an already-placed two-line order without adding stock');

	prepareZXingModule({ overrides: { wasmBinary: new Uint8Array(await Bun.file('node_modules/zxing-wasm/dist/writer/zxing_writer.wasm').arrayBuffer()) } });
	const written = await writeBarcode(`https://ampoteket.no/p/${seedProductCode(0)}`, { format: 'QRCode', options: 'ecLevel=M', addQuietZones: true, scale: 8 });
	assert.equal(written.error, '');
	await page.addInitScript((label) => {
		const camera = document.createElement('canvas'); camera.width = camera.height = 900;
		const context = camera.getContext('2d')!;
		const image = new Image(); image.src = label;
		setInterval(() => {
			context.fillStyle = 'white'; context.fillRect(0, 0, 900, 900);
			if (image.complete && image.naturalWidth) context.drawImage(image, 250, 250, 400, 400);
		}, 50);
		Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => camera.captureStream(20) });
	}, `data:image/svg+xml;base64,${Buffer.from(written.svg).toString('base64')}`);
	await page.goto(`${origin}/en/admin/orders`);
	const orderRow = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Disposable parts supplier', exact: true }) });
	await expect(orderRow.getByRole('button', { name: m.openReceipt, exact: true })).toBeVisible();
	await orderRow.getByRole('button', { name: m.openReceipt, exact: true }).click();
	await expect(page).toHaveURL(`${origin}/en/admin/orders`);
	const receive = page.getByRole('dialog', { name: new RegExp(m.openReceipt) });
	await expect(receive).toBeVisible();
	await expect(receive.getByRole('checkbox')).toHaveCount(2);
	await expect(receive.getByRole('button', { name: m.recordReceipt, exact: true })).toBeDisabled();
	await receive.getByRole('button', { name: m.scanProduct, exact: true }).click();
	const receiptLines = receive.locator('form[id$="-form"] > div');
	await expect(receiptLines.first()).toHaveClass(/ring-2/, { timeout: 20000 });
	await expect(receiptLines.nth(1)).not.toHaveClass(/ring-2/);
	await expect(receive.getByRole('checkbox').first()).not.toBeChecked();
	await expect(receive.getByRole('textbox')).toHaveCount(0);
	await receive.getByRole('button', { name: m.scanProduct, exact: true }).click();
	await expect(receiptLines.first()).not.toHaveClass(/ring-2/);
	await page.evaluate(() => Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => { throw new DOMException('Denied for receipt proof', 'NotAllowedError'); } }));
	await receive.getByRole('button', { name: m.scanProduct, exact: true }).click();
	await expect(receive.getByText(m.cameraDenied, { exact: true })).toBeVisible();
	await expect(receive.getByRole('textbox')).toHaveCount(0);
	expect(await stock(seedProductId(0))).toBe(beforeOrderStock);
	expect(await receipts({ purchase_order_id: orderId })).toBe(0);
	await receive.getByRole('button', { name: m.differentQuantity, exact: true }).first().click();
	const receivedQuantity = receive.getByLabel(fieldLabel(`${m.receivedQuantity} (pcs)`));
	await receivedQuantity.fill('0');
	await receive.getByRole('button', { name: m.recordReceipt, exact: true }).click();
	await expect(receivedQuantity).toHaveAttribute('aria-invalid', 'true');
	await expect(receivedQuantity).toBeFocused();
	await expect(receive.getByText(m.invalidQuantity('1'), { exact: true })).toBeVisible();
	await receivedQuantity.fill('11');
	await receive.getByRole('button', { name: m.recordReceipt, exact: true }).click();
	await expect(receivedQuantity).toHaveAttribute('aria-invalid', 'true');
	await expect(receivedQuantity).toBeFocused();
	await expect(receive.getByText(m.exceedsOutstanding('10', unitLabel('pcs', 'en', '10')), { exact: true })).toBeVisible();
	await receivedQuantity.fill('4');
	await fixtures.patch('purchase_orders', { id: orderId }, { supplier_name: 'Supplier updated in another tab' });
	await page.evaluate(() => window.dispatchEvent(new Event('online')));
	await expect(receive.getByText('Supplier updated in another tab', { exact: true })).toBeVisible();
	await expect(receivedQuantity).toHaveValue('4');
	await expect(receivedQuantity).toBeFocused();
	await fixtures.patch('purchase_orders', { id: orderId }, { supplier_name: 'Disposable parts supplier' });
	await page.evaluate(() => window.dispatchEvent(new Event('online')));
	await expect(receive.getByText('Disposable parts supplier', { exact: true })).toBeVisible();
	await expect(receivedQuantity).toHaveValue('4');
	console.log('PASS: planned receipt refreshes on reconnect while retaining selected quantity and focus');
	const receiptCommand = 'orders:recordReceipt';
	// The receipt commits while its response is held: the sheet stays in progress, never unknown.
	const held = socket.hold(receiptCommand);
	const confirming = receive.getByRole('button', { name: m.recordReceipt, exact: true }).click();
	try { await held.committed; await expect(receive.getByText(m.unknown, { exact: true })).toHaveCount(0); }
	finally { held.release(); }
	await confirming;
	await expect(page.getByText(m.receiptRecorded, { exact: true })).toBeVisible();
	expect(await progress(orderId, seedProductId(0), ['receivedQuantity', 'outstandingQuantity'])).toBe('4|6');
	expect(compareDecimals(await stock(seedProductId(0)), addDecimals(beforeOrderStock, '4'))).toBe(0);
	console.log('PASS: receipt camera highlights only the matched line, never selects quantity; denied camera leaves the visible checklist usable, and confirmation posts exact stock');

	// The receipt commits and its response is lost: the outcome is unknown until retried.
	const sentBefore = socket.mutations.length;
	socket.withhold(receiptCommand);
	await orderRow.getByRole('button', { name: m.openReceipt, exact: true }).click();
	await receive.getByRole('button', { name: m.differentQuantity, exact: true }).first().click();
	await receive.getByLabel(fieldLabel(`${m.receivedQuantity} (pcs)`)).fill('1');
	await receive.getByRole('button', { name: m.recordReceipt, exact: true }).click();
	await expect(receive.getByText(m.unknown, { exact: true })).toBeVisible();
	await receive.getByRole('button', { name: m.closeReceipt, exact: true }).click();
	await page.getByRole('button', { name: m.resumePending, exact: true }).click();
	await expect(receive).toBeVisible();
	await page.reload();
	await expect(receive).toBeVisible();
	await receive.getByRole('button', { name: m.retryReceipt, exact: true }).click();
	await expect(page.getByText(m.receiptRecorded, { exact: true })).toBeVisible();
	const commands = socket.sent(receiptCommand, sentBefore);
	expect(commands).toHaveLength(2);
	expect(commands[1].args).toEqual(commands[0].args);
	expect(await progress(orderId, seedProductId(0), ['receivedQuantity', 'outstandingQuantity'])).toBe('5|5');
	expect(await receipts({ purchase_order_id: orderId })).toBe(2);
	console.log('PASS: committed lost response retries the identical receipt once');

	await page.goto(`${origin}/en/admin/orders/${orderId}`);
	const cancel = page.locator('section[aria-labelledby="cancel-title"]');
	await cancel.getByRole('button', { name: m.cancelHeading, exact: true }).click();
	await cancel.locator('input').first().fill('2');
	await cancel.getByLabel(fieldLabel(m.cancelReason)).fill('Supplier short shipment');
	await cancel.getByRole('button', { name: m.cancelSelected, exact: true }).click();
	const cancellationDialog = page.getByRole('alertdialog', { name: m.cancelSelected, exact: true });
	await expect(cancellationDialog).toHaveAccessibleDescription(m.cancelConfirm);
	const confirmationBody = cancellationDialog.getByRole('region', { name: m.cancelSelected, exact: true });
	const confirmationCopy = cancellationDialog.locator('[data-slot="alert-dialog-description"]');
	const beforeConfirmationViewport = page.viewportSize()!;
	const confirmationText = await confirmationCopy.textContent();
	assert.ok(confirmationText);
	// Stress long confirmation copy without changing the command or its fixture.
	await confirmationCopy.evaluate((element, text) => { element.textContent = text.repeat(12); }, confirmationText);
	for (const viewport of [{ width: 320, height: 256 }, { width: 667, height: 375 }]) {
		await page.setViewportSize(viewport);
		await expect(cancellationDialog).toBeInViewport({ ratio: 1 });
		await cancellationDialog.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
		const fixedContent = [cancellationDialog.getByRole('heading'), cancellationDialog.getByRole('button', { name: m.cancel, exact: true }), cancellationDialog.getByRole('button', { name: m.cancelSelected, exact: true })];
		for (const control of fixedContent) await expect(control).toBeInViewport({ ratio: 1 });
		const beforeScroll = await Promise.all(fixedContent.map(control => control.boundingBox()));
		await expect(confirmationBody).toHaveAttribute('tabindex', '0');
		await expect(confirmationBody).toHaveCSS('overscroll-behavior', 'contain');
		assert.ok(await confirmationBody.evaluate(element => element.scrollHeight > element.clientHeight), 'Long confirmation copy has its own scroll region');
		await confirmationBody.evaluate(element => { element.scrollTop = 0; });
		await confirmationBody.focus();
		const documentScroll = await page.evaluate(() => window.scrollY);
		await page.keyboard.press('End');
		await expect.poll(() => confirmationBody.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
		expect(await page.evaluate(() => window.scrollY)).toBe(documentScroll);
		expect(await Promise.all(fixedContent.map(control => control.boundingBox()))).toEqual(beforeScroll);
		await fits(page);
	}
	await confirmationCopy.evaluate((element, text) => { element.textContent = text; }, confirmationText);
	await expect(cancellationDialog).toHaveAccessibleDescription(m.cancelConfirm);
	await page.setViewportSize(beforeConfirmationViewport);
	await cancellationDialog.getByRole('button', { name: m.cancelSelected, exact: true }).click();
	// The state is a badge; the same word also labels a line's cancelled quantity.
	await expect(page.locator('[data-slot="badge"]').getByText(m.cancellationRecorded, { exact: true })).toBeVisible();
	expect(await progress(orderId, seedProductId(0), ['cancelledQuantity', 'outstandingQuantity'])).toBe('2|3');
	const history = page.locator('section[aria-labelledby="cancellation-history-title"]');
	await history.getByRole('button', { name: m.reverseCancellation, exact: true }).click();
	await history.getByLabel(fieldLabel(m.reason)).fill('Supplier delivered the missing quantity');
	await history.getByRole('button', { name: m.reverseCancellation, exact: true }).last().click();
	const reversalDialog = page.getByRole('alertdialog', { name: m.reverseCancellation, exact: true });
	await expect(reversalDialog).toHaveAccessibleDescription(m.reverseConfirm);
	expect(await progress(orderId, seedProductId(0), ['cancelledQuantity'])).toBe('2');
	await reversalDialog.getByRole('button', { name: m.reverseCancellation, exact: true }).click();
	await expect(page.locator('[data-slot="badge"]').getByText(m.reversalRecorded, { exact: true })).toBeVisible();
	expect(await progress(orderId, seedProductId(0), ['cancelledQuantity', 'outstandingQuantity'])).toBe('0|5');
	const orderLineIds = new Set((await lines(orderId)).map((line) => line.id));
	expect((await fixtures.rows<{ order_line_id: string }>('purchase_order_cancellations')).filter((row) => orderLineIds.has(row.order_line_id))).toHaveLength(2);
	await page.getByRole('button', { name: m.openReceipt, exact: true }).click();
	await expect(receive.getByRole('checkbox')).toHaveCount(2);
	await receive.getByRole('button', { name: m.closeReceipt, exact: true }).click();
	await page.goto(`${origin}/en/admin/orders`);
	await orderRow.getByRole('button', { name: m.openReceipt, exact: true }).click();
	await receive.getByRole('checkbox').first().click();
	await receive.getByRole('checkbox').nth(1).click();
	const finalFrom = socket.mutations.length;
	socket.withhold(receiptCommand);
	await receive.getByRole('button', { name: m.recordReceipt, exact: true }).click();
	await expect(receive.getByText(m.unknown, { exact: true })).toBeVisible();
	await page.reload();
	await expect(receive.getByRole('checkbox')).toHaveCount(2);
	await receive.getByRole('button', { name: m.retryReceipt, exact: true }).click();
	await expect(page.getByText(m.receiptRecorded, { exact: true })).toBeVisible();
	await expect(orderRow).toContainText(m.completed);
	await expect(orderRow).not.toContainText(m.openLines(0));
	await expect(orderRow.getByRole('button', { name: m.openReceipt, exact: true })).toHaveCount(0);
	const finalCommands = socket.sent(receiptCommand, finalFrom);
	expect(finalCommands).toHaveLength(2);
	expect(finalCommands[1].args).toEqual(finalCommands[0].args);
	expect((await lines(orderId)).filter((line) => compareDecimals(line.outstandingQuantity, '0') > 0)).toHaveLength(0);
	expect(await receipts({ purchase_order_id: orderId })).toBe(3);
	console.log('PASS: partial receipts, cancellation/reversal and receive remaining quantities agree with SQL progress');

	await page.goto(`${origin}/en/admin/orders/${orderId}`);
	await page.getByRole('button', { name: m.editMetadata, exact: true }).first().click();
	const longSupplier = `Disposable supplier ${'W'.repeat(120)}`;
	const longReference = 'WEB-ORDER-1-' + 'R'.repeat(170);
	const longNote = 'Long order note for phone and desktop wrapping. '.repeat(18).trim();
	await page.getByLabel(fieldLabel(m.supplierName)).fill(longSupplier);
	await page.getByLabel(fieldLabel(m.reference)).fill(longReference);
	await page.getByLabel(fieldLabel(m.note)).fill(longNote);
	await page.getByRole('button', { name: m.saveOrderMetadata, exact: true }).click();
	await expect(page.getByText(m.metadataSaved, { exact: true })).toBeVisible();
	const [edited] = await fixtures.rows<Record<string, string>>('purchase_orders', { id: orderId });
	expect(`${edited.supplier_name}|${edited.supplier_reference}|${edited.note}`).toBe(`${longSupplier}|${longReference}|${longNote}`);
	console.log('PASS: guarded metadata PATCH updates the allowed supplier reference');
	await fits(page);
	await headingClear(page, longSupplier);
	await page.screenshot({ path: `${artifacts}/detail-en-360.png`, fullPage: true });

	await page.goto(`${origin}/en/admin/orders`);
	await page.getByRole('button', { name: m.unplannedReceipt, exact: true }).click();
	await page.getByLabel(fieldLabel(m.sourceNote)).fill('Donation from the workshop');
	await chooseProduct(page, 29);
	await page.getByLabel(fieldLabel(`${m.quantity} (m)`)).fill('0.5');
	const beforeUnplanned = await stock(seedProductId(29));
	const unplannedFrom = socket.mutations.length;
	socket.withhold(receiptCommand);
	await page.getByRole('button', { name: m.recordReceipt, exact: true }).click();
	const unplannedSheet = page.getByRole('dialog', { name: m.unplannedReceipt, exact: true });
	await expect(unplannedSheet.getByText(m.unknown, { exact: true })).toBeVisible();
	const pendingBeforeAccessFailure = await page.evaluate(() => localStorage.getItem('ampoteket:admin-order-command:v1'));
	// Membership is a live subscription: its next result (here, after a rename elsewhere) fails.
	socket.fail('members:me');
	await fixtures.patch('staff_members', { auth_user_id: staffId }, { display_name: 'Orders browser operator, renamed' });
	await expect(unplannedSheet.getByText(en.admin.accessUnavailable, { exact: true })).toBeVisible();
	// The access gate's retry and the command's retry share the words "Try again", so tell them apart by type.
	await expect(unplannedSheet.locator('button[type="submit"]').filter({ hasText: m.retryReceipt })).toBeDisabled();
	await expect(unplannedSheet.getByRole('button', { name: m.closeEntry, exact: true })).toBeEnabled();
	socket.restore('members:me');
	await unplannedSheet.locator('button[type="button"]').filter({ hasText: en.admin.retry }).click();
	await expect(unplannedSheet.getByText(en.admin.accessUnavailable, { exact: true })).toHaveCount(0);
	expect(await page.evaluate(() => localStorage.getItem('ampoteket:admin-order-command:v1'))).toBe(pendingBeforeAccessFailure);
	await unplannedSheet.getByRole('button', { name: m.closeEntry, exact: true }).click();
	await expect(unplannedSheet).toHaveCount(0);
	await page.getByRole('button', { name: m.resumePending, exact: true }).click();
	await unplannedSheet.getByRole('button', { name: m.retryReceipt, exact: true }).click();
	await expect(page.getByText(m.receiptRecorded, { exact: true })).toBeVisible();
	const unplannedCommands = socket.sent(receiptCommand, unplannedFrom);
	expect(unplannedCommands).toHaveLength(2);
	expect(unplannedCommands[1].args).toEqual(unplannedCommands[0].args);
	expect(compareDecimals(await stock(seedProductId(29)), addDecimals(beforeUnplanned, '0.5'))).toBe(0);
	expect(await receipts({ purchase_order_id: null, note: 'Donation from the workshop' })).toBe(1);
	await expect(page.getByRole('heading', { name: m.unplannedHistory, exact: true })).toBeVisible();
	await fits(page);
	await headingClear(page, m.heading);
	await page.screenshot({ path: `${artifacts}/list-en-360.png`, fullPage: true });
	for (const locale of ['nb', 'en'] as const) for (const width of [360, 1280]) {
		const prefix = locale === 'nb' ? '' : '/en';
		const messages = locale === 'nb' ? nb.adminOrders : en.adminOrders;
		await page.setViewportSize({ width, height: 900 });
		await page.goto(`${origin}${prefix}/admin/orders`);
		await expect(page.getByRole('heading', { name: messages.heading, exact: true })).toBeVisible();
		await expect(page.getByRole('link', { name: longSupplier, exact: true })).toBeVisible();
		await fits(page); await headingClear(page, messages.heading);
		await page.screenshot({ path: `${artifacts}/list-${locale}-${width}.png`, fullPage: true });
		await page.goto(`${origin}${prefix}/admin/orders/${orderId}`);
		await expect(page.getByRole('heading', { name: longSupplier, exact: true })).toBeVisible();
		await expect(page.getByText(longReference, { exact: true })).toBeVisible();
		await expect(page.getByText(longNote, { exact: true })).toBeVisible();
		await expect(page.getByText(messages.placedAt, { exact: true }).first()).toBeVisible();
		await fits(page); await headingClear(page, longSupplier);
		await page.screenshot({ path: `${artifacts}/detail-${locale}-${width}.png`, fullPage: true });
		// A completed order offers no receipt button; the sheet's complete state is still reachable by its link.
		await expect(page.getByRole('button', { name: messages.openReceipt, exact: true })).toHaveCount(0);
		await page.goto(`${origin}${prefix}/admin/orders/${orderId}?receive`);
		const receipt = page.getByRole('dialog', { name: new RegExp(messages.openReceipt) });
		const receiptBody = receipt.getByRole('region', { name: messages.openReceipt, exact: true });
		await expect(receiptBody.getByText(longSupplier, { exact: true })).toBeVisible();
		const closeReceipt = receipt.getByRole('button', { name: messages.closeReceipt, exact: true });
		for (const viewport of [{ width, height: 900 }, ...(width === 360 ? [{ width: 320, height: 256 }, { width: 667, height: 375 }] : [])]) {
			await page.setViewportSize(viewport);
			await expect(receipt.getByRole('heading')).toBeInViewport({ ratio: 1 });
			await expect(closeReceipt).toBeInViewport({ ratio: 1 });
			await expect(closeReceipt).toHaveCSS('width', '44px');
			const complete = receiptBody.getByText(messages.noOutstanding, { exact: true });
			await complete.scrollIntoViewIfNeeded();
			await expect(complete).toBeInViewport({ ratio: 1 });
			assert.ok(await receiptBody.evaluate(element => element.scrollWidth <= element.clientWidth), 'Long supplier text wraps inside the receipt body');
			await fits(page);
		}
		await page.setViewportSize({ width, height: 900 });
		await closeReceipt.click();
	}
	await page.setViewportSize({ width: 360, height: 900 });
	await page.goto(`${origin}/en/admin/orders`);
	await page.getByRole('button', { name: m.newOrder, exact: true }).click();
	const activeSupplier = `${longSupplier} (open)`;
	await page.getByLabel(fieldLabel(m.supplier)).fill(activeSupplier);
	await page.getByLabel(fieldLabel(m.reference)).fill('PRODUCT-NEW-1');
	await page.getByRole('button', { name: m.newProductFromOrder, exact: true }).click();
	const productSheet = page.getByRole('dialog', { name: en.adminProducts.newProduct, exact: true });
	await productSheet.getByRole('radio', { name: en.adminProducts.typeNames.MIS, exact: true }).click();
	await productSheet.getByLabel(fieldLabel(en.adminProducts.nameNb)).fill('Ny vare fra bestilling');
	await productSheet.getByLabel(fieldLabel(en.adminProducts.nameEn)).fill('New item from order');
	await fits(page);
	await page.screenshot({ path: `${artifacts}/new-product-sheet-en-360.png` });
	await page.setViewportSize({ width: 1280, height: 900 });
	await fits(page);
	await page.screenshot({ path: `${artifacts}/new-product-sheet-en-1280.png` });
	await productSheet.getByLabel(fieldLabel(en.adminProducts.purchaseUrl)).fill('https://example.test/new-item');
	// A new product needs a price or an explicit Free choice (the editor's rule since 3056eee).
	await productSheet.getByLabel(fieldLabel(`${en.adminProducts.price} (NOK)`)).fill('2.50');
	await productSheet.getByRole('button', { name: en.adminProducts.save, exact: true }).click();
	// Saving closes the sheet, selects the product on the line and keeps the order draft.
	await expect(productSheet).toBeHidden();
	const [{ id: newProductId, code: newProductCode }] = await fixtures.rows<{ id: string; code: string }>('products', { name_en: 'New item from order' });
	await expect(page).toHaveURL(`${origin}/en/admin/orders`);
	const linePicker = page.getByRole('combobox', { name: m.product, exact: true }).first();
	await expect(linePicker).toContainText(newProductCode);
	await expect(linePicker).toBeFocused();
	await expect(page.getByLabel(fieldLabel(m.purchaseUrl)).first()).toHaveValue('https://example.test/new-item');
	// Only the new empty line offers the plus button; a line with a product does not.
	await expect(page.getByRole('button', { name: m.newProductFromOrder, exact: true })).toHaveCount(1);
	await expect(page.getByLabel(fieldLabel(m.supplier))).toHaveValue(activeSupplier);
	await expect(page.getByLabel(fieldLabel(m.reference))).toHaveValue('PRODUCT-NEW-1');
	await page.screenshot({ path: `${artifacts}/new-product-selected-en-1280.png` });
	await page.setViewportSize({ width: 360, height: 900 });
	await page.screenshot({ path: `${artifacts}/new-product-selected-en-360.png` });
	await page.getByLabel(fieldLabel(`${m.quantity} (pcs)`)).fill('2');
	await page.getByLabel(fieldLabel(`${m.unitCost} (NOK)`)).first().fill('0.5');
	await page.getByRole('button', { name: m.recordOrder, exact: true }).click();
	await expect(page).toHaveURL(/\/en\/admin\/orders\/[0-9a-f-]{36}$/);
	expect(await fixtures.rows('purchase_order_lines', { order_id: page.url().split('/').at(-1)!, product_id: newProductId })).toHaveLength(1);
	await page.getByRole('button', { name: m.openReceipt, exact: true }).click();
	const activeReceipt = page.getByRole('dialog', { name: m.openReceipt, exact: true });
	const activeBody = activeReceipt.getByRole('region', { name: m.openReceipt, exact: true });
	await expect(activeBody.getByText(activeSupplier, { exact: true })).toBeVisible();
	for (const viewport of [{ width: 320, height: 256 }, { width: 667, height: 375 }]) {
		await page.setViewportSize(viewport);
		for (const control of [activeReceipt.getByRole('heading'), activeReceipt.getByRole('button', { name: m.closeReceipt, exact: true }), activeReceipt.getByRole('button', { name: m.recordReceipt, exact: true })]) {
			await expect(control).toBeInViewport({ ratio: 1 });
		}
		const line = activeBody.getByRole('checkbox').first();
		await line.scrollIntoViewIfNeeded();
		await expect(line).toBeInViewport({ ratio: 1 });
		await fits(page);
	}
	await activeReceipt.getByRole('button', { name: m.closeReceipt, exact: true }).click();
	console.log('PASS: New product opens the editor in a sheet; saving selects it on the line and keeps the order draft');
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.emulateMedia({ colorScheme: 'dark' });
	await page.goto(`${origin}/admin/orders`);
	await expect(page.getByRole('link', { name: longSupplier, exact: true })).toBeVisible();
	await page.getByRole('button', { name: nb.adminOrders.unplannedReceipt, exact: true }).click();
	await page.getByRole('combobox', { name: nb.adminOrders.product, exact: true }).click();
	const darkSearch = page.getByRole('combobox', { name: nb.adminOrders.searchProduct, exact: true });
	await darkSearch.fill(seedProductCode(0));
	await expect(darkSearch).toHaveAttribute('data-slot', 'input-group-control');
	await expect.poll(() => darkSearch.evaluate((input) => getComputedStyle(input.closest('[data-slot="input-group"]')!).outlineColor)).toBe('rgb(143, 187, 255)');
	await fits(page);
	await page.screenshot({ path: `${artifacts}/combobox-nb-dark-1280.png` });
	await page.emulateMedia({ colorScheme: 'light' });
	await page.goto(`${origin}/en/admin/orders`);
	await expect(page.getByRole('link', { name: longSupplier, exact: true })).toBeVisible();
	socket.fail('orders:list');
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect(page.getByText(m.unavailable, { exact: true })).toBeVisible();
	await expect(page.getByRole('link', { name: longSupplier, exact: true })).toBeVisible();
	await page.getByRole('button', { name: m.newOrder, exact: true }).click();
	await expect(page.getByRole('button', { name: m.recordOrder, exact: true })).toBeDisabled();
	socket.restore('orders:list');
	await page.getByRole('dialog', { name: m.newOrder, exact: true }).getByRole('button', { name: m.retry, exact: true }).click();
	await expect(page.getByRole('dialog', { name: m.newOrder, exact: true }).getByText(m.unavailable, { exact: true })).toHaveCount(0);
	await page.getByRole('button', { name: m.closeEntry, exact: true }).click();
	await expect(page.getByRole('link', { name: longSupplier, exact: true })).toBeVisible();
	console.log('PASS: unplanned receipt adds exact stock; long order text fits both locales and receipt controls remain reachable down to 320x256px');
	console.log('PASS: failed background list refresh preserves rows and blocks writes until contextual retry');

	// New order shows the most urgent parts as chips and all of them in a dialog: choosing adds lines with purchase links, and quantity already on order shows.
	const s = en.adminStatistics, wanted = [3, 4].map(seedProductId), extra = Array.from({ length: 12 }, (_, index) => seedProductId(index + 5)), purchaseLink = 'https://supplier.example.test/item/3';
	// These parts are counted in whole pieces, so the minimum is a multiple of their stock step.
	for (const id of [...wanted, ...extra]) await fixtures.patch('products', { id }, { is_active: true, minimum_stock: '999999' });
	await fixtures.patch('products', { id: wanted[0] }, { purchase_url: purchaseLink });
	const symbols = new Map((await fixtures.rows<{ code: string; symbol: string }>('units')).map((unit) => [unit.code, unit.symbol]));
	const rows = (await fixtures.rows<{ id: string; code: string; name_en: string; unit_code: string }>('products'))
		.filter((product) => wanted.includes(product.id)).sort((a, b) => a.code.localeCompare(b.code))
		.map((product) => [formatMeasurementText(product.name_en, 'en'), symbols.get(product.unit_code)!]);
	await page.setViewportSize({ width: 360, height: 900 });
	await page.goto(`${origin}/en/admin`);
	await page.getByRole('link', { name: s.openOrder, exact: true }).click();
	await expect(page).toHaveURL(/\/en\/admin\/orders\?new$/);
	const prefilled = page.getByRole('dialog', { name: m.newOrder, exact: true });
	const needed = prefilled.getByRole('group', { name: m.needsOrdering, exact: true });
	const pick = (name: string) => needed.getByRole('button').filter({ hasText: name });
	const showAll = needed.getByRole('button', { name: /^All \d+$/ }), all = page.getByRole('dialog', { name: m.needsOrdering, exact: true });
	await expect(needed.getByRole('button', { name: m.selectAll, exact: true })).toHaveAttribute('aria-pressed', 'false');
	// Select all, the eight most urgent parts, then the dialog trigger.
	await expect(needed.getByRole('button')).toHaveCount(10);
	await fits(page);
	await needed.scrollIntoViewIfNeeded(); await page.mouse.move(0, 0);
	await page.screenshot({ path: `${artifacts}/new-order-needed-en-360.png`, animations: 'disabled' });
	await showAll.click();
	await expect(all.getByRole('checkbox')).toHaveCount(1 + Number((await showAll.textContent())!.replace(/\D/g, '')));
	await fits(page);
	await page.screenshot({ path: `${artifacts}/new-order-all-en-360.png`, animations: 'disabled' });
	for (const [name] of rows) await all.getByRole('checkbox', { name, exact: true }).click();
	await all.getByRole('button', { name: m.doneNeeded, exact: true }).click();
	await expect(all).toHaveCount(0);
	await expect(prefilled).toBeVisible();
	await expect(showAll).toBeFocused();
	for (const [name] of rows) await expect(pick(name)).toHaveAttribute('aria-pressed', 'true');
	await expect(prefilled.getByRole('combobox', { name: m.product, exact: true })).toHaveCount(3);
	await expect(prefilled.getByLabel(fieldLabel(m.purchaseUrl)).first()).toHaveValue(purchaseLink);
	await expect(prefilled.getByRole('link', { name: m.openPurchaseUrl, exact: true })).toHaveAttribute('href', purchaseLink);
	await pick(rows[1][0]).click();
	await expect(prefilled.getByRole('combobox', { name: m.product, exact: true })).toHaveCount(2);
	await expect(pick(rows[1][0])).toHaveAttribute('aria-pressed', 'false');
	await pick(rows[1][0]).click();
	await expect(prefilled.getByRole('combobox', { name: m.product, exact: true })).toHaveCount(3);
	await fits(page);
	await page.setViewportSize({ width: 1280, height: 1600 });
	await fits(page);
	await page.screenshot({ path: `${artifacts}/new-order-ticked-en-1280.png`, animations: 'disabled' });
	await page.setViewportSize({ width: 360, height: 900 });
	await prefilled.getByLabel(fieldLabel(m.supplier)).fill('Attention supplier');
	for (const index of [0, 1]) { await prefilled.getByLabel(m.quantity, { exact: false }).nth(index).fill('5'); await prefilled.getByLabel(fieldLabel(`${m.unitCost} (NOK)`)).nth(index).fill('1'); }
	await prefilled.getByRole('button', { name: m.recordOrder, exact: true }).click();
	await expect(page).toHaveURL(/\/en\/admin\/orders\/[0-9a-f-]{36}$/);
	// An untouched placement time is taken when saving, not when the form opened.
	const [attentionOrder] = await fixtures.rows<{ placed_at: string }>('purchase_orders', { supplier_name: 'Attention supplier' });
	expect(Date.parse(attentionOrder.placed_at)).toBeGreaterThan(Date.now() - 120_000);
	await page.goto(`${origin}/en/admin/orders`);
	await page.getByRole('button', { name: m.newOrder, exact: true }).click();
	await showAll.click();
	for (const [name] of rows) await expect(all.getByRole('checkbox', { name, exact: true })).not.toBeChecked();
	for (const [, unit] of rows) await expect(all.getByText(m.onOrder(`5 ${unitLabel(unit, 'en', '5')}`), { exact: true }).first()).toBeVisible();
	await page.emulateMedia({ colorScheme: 'dark' });
	await page.mouse.move(0, 0);
	await page.screenshot({ path: `${artifacts}/new-order-all-on-order-en-dark-360.png`, animations: 'disabled' });
	await page.emulateMedia({ colorScheme: 'light' });
	// Escape closes only the dialog, not the New order sheet under it.
	await page.keyboard.press('Escape');
	await expect(all).toHaveCount(0);
	await expect(prefilled).toBeVisible();
	console.log('PASS: New order shows the most urgent parts as chips and all of them in a dialog; choosing adds and removes lines with purchase links, and quantity already on order shows');
	assert.deepEqual(diagnostics, []);
} catch (error) {
	for (const [index, tab] of (context?.pages() ?? []).entries()) await captureFailure(tab, artifacts, String(index));
	if (diagnostics.length) console.error(diagnostics.join('\n'));
	throw error;
} finally {
	await close();
}
