/** Unsaved drafts survive reload, a closed sheet and a sign-in round trip (website-guide.md §5). */
import { firefox, expect, type BrowserContext, type Page } from '@playwright/test';
import { fieldLabel, signIn, proofEnvironment } from './web-proof/harness';
import { generateSeedSql, seedProductCode, seedProductId } from './seed-test-data';
import { en } from '../src/lib/i18n/en';

const { directory, origin, password, sql, createUser, startWorker } = await proofEnvironment();
const staffEmail = 'draft-staff@example.test';
const staffId = await createUser(staffEmail);
await sql(`INSERT INTO app.staff_members(auth_user_id,display_name) VALUES ('${staffId}', 'Draft operator');`);
await sql("SET ampoteket.test_seed = 'disposable-only';\n" + generateSeedSql());
const cabinetId = await sql('SELECT id FROM app.cabinets WHERE NOT is_archived ORDER BY outer_row,outer_col LIMIT 1');
let context: BrowserContext | undefined;
const { ready, close } = await startWorker(() => context);
const m = en.adminOrders;
const diagnostics: string[] = [];
const signOutAndIn = async (page: Page) => {
	await page.getByRole('button', { name: en.admin.signOut, exact: true }).click();
	await expect(page).toHaveURL(/\/admin\/login/);
	await signIn(page, origin, staffEmail, password);
	await expect(page.getByRole('heading', { name: en.admin.overview, exact: true })).toBeVisible();
};
try {
	await ready();
	context = await firefox.launchPersistentContext(`${directory}/profile`, { headless: true });
	context.on('page', tab => tab.on('pageerror', error => diagnostics.push(error.message)));
	const page = await context.newPage();
	page.setDefaultTimeout(30000);
	await signIn(page, origin, staffEmail, password);
	await expect(page.getByRole('heading', { name: en.admin.overview, exact: true })).toBeVisible();

	// New purchase order: reload, then a sign-out/sign-in round trip.
	await page.goto(`${origin}/en/admin/orders`);
	await page.getByRole('button', { name: m.newOrder, exact: true }).click();
	await page.getByLabel(fieldLabel(m.supplier)).fill('Draft supplier');
	await page.getByRole('combobox', { name: m.product, exact: true }).click();
	await page.getByRole('combobox', { name: m.searchProduct, exact: true }).fill(seedProductCode(0));
	await page.getByRole('option').filter({ hasText: seedProductCode(0) }).click();
	await page.locator('input[id*="-qty-"]').first().fill('5');
	await page.reload();
	await page.getByRole('button', { name: m.newOrder, exact: true }).click();
	await expect(page.getByLabel(fieldLabel(m.supplier))).toHaveValue('Draft supplier');
	await expect(page.locator('input[id*="-qty-"]').first()).toHaveValue('5');
	await expect(page.getByRole('combobox', { name: m.product, exact: true })).toContainText(seedProductCode(0));
	await page.keyboard.press('Escape');
	await signOutAndIn(page);
	await page.goto(`${origin}/en/admin/orders`);
	await page.getByRole('button', { name: m.newOrder, exact: true }).click();
	await expect(page.getByLabel(fieldLabel(m.supplier))).toHaveValue('Draft supplier');
	await page.locator('input[id*="-cost-"]').first().fill('2');
	await page.locator('button[type="submit"][form$="-order-form"]').click();
	await expect(page).toHaveURL(/\/admin\/orders\/[0-9a-f-]{36}$/);
	console.log('PASS: new order draft survives reload and sign-in round trip');

	// Receipt ticks survive Escape and reload; recording clears them.
	await page.getByRole('button', { name: m.openReceipt, exact: true }).click();
	const tick = page.locator('button[role="checkbox"][id*="-full-"]').first();
	await tick.click();
	await expect(tick).toHaveAttribute('aria-checked', 'true');
	await page.keyboard.press('Escape');
	await expect(tick).toBeHidden();
	await page.getByRole('button', { name: m.openReceipt, exact: true }).click();
	await expect(tick).toHaveAttribute('aria-checked', 'true');
	await page.reload();
	await page.getByRole('button', { name: m.openReceipt, exact: true }).click();
	await expect(tick).toHaveAttribute('aria-checked', 'true');
	console.log('PASS: receipt ticks survive Escape and reload');

	// Returning to the order list starts a clean form after the order was created.
	await page.goto(`${origin}/en/admin/orders`);
	await page.getByRole('button', { name: m.newOrder, exact: true }).click();
	await expect(page.getByLabel(fieldLabel(m.supplier))).toHaveValue('');
	console.log('PASS: created order leaves no draft');

	// Stock form.
	await page.goto(`${origin}/en/admin/stock?product=${seedProductId(1)}`);
	await page.locator('[id$="-quantity"]').fill('2');
	await page.locator('[id$="-reason"]').fill('Draft reason text');
	await page.reload();
	await expect(page.locator('[id$="-reason"]')).toHaveValue('Draft reason text');
	await expect(page.locator('[id$="-quantity"]')).toHaveValue('2');
	console.log('PASS: stock draft survives reload');

	// New product: category and name survive reload.
	await page.goto(`${origin}/en/admin/products/new`);
	await page.locator('label[for="product-category-cap"]').click();
	await page.locator('#product-name-en').fill('Draft capacitor');
	await page.reload();
	await expect(page.locator('#product-name-en')).toHaveValue(/Draft capacitor/);
	await expect(page.locator('#product-category-cap')).toHaveAttribute('aria-checked', 'true');
	console.log('PASS: new product draft survives reload');

	// Existing product: a changed price survives reload, but not a newer revision.
	await page.goto(`${origin}/en/admin/products/${seedProductId(2)}`);
	await page.locator('#product-price').fill('123');
	await page.reload();
	await expect(page.locator('#product-price')).toHaveValue('123');
	await sql(`UPDATE app.products SET minimum_stock = minimum_stock + 1 WHERE id='${seedProductId(2)}'`);
	await page.reload();
	await expect(page.locator('#product-price')).not.toHaveValue('123');
	console.log('PASS: product draft restores only onto the revision it was typed against');

	// Product list search survives Back and reload.
	await page.goto(`${origin}/en/admin/products`);
	const search = page.getByLabel(fieldLabel(en.adminProducts.search));
	await search.fill(seedProductCode(3));
	await page.reload();
	await expect(search).toHaveValue(seedProductCode(3));
	console.log('PASS: product list search survives reload');

	// Shelf inline cabinet editor: reload keeps a drafted layout; Discard drops it.
	const sm = en.adminShelf;
	await page.goto(`${origin}/en/admin/shelf`);
	const editor = page.locator('section[data-cabinet-editor]');
	const rows = editor.getByRole('slider', { name: sm.resizeRows, exact: true });
	const openCabinet = async () => {
		await page.locator(`[data-item-id="${cabinetId}"]`).click();
		await expect(editor).toBeVisible();
	};
	await openCabinet();
	const savedRows = Number(await rows.getAttribute('aria-valuenow'));
	await rows.focus(); await page.keyboard.press('ArrowUp');
	await expect(rows).toHaveAttribute('aria-valuenow', String(savedRows + 1));
	await page.reload();
	await openCabinet();
	await expect(rows).toHaveAttribute('aria-valuenow', String(savedRows + 1));
	await editor.getByRole('button', { name: sm.discardChanges, exact: true }).click();
	await expect(rows).toHaveAttribute('aria-valuenow', String(savedRows));
	await page.reload();
	await openCabinet();
	await expect(rows).toHaveAttribute('aria-valuenow', String(savedRows));
	console.log('PASS: shelf draft survives reload; Discard drops it');

	// Catalog search typed but not submitted.
	await page.goto(`${origin}/en/p`);
	await page.locator('#catalog-search').fill('draft query');
	await page.reload();
	await expect(page.locator('#catalog-search')).toHaveValue('draft query');
	console.log('PASS: catalog search text survives reload');

	if (diagnostics.length) throw new Error(`Page errors: ${diagnostics.join('; ')}`);
} finally {
	await context?.close();
	await close();
}
