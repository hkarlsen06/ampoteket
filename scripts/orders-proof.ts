/** Real admin order/receipt pages against disposable Auth, PostgREST and PostgreSQL. */
import { firefox, expect, type BrowserContext, type Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prepareZXingModule, writeBarcode } from 'zxing-wasm/writer';
import { fieldLabel, signIn, fits, proofEnvironment } from './web-proof/harness';
import { generateSeedSql, seedProductCode, seedProductId } from './seed-test-data';
import { en } from '../src/lib/i18n/en';
import { nb } from '../src/lib/i18n/nb';
import { unitLabel } from '../src/lib/format';

const { directory, origin, api, password, sql, createUser, startWorker } = await proofEnvironment();
const staffEmail = 'orders-staff@example.test';
const nonstaffEmail = 'orders-nonstaff@example.test';
const staffId = await createUser(staffEmail);
await createUser(nonstaffEmail);
await sql(`INSERT INTO app.staff_members(auth_user_id,display_name) VALUES ('${staffId}', 'Orders browser operator');`);
await sql("SET ampoteket.test_seed = 'disposable-only';\n" + generateSeedSql());
let context: BrowserContext | undefined;
const { ready, close } = await startWorker(() => context);
const artifacts = resolve('test-results/orders');
await mkdir(artifacts, { recursive: true });
const m = en.adminOrders;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const diagnostics: string[] = [];

async function headingClear(page: Page, heading: string) {
	await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
	await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
	const banner = await page.getByRole('banner').boundingBox();
	const title = await page.getByRole('heading', { name: heading, exact: true }).first().boundingBox();
	assert.ok(banner && title && title.y >= banner.y + banner.height - 1, 'The sticky header does not cover the page heading');
}
async function value(statement: string) { return (await sql(statement)).trim(); }
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
	const page = await context.newPage();
	page.setDefaultTimeout(30000);
	await signIn(page, origin, nonstaffEmail, password);
	await expect(page.getByText(en.admin.noAccess, { exact: false })).toBeVisible();
	await page.goto(`${origin}/en/admin/orders`);
	await expect(page.getByRole('button', { name: m.newOrder, exact: true })).toHaveCount(0);
	await page.getByRole('button', { name: en.admin.signOut, exact: true }).click();
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
	await page.getByRole('button', { name: m.addLine, exact: true }).click();
	await chooseProduct(page, 29, 1);
	await page.getByLabel(fieldLabel(`${m.quantity} (m)`)).fill('1.25');
	await page.getByLabel(fieldLabel(`${m.unitCost} (NOK)`)).nth(1).fill('2.50');
	await fits(page);
	const orderSheet = page.getByRole('dialog', { name: m.newOrder, exact: true });
	await expect(orderSheet).toBeVisible();
	const addLine = orderSheet.getByRole('button', { name: m.addLine, exact: true });
	await addLine.scrollIntoViewIfNeeded();
	const addBox = await addLine.boundingBox(), footerBox = await orderSheet.locator('[data-slot="dialog-footer"]').boundingBox();
	assert.ok(addBox && footerBox && footerBox.y >= addBox.y + addBox.height + 8, 'Save stays below the Add line control');
	await page.screenshot({ path: `${artifacts}/create-en-360.png` });
	const firstOrderQuantity = page.getByLabel(fieldLabel(`${m.quantity} (pcs)`)).first();
	await firstOrderQuantity.fill('0.5');
	await page.getByRole('button', { name: m.recordOrder, exact: true }).click();
	await expect(firstOrderQuantity).toHaveAttribute('aria-invalid', 'true');
	await expect(firstOrderQuantity).toBeFocused();
	await expect(orderSheet.getByText(m.invalidQuantity('1'), { exact: true })).toBeVisible();
	await firstOrderQuantity.fill('10');
	const beforeOrderStock = await value(`SELECT quantity FROM app.inventory WHERE product_id=${literal(seedProductId(0))}`);
	await page.getByRole('button', { name: m.recordOrder, exact: true }).click();
	await expect(page).toHaveURL(/\/en\/admin\/orders\/[0-9a-f-]{36}$/);
	const orderId = page.url().split('/').at(-1)!;
	assert.match(orderId, /^[0-9a-f-]{36}$/);
	expect(await value(`SELECT supplier_name||'|'||supplier_reference||'|'||additional_cost_nok FROM app.purchase_orders WHERE id=${literal(orderId)}`)).toBe('Disposable parts supplier|WEB-ORDER-1|3.5');
	expect(await value(`SELECT string_agg(ordered_quantity::text||' '||unit_cost_nok::text,', ' ORDER BY line_number) FROM app.purchase_order_lines WHERE order_id=${literal(orderId)}`)).toBe('10 1.25, 1.25 2.5');
	expect(await value(`SELECT quantity FROM app.inventory WHERE product_id=${literal(seedProductId(0))}`)).toBe(beforeOrderStock);
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
	const receive = page.getByRole('dialog', { name: new RegExp(m.receiveHeading) });
	await expect(receive).toBeVisible();
	await expect(receive.getByRole('checkbox')).toHaveCount(2);
	await expect(receive.getByRole('button', { name: m.confirmReceived, exact: true })).toBeDisabled();
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
	expect(await value(`SELECT quantity FROM app.inventory WHERE product_id=${literal(seedProductId(0))}`)).toBe(beforeOrderStock);
	expect(await value(`SELECT count(*) FROM app.inventory_events WHERE kind='receipt' AND purchase_order_id=${literal(orderId)}`)).toBe('0');
	await receive.getByRole('button', { name: m.differentQuantity, exact: true }).first().click();
	const receivedQuantity = receive.getByLabel(fieldLabel(`${m.receivedQuantity} (pcs)`));
	await receivedQuantity.fill('0');
	await receive.getByRole('button', { name: m.confirmReceived, exact: true }).click();
	await expect(receivedQuantity).toHaveAttribute('aria-invalid', 'true');
	await expect(receivedQuantity).toBeFocused();
	await expect(receive.getByText(m.invalidQuantity('1'), { exact: true })).toBeVisible();
	await receivedQuantity.fill('11');
	await receive.getByRole('button', { name: m.confirmReceived, exact: true }).click();
	await expect(receivedQuantity).toHaveAttribute('aria-invalid', 'true');
	await expect(receivedQuantity).toBeFocused();
	await expect(receive.getByText(m.exceedsOutstanding('10', unitLabel('pcs', 'en', '10')), { exact: true })).toBeVisible();
	await receivedQuantity.fill('4');
	await sql(`UPDATE app.purchase_orders SET supplier_name='Supplier updated in another tab' WHERE id=${literal(orderId)}`);
	await page.evaluate(() => window.dispatchEvent(new Event('online')));
	await expect(receive.getByText('Supplier updated in another tab', { exact: true })).toBeVisible();
	await expect(receivedQuantity).toHaveValue('4');
	await expect(receivedQuantity).toBeFocused();
	await sql(`UPDATE app.purchase_orders SET supplier_name='Disposable parts supplier' WHERE id=${literal(orderId)}`);
	await page.evaluate(() => window.dispatchEvent(new Event('online')));
	await expect(receive.getByText('Disposable parts supplier', { exact: true })).toBeVisible();
	await expect(receivedQuantity).toHaveValue('4');
	console.log('PASS: planned receipt refreshes on reconnect while retaining selected quantity and focus');
	const receiptRpc = `${api.origin}/rest/v1/rpc/amp_record_receipt`;
	let releaseReceipt!: () => void;
	let requestSeen!: () => void;
	const held = new Promise<void>((resolve) => { releaseReceipt = resolve; });
	const started = new Promise<void>((resolve) => { requestSeen = resolve; });
	await page.route(receiptRpc, async (route) => {
		if (route.request().method() !== 'POST') { await route.continue(); return; }
		requestSeen(); await held; await route.continue();
	});
	const confirming = receive.getByRole('button', { name: m.confirmReceived, exact: true }).click();
	try { await started; await expect(receive.getByText(m.unknown, { exact: true })).toHaveCount(0); }
	finally { releaseReceipt(); }
	await confirming;
	await expect(page.getByText(m.receiptRecorded, { exact: true })).toBeVisible();
	await page.unroute(receiptRpc);
	expect(await value(`SELECT received_quantity||'|'||outstanding_quantity FROM app.purchase_line_progress WHERE order_id=${literal(orderId)} AND product_id=${literal(seedProductId(0))}`)).toBe('4|6');
	expect(await value(`SELECT quantity-${beforeOrderStock} FROM app.inventory WHERE product_id=${literal(seedProductId(0))}`)).toBe('4');
	console.log('PASS: receipt camera highlights only the matched line, never selects quantity; denied camera leaves the visible checklist usable, and confirmation posts exact stock');

	const commands: unknown[] = [];
	await page.route(receiptRpc, async (route) => {
		if (route.request().method() !== 'POST') { await route.continue(); return; }
		commands.push(route.request().postDataJSON());
		if (commands.length === 1) {
			const response = await route.fetch();
			expect(response.ok(), 'Receipt committed before its response was lost').toBe(true);
			await route.abort('failed');
		} else await route.continue();
	});
	await orderRow.getByRole('button', { name: m.openReceipt, exact: true }).click();
	await receive.getByRole('button', { name: m.differentQuantity, exact: true }).first().click();
	await receive.getByLabel(fieldLabel(`${m.receivedQuantity} (pcs)`)).fill('1');
	await receive.getByRole('button', { name: m.confirmReceived, exact: true }).click();
	await expect(receive.getByText(m.unknown, { exact: true })).toBeVisible();
	await receive.getByRole('button', { name: m.closeReceipt, exact: true }).click();
	await page.getByRole('button', { name: m.resumePending, exact: true }).click();
	await expect(receive).toBeVisible();
	await page.reload();
	await expect(receive).toBeVisible();
	await receive.getByRole('button', { name: m.retrySame, exact: true }).click();
	await expect(page.getByText(m.receiptRecorded, { exact: true })).toBeVisible();
	await page.unroute(receiptRpc);
	expect(commands).toHaveLength(2);
	expect(commands[1]).toEqual(commands[0]);
	expect(await value(`SELECT received_quantity||'|'||outstanding_quantity FROM app.purchase_line_progress WHERE order_id=${literal(orderId)} AND product_id=${literal(seedProductId(0))}`)).toBe('5|5');
	expect(await value(`SELECT count(*) FROM app.inventory_events WHERE kind='receipt' AND purchase_order_id=${literal(orderId)}`)).toBe('2');
	console.log('PASS: committed lost response retries the identical receipt once');

	await page.goto(`${origin}/en/admin/orders/${orderId}`);
	const cancel = page.locator('section[aria-labelledby="cancel-title"]');
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
		const fixedContent = [cancellationDialog.getByRole('heading'), cancellationDialog.getByRole('button', { name: m.keepOrder, exact: true }), cancellationDialog.getByRole('button', { name: m.cancelSelected, exact: true })];
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
	await expect(page.getByText(m.cancellationRecorded, { exact: true })).toBeVisible();
	expect(await value(`SELECT cancelled_quantity||'|'||outstanding_quantity FROM app.purchase_line_progress WHERE order_id=${literal(orderId)} AND product_id=${literal(seedProductId(0))}`)).toBe('2|3');
	const history = page.locator('section[aria-labelledby="cancellation-history-title"]');
	await history.getByRole('button', { name: m.reverseCancellation, exact: true }).click();
	await history.getByLabel(fieldLabel(m.reason)).fill('Supplier delivered the missing quantity');
	await history.getByRole('button', { name: m.reverseCancellation, exact: true }).last().click();
	await expect(page.getByText(m.reversalRecorded, { exact: true })).toBeVisible();
	expect(await value(`SELECT cancelled_quantity||'|'||outstanding_quantity FROM app.purchase_line_progress WHERE order_id=${literal(orderId)} AND product_id=${literal(seedProductId(0))}`)).toBe('0|5');
	expect(await value(`SELECT count(*) FROM app.purchase_order_cancellations c JOIN app.purchase_order_lines l ON l.id=c.order_line_id WHERE l.order_id=${literal(orderId)}`)).toBe('2');
	await page.getByRole('button', { name: m.openReceipt, exact: true }).click();
	await expect(receive.getByRole('checkbox')).toHaveCount(2);
	await receive.getByRole('button', { name: m.closeReceipt, exact: true }).click();
	await page.goto(`${origin}/en/admin/orders`);
	await orderRow.getByRole('button', { name: m.openReceipt, exact: true }).click();
	await receive.getByRole('checkbox').first().click();
	await receive.getByRole('checkbox').nth(1).click();
	const finalCommands: unknown[] = [];
	await page.route(receiptRpc, async (route) => {
		if (route.request().method() !== 'POST') { await route.continue(); return; }
		finalCommands.push(route.request().postDataJSON());
		if (finalCommands.length === 1) {
			const response = await route.fetch();
			expect(response.ok(), 'Final receipt committed before its response was lost').toBe(true);
			await route.abort('failed');
		} else await route.continue();
	});
	await receive.getByRole('button', { name: m.confirmReceived, exact: true }).click();
	await expect(receive.getByText(m.unknown, { exact: true })).toBeVisible();
	await page.reload();
	await expect(receive.getByRole('checkbox')).toHaveCount(2);
	await receive.getByRole('button', { name: m.retrySame, exact: true }).click();
	await expect(page.getByText(m.receiptRecorded, { exact: true })).toBeVisible();
	await expect(orderRow).toContainText(m.openLines(0));
	await page.unroute(receiptRpc);
	expect(finalCommands).toHaveLength(2);
	expect(finalCommands[1]).toEqual(finalCommands[0]);
	expect(await value(`SELECT count(*) FROM app.purchase_line_progress WHERE order_id=${literal(orderId)} AND outstanding_quantity>0`)).toBe('0');
	expect(await value(`SELECT count(*) FROM app.inventory_events WHERE kind='receipt' AND purchase_order_id=${literal(orderId)}`)).toBe('3');
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
	expect(await value(`SELECT supplier_name||'|'||supplier_reference||'|'||note FROM app.purchase_orders WHERE id=${literal(orderId)}`)).toBe(`${longSupplier}|${longReference}|${longNote}`);
	console.log('PASS: guarded metadata PATCH updates the allowed supplier reference');
	await fits(page);
	await headingClear(page, longSupplier);
	await page.screenshot({ path: `${artifacts}/detail-en-360.png`, fullPage: true });

	await page.goto(`${origin}/en/admin/orders`);
	await page.getByRole('button', { name: m.unplannedReceipt, exact: true }).click();
	await page.getByLabel(fieldLabel(m.sourceNote)).fill('Donation from the workshop');
	await chooseProduct(page, 29);
	await page.getByLabel(fieldLabel(`${m.quantity} (m)`)).fill('0.5');
	const beforeUnplanned = await value(`SELECT quantity FROM app.inventory WHERE product_id=${literal(seedProductId(29))}`);
	const unplannedCommands: unknown[] = [];
	await page.route(receiptRpc, async route => {
		if (route.request().method() !== 'POST') { await route.continue(); return; }
		unplannedCommands.push(route.request().postDataJSON());
		if (unplannedCommands.length === 1) { const response = await route.fetch(); expect(response.ok()).toBe(true); await route.abort('failed'); }
		else await route.continue();
	});
	await page.getByRole('button', { name: m.recordReceipt, exact: true }).click();
	const unplannedSheet = page.getByRole('dialog', { name: m.unplannedReceipt, exact: true });
	await expect(unplannedSheet.getByText(m.unknown, { exact: true })).toBeVisible();
	const pendingBeforeAccessFailure = await page.evaluate(() => localStorage.getItem('ampoteket:admin-order-command:v1'));
	const membershipRead = `${api.origin}/rest/v1/amp_staff_members*`;
	await page.route(membershipRead, route => route.abort('failed'));
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect(unplannedSheet.getByText(en.admin.unavailable, { exact: true })).toBeVisible();
	await expect(unplannedSheet.getByRole('button', { name: m.retrySame, exact: true })).toBeDisabled();
	await expect(unplannedSheet.getByRole('button', { name: m.closeEntry, exact: true })).toBeEnabled();
	await page.unroute(membershipRead);
	await unplannedSheet.getByRole('button', { name: en.admin.retry, exact: true }).click();
	await expect(unplannedSheet.getByText(en.admin.unavailable, { exact: true })).toHaveCount(0);
	expect(await page.evaluate(() => localStorage.getItem('ampoteket:admin-order-command:v1'))).toBe(pendingBeforeAccessFailure);
	await unplannedSheet.getByRole('button', { name: m.closeEntry, exact: true }).click();
	await expect(unplannedSheet).toHaveCount(0);
	await page.getByRole('button', { name: m.resumePending, exact: true }).click();
	await unplannedSheet.getByRole('button', { name: m.retrySame, exact: true }).click();
	await expect(page.getByText(m.receiptRecorded, { exact: true })).toBeVisible();
	await page.unroute(receiptRpc);
	expect(unplannedCommands).toHaveLength(2);
	expect(unplannedCommands[1]).toEqual(unplannedCommands[0]);
	expect(await value(`SELECT quantity-${beforeUnplanned}=0.5 FROM app.inventory WHERE product_id=${literal(seedProductId(29))}`)).toBe('t');
	expect(await value("SELECT count(*) FROM app.inventory_events WHERE kind='receipt' AND purchase_order_id IS NULL AND note='Donation from the workshop'")).toBe('1');
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
		await page.getByRole('button', { name: messages.openReceipt, exact: true }).click();
		const receipt = page.getByRole('dialog', { name: new RegExp(messages.receiveHeading) });
		const receiptBody = receipt.getByRole('region', { name: messages.receiveHeading, exact: true });
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
	const [productTab] = await Promise.all([
		context.waitForEvent('page'),
		page.getByRole('link', { name: m.newProductFromOrder, exact: true }).click()
	]);
	await productTab.waitForLoadState();
	await expect(productTab).toHaveURL(/\/en\/admin\/products\/new$/);
	await productTab.getByRole('radio', { name: en.adminProducts.typeNames.MIS, exact: true }).click();
	await productTab.getByLabel(fieldLabel(en.adminProducts.nameNb)).fill('Ny vare fra bestilling');
	await productTab.getByLabel(fieldLabel(en.adminProducts.nameEn)).fill('New item from order');
	await productTab.getByRole('button', { name: en.adminProducts.save, exact: true }).click();
	// Creation replaces /new with the persisted editor, so verify its durable result after navigation.
	await expect(productTab).toHaveURL(/\/en\/admin\/products\/[0-9a-f-]{36}$/);
	const newProductId = await value("SELECT id FROM app.products WHERE name_en='New item from order'");
	const newProductCode = await value(`SELECT code FROM app.products WHERE id=${literal(newProductId)}`);
	await expect(productTab).toHaveURL(`${origin}/en/admin/products/${newProductId}`);
	await expect(productTab.getByRole('heading', { name: newProductCode, exact: true })).toBeVisible();
	await expect(productTab.getByLabel(fieldLabel(en.adminProducts.nameEn))).toHaveValue('New item from order');
	await productTab.close();
	await page.bringToFront();
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect(page.getByLabel(fieldLabel(m.supplier))).toHaveValue(activeSupplier);
	await expect(page.getByLabel(fieldLabel(m.reference))).toHaveValue('PRODUCT-NEW-1');
	await page.getByRole('combobox', { name: m.product, exact: true }).click();
	await page.getByRole('combobox', { name: m.searchProduct, exact: true }).fill(newProductCode);
	await page.getByRole('option').filter({ hasText: newProductCode }).click();
	await page.getByLabel(fieldLabel(`${m.quantity} (pcs)`)).fill('2');
	await page.getByLabel(fieldLabel(`${m.unitCost} (NOK)`)).fill('0.5');
	await page.getByRole('button', { name: m.recordOrder, exact: true }).click();
	await expect(page).toHaveURL(/\/en\/admin\/orders\/[0-9a-f-]{36}$/);
	expect(await value(`SELECT count(*) FROM app.purchase_order_lines WHERE order_id=${literal(page.url().split('/').at(-1)!)} AND product_id=${literal(newProductId)}`)).toBe('1');
	await page.getByRole('button', { name: m.openReceipt, exact: true }).click();
	const activeReceipt = page.getByRole('dialog', { name: m.receiveHeading, exact: true });
	const activeBody = activeReceipt.getByRole('region', { name: m.receiveHeading, exact: true });
	await expect(activeBody.getByText(activeSupplier, { exact: true })).toBeVisible();
	for (const viewport of [{ width: 320, height: 256 }, { width: 667, height: 375 }]) {
		await page.setViewportSize(viewport);
		for (const control of [activeReceipt.getByRole('heading'), activeReceipt.getByRole('button', { name: m.closeReceipt, exact: true }), activeReceipt.getByRole('button', { name: m.confirmReceived, exact: true })]) {
			await expect(control).toBeInViewport({ ratio: 1 });
		}
		const line = activeBody.getByRole('checkbox').first();
		await line.scrollIntoViewIfNeeded();
		await expect(line).toBeInViewport({ ratio: 1 });
		await fits(page);
	}
	await activeReceipt.getByRole('button', { name: m.closeReceipt, exact: true }).click();
	console.log('PASS: New product opens the existing editor; the order draft survives and can use the created product');
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
	const ordersRead = `${api.origin}/rest/v1/amp_purchase_orders*`;
	await page.route(ordersRead, (route) => route.abort('failed'));
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect(page.getByText(m.unavailable, { exact: true })).toBeVisible();
	await expect(page.getByRole('link', { name: longSupplier, exact: true })).toBeVisible();
	await page.getByRole('button', { name: m.newOrder, exact: true }).click();
	await expect(page.getByRole('button', { name: m.recordOrder, exact: true })).toBeDisabled();
	await page.unroute(ordersRead);
	await page.getByRole('dialog', { name: m.newOrder, exact: true }).getByRole('button', { name: m.retry, exact: true }).click();
	await expect(page.getByRole('dialog', { name: m.newOrder, exact: true }).getByText(m.unavailable, { exact: true })).toHaveCount(0);
	await page.getByRole('button', { name: m.closeEntry, exact: true }).click();
	await expect(page.getByRole('link', { name: longSupplier, exact: true })).toBeVisible();
	console.log('PASS: unplanned receipt adds exact stock; long order text fits both locales and receipt controls remain reachable down to 320x256px');
	console.log('PASS: failed background list refresh preserves rows and blocks writes until contextual retry');

	// Needs-attention sheet: pick parts, prefill New order with purchase links, then skip what is already on order.
	const s = en.adminStatistics, wanted = [3, 4].map(seedProductId), purchaseLink = 'https://supplier.example.test/item/3';
	await sql(`UPDATE app.products SET is_active=true, minimum_stock=999999 WHERE id IN (${wanted.map(literal).join(',')});
		UPDATE app.products SET purchase_url=${literal(purchaseLink)} WHERE id=${literal(wanted[0])};`);
	const rows = (await value(`SELECT string_agg(p.code||'~'||u.symbol, '|' ORDER BY p.code) FROM app.products p JOIN app.units u ON u.code=p.unit_code WHERE p.id IN (${wanted.map(literal).join(',')})`)).split('|').map((row) => row.split('~'));
	await page.setViewportSize({ width: 360, height: 900 });
	await page.goto(`${origin}/en/admin`);
	await page.getByRole('button', { name: s.openOrder, exact: true }).click();
	const pickSheet = page.getByRole('dialog', { name: s.orderHeading, exact: true });
	const selectAll = pickSheet.getByRole('checkbox', { name: s.selectAll, exact: true });
	const pick = (code: string) => pickSheet.locator('[data-slot="field"]').filter({ hasText: code }).getByRole('checkbox');
	await expect(selectAll).toBeVisible();
	await fits(page);
	await page.screenshot({ path: `${artifacts}/attention-order-en-360.png` });
	if (await selectAll.isChecked()) await selectAll.click(); else { await selectAll.click(); await selectAll.click(); }
	for (const [code] of rows) await pick(code).click();
	await pickSheet.getByRole('button', { name: s.startOrder(2), exact: true }).click();
	await expect(page).toHaveURL(/\/en\/admin\/orders\?new=/);
	const prefilled = page.getByRole('dialog', { name: m.newOrder, exact: true });
	await expect(prefilled.getByRole('combobox', { name: m.product, exact: true })).toHaveCount(2);
	await expect(prefilled.getByLabel(fieldLabel(m.purchaseUrl)).first()).toHaveValue(purchaseLink);
	await expect(prefilled.getByRole('link', { name: m.openPurchaseUrl, exact: true })).toHaveAttribute('href', purchaseLink);
	await fits(page);
	await prefilled.getByLabel(fieldLabel(m.supplier)).fill('Attention supplier');
	for (const index of [0, 1]) { await prefilled.getByLabel(m.quantity, { exact: false }).nth(index).fill('5'); await prefilled.getByLabel(fieldLabel(`${m.unitCost} (NOK)`)).nth(index).fill('1'); }
	await prefilled.getByRole('button', { name: m.recordOrder, exact: true }).click();
	await expect(page).toHaveURL(/\/en\/admin\/orders\/[0-9a-f-]{36}$/);
	// An untouched placement time is taken when saving, not when the form opened.
	expect(await value(`SELECT placed_at > now() - interval '2 minutes' FROM app.purchase_orders WHERE supplier_name='Attention supplier'`)).toBe('t');
	await page.goto(`${origin}/en/admin`);
	await page.getByRole('button', { name: s.openOrder, exact: true }).click();
	for (const [code] of rows) await expect(pick(code)).not.toBeChecked();
	await page.emulateMedia({ colorScheme: 'dark' });
	await page.screenshot({ path: `${artifacts}/attention-order-on-order-en-dark-360.png` });
	await page.emulateMedia({ colorScheme: 'light' });
	for (const [, unit] of rows) await expect(pickSheet.getByText(s.onOrder(`5 ${unitLabel(unit, 'en', '5')}`), { exact: true }).first()).toBeVisible();
	console.log('PASS: needs-attention sheet lists every attention part, prefills New order with purchase links, and leaves parts already on order unchecked');
	assert.deepEqual(diagnostics, []);
} finally {
	await close();
}
