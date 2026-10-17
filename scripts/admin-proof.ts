/** Actual pages and gateway, disposable Convex backend and Auth, trusted HTTPS and real browser storage. */
import { firefox, expect as baseExpect, type BrowserContext, type Page, type Locator } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { ConvexHttpClient } from 'convex/browser';
import { ConvexError } from 'convex/values';
import { api } from '../convex/_generated/api';
import { fieldLabel, signIn, fits, captureFailure, proofEnvironment } from './web-proof/harness';
import { convexSocket } from './web-proof/convex-faults';
import { seedDemoData, seedProductId } from './seed-test-data';
import { en } from '../src/lib/i18n/en';
import { nb } from '../src/lib/i18n/nb';
import { productTypes } from '../src/lib/admin-products';
import { standardSpecifications } from '../src/lib/product-specifications';
import { currencySymbol, formatMeasurement, measurementInput } from '../src/lib/format';

const { directory, origin, convexUrl, password, secrets, run, fixtures, createStaff, createUser, startWorker } = await proofEnvironment();
// Pages boot their live Convex subscriptions after sign-in, which on a shared runner can exceed the default 5 s.
const expect = baseExpect.configure({ timeout: 15_000 });
const staffEmail = 'admin-staff@example.test';
const nonstaffEmail = 'admin-nonstaff@example.test';
const { authUserId: staffId } = await createStaff(staffEmail, 'Browser operator');
await createUser(nonstaffEmail);
const otherEmail = 'admin-other@example.test';
const { authUserId: otherId } = await createStaff(otherEmail, 'Other operator');
// Someone who edits a product while the change log is open (created now, so only that edit is new there).
const auditEmail = 'admin-audit@example.test', auditName = 'Audit proof operator';
await createStaff(auditEmail, auditName);
let context: BrowserContext | undefined;
const { ready, close } = await startWorker(() => context);
const artifacts = resolve('test-results/admin');
await mkdir(artifacts, { recursive: true });

// Fixture reads replace the SQL of the Supabase proof; rows carry their schema types.
type ProductRow = { id: string; code: string; name_en: string; category_id: string | null; bin_id: string | null; is_active: boolean;
  description: string | null; sale_unit_price_nok: string | null; stock_step: string; metadata_revision: number };
type BinRow = { id: string; cabinet_id: string | null; inner_row: number; inner_col: number; row_span: number; col_span: number; label: string | null; is_archived: boolean };
type AttributeRow = { number_value: string | null; number_max: string | null; text_value: string | null; boolean_value: boolean | null };
/** Fixture reads scan whole tables; on a busy machine one can outlast Convex's 1 s query limit, so retry those. */
async function rows<T extends Record<string, unknown> = Record<string, unknown>>(table: string, where?: Record<string, unknown>): Promise<T[]> {
  for (let attempt = 0; ; attempt++) {
    try { return await fixtures.rows<T>(table, where); }
    catch (error) { if (attempt >= 4 || !/timed out/.test(String(error))) throw error; }
  }
}
const countRows = async (table: string, where?: Record<string, unknown>) => (await rows(table, where)).length;
async function one<T extends Record<string, unknown>>(table: string, where: Record<string, unknown>): Promise<T> {
  const found = await rows<T>(table, where);
  assert.equal(found.length, 1, `Exactly one ${table} row matches ${JSON.stringify(where)}`);
  return found[0];
}
const product = (id: string) => one<ProductRow>('products', { id });
const definitionId = async (code: string) => (await one<{ id: string }>('attribute_definitions', { code })).id;
const attribute = (productId: string, attributeId: string) => one<AttributeRow>('product_attributes', { product_id: productId, attribute_id: attributeId });
const quantity = async (productId: string) => (await one<{ quantity: string }>('stock_levels', { product_id: productId })).quantity;
const timestamp = () => new Date().toISOString().replace('Z', '000Z');
/** Another person's metadata edit: a new revision, as products.save records it (fixtures bypass the audit). */
async function editProduct(id: string, changes: Partial<ProductRow>) {
  const current = await product(id);
  await fixtures.patch('products', { id }, { ...changes, metadata_revision: current.metadata_revision + 1, updated_at: timestamp() });
}
const bin = (id: string) => one<BinRow>('bins', { id });
const binAt = async (cabinet: string, row: number, col: number) => (await one<BinRow>('bins', { cabinet_id: cabinet, inner_row: row, inner_col: col, is_archived: false })).id;
const byId = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
/** A separate session for work another tab or person does meanwhile (the native Convex client, as the app uses). */
async function signedInClient(email: string) {
  const client = new ConvexHttpClient(convexUrl, { logger: false });
  const tokens = await client.action(api.session.signIn, { email, password });
  secrets.push(tokens.token, tokens.refreshToken);
  client.setAuth(tokens.token);
  return client;
}
/** A metadata edit through the real staff API, as another person's open editor would save it. */
async function describeProduct(client: ConvexHttpClient, id: string, description: string) {
  const current = await client.query(api.products.get, { id });
  assert.ok(current, 'Product exists');
  const { metadata_revision, created_at, ...payload } = current;
  await client.mutation(api.products.save, { revision: metadata_revision, payload: { ...payload, description } });
}
const rejectionCode = (error: unknown) => error instanceof ConvexError ? (error.data as { code?: string }).code : String(error);
const diagnostics: string[] = [];
let socket!: Awaited<ReturnType<typeof convexSocket>>;
// Specification fields are labelled by their translated name, with the unit in an
// sr-only span. Svelte trims the space before it, so match the accessible name
// (which spaces the positioned span) rather than the label's raw text.
function specInput(scope: Locator, name: string, choice = false) {
  return scope.getByRole(choice ? 'combobox' : 'textbox', { name, exact: true });
}
function specField(scope: Locator, code: string, messages: typeof en = en) {
  const definition = standardSpecifications.find(field => field.code === code)!;
  const label = messages.specificationLabels[definition.code];
  return specInput(scope, definition.canonical_unit ? `${label} (${definition.canonical_unit})` : label, definition.value_type === 'boolean');
}
async function chooseDrawer(scope: Locator, binId: string) {
  const cabinetId = (await bin(binId)).cabinet_id;
  const drawer = scope.locator(`[data-item-id="${binId}"]`);
  // The picker zooms into one cabinet at a time; return to the wall when another is open.
  if (!await drawer.count()) {
    const wall = scope.getByRole('button', { name: new RegExp(`^(${nb.shelfMap.showWall}|${en.shelfMap.showWall})$`) });
    if (await wall.count()) await wall.click();
    await scope.locator(`[data-item-id="${cabinetId}"]`).click();
  }
  await drawer.click();
  await expect(drawer).toHaveAttribute('aria-current', 'true');
}
// The shelf page zooms into one cabinet at a time; return to the wall first.
async function openShelfCabinet(page: Page, address: string) {
  const wall = page.getByRole('button', { name: new RegExp(`^(${nb.shelfMap.showWall}|${en.shelfMap.showWall})$`) });
  await expect(async () => {
    if (await wall.count()) await wall.click({ timeout: 5000 });
    // The admin wall names each cabinet by its address, then how many drawers have products.
    await page.locator('[data-shelf-wall]').getByRole('button', { name: new RegExp(`^${address}( · |$)`) }).click({ timeout: 5000 });
  }).toPass({ timeout: 30_000 });
  // Geometry is measured after the zoom settles, not mid-scale.
  await expect(page.locator('[data-cabinet-editor]')).toBeVisible();
  await expect.poll(() => page.locator('[data-shelf-stage]').evaluate(stage => stage.getAnimations({ subtree: true }).length)).toBe(0);
}
async function chooseLayoutDrawer(scope: Locator, binId: string) {
  const drawer = scope.locator(`[data-item-id="${binId}"]`);
  await drawer.click();
  await expect(drawer).toHaveAttribute('aria-pressed', 'true');
}
/**
 * The first `path` mutation commits on the backend, but its reply is lost: the
 * page sees an unknown outcome. With `holdRetry`, the reply to the next attempt
 * waits for `release()`. `commands` are the argument lists sent from here on.
 */
async function lostResponse(path: string, action: () => Promise<void>, holdRetry = false) {
  const start = socket.sent(path).length;
  const lost = socket.lose(path);
  await action();
  await expect.poll(() => lost.sent.length, { message: `${path} was sent` }).toBe(1);
  lost.stop();
  const held = holdRetry ? socket.hold(path) : null;
  return { get commands() { return socket.sent(path).slice(start); }, release: () => held?.release() };
}
try {
  await ready();
  context = await firefox.launchPersistentContext(`${directory}/profile`, { headless: true, ignoreHTTPSErrors: false });
  socket = await convexSocket(context, convexUrl);
  context.on('page', (tab) => tab.on('pageerror', (error) => diagnostics.push(error.message)));
  const page = await context.newPage();
  await signIn(page, origin, nonstaffEmail, password);
  await expect(page.getByText(en.admin.noAccess, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await signIn(page, origin, staffEmail, password);
  await expect(page.getByRole('heading', { name: en.admin.overview, exact: true })).toBeVisible();
  expect(await countRows('cabinets', { is_archived: false })).toBe(12);
  expect(await countRows('bins', { is_archived: false })).toBe(492);
  const m = en.adminProducts;
  // Standard choices work before any categories or catalog fixtures exist.
  expect(await countRows('categories')).toBe(0);
  await page.goto(`${origin}/en/admin/products/new`);
  // A new product picks its category on cards; a saved one changes it in a select.
  const categoryPicker = page.getByRole('combobox', { name: m.category, exact: true });
  const categoryCard = (name: string) => page.getByRole('radiogroup', { name: m.category, exact: true }).getByRole('radio', { name, exact: true });
  for (const type of productTypes) await expect(categoryCard(m.typeNames[type.prefix])).toBeEnabled();
  await expect(page.getByRole('radiogroup', { name: m.category, exact: true }).getByRole('radio')).toHaveCount(productTypes.length);
  await expect(page.getByRole('combobox', { name: 'Code family', exact: true })).toHaveCount(0);
  // Names follow the category's shorthand, so the rest of the form grows in only after a category.
  await expect(page.getByLabel(fieldLabel(m.nameNb))).toHaveCount(0);
  await expect(page.getByRole('button', { name: m.save, exact: true })).toHaveCount(0);
  await categoryCard(m.typeNames.MIS).click();
  await page.getByLabel(fieldLabel(m.nameNb)).fill('Diverse del for nettlesertest');
  await page.getByLabel(fieldLabel(m.nameEn)).fill('Miscellaneous browser test part');
  // A membership read failure must block writes without remounting this draft.
  // Membership is a live subscription: its next update (a renamed member) fails.
  const draftGeometry = await page.locator('#product-name-en').boundingBox();
  const membershipRead = socket.failReads('members:me');
  await fixtures.patch('staff_members', { auth_user_id: staffId }, { display_name: 'Browser operator (renamed)' });
  await expect(page.getByText(en.admin.accessUnavailable, { exact: true })).toBeVisible();
  await expect(page.locator('#product-name-en')).toHaveValue('Miscellaneous browser test part');
  expect(await page.locator('#product-name-en').evaluate(element => Boolean(element.closest('[inert]')))).toBe(true);
  expect(await page.locator('#product-name-en').boundingBox()).toEqual(draftGeometry);
  await page.locator('#product-name-en').evaluate(element => (element as HTMLInputElement).form!.requestSubmit());
  expect(await countRows('products')).toBe(0);
  membershipRead.stop();
  await page.getByRole('button', { name: en.admin.retry, exact: true }).click();
  await expect(page.getByLabel(fieldLabel(m.nameEn))).toHaveValue('Miscellaneous browser test part');
  await fixtures.patch('staff_members', { auth_user_id: staffId }, { display_name: 'Browser operator' });
  // A forgotten price is a field error, never a free product.
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.priceRequired, { exact: true })).toBeVisible();
  await expect(page.getByLabel(fieldLabel(`${m.price} (NOK)`))).toBeFocused();
  expect(await countRows('products')).toBe(0);
  await page.getByLabel(fieldLabel(`${m.price} (NOK)`)).fill('0.0000001');
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.invalidPrice, { exact: true })).toBeVisible();
  await expect(page.getByLabel(fieldLabel(`${m.price} (NOK)`))).toBeFocused();
  await expect(page.getByLabel(fieldLabel(`${m.price} (NOK)`))).toHaveAttribute('aria-invalid', 'true');
  expect(await countRows('products')).toBe(0);
  await page.getByRole('switch', { name: m.freeLabel, exact: true }).check();
  await expect(page.getByLabel(fieldLabel(`${m.price} (NOK)`))).toHaveCount(0);
  console.log('PASS: temporary access-check failure preserves draft and blocks writes; missing and invalid prices identify and focus their field; Free hides the amount');
  // The standard category is created in the product's own transaction, so a lost
  // reply leaves both saved or neither; here the transaction committed.
  const categoryCreated = await lostResponse('products:save', () => page.getByRole('button', { name: m.save, exact: true }).click());
  await expect(page.getByText(m.unknown, { exact: true })).toBeVisible();
  expect(await countRows('products')).toBe(1);
  const frozen = await page.evaluate(() => JSON.parse(sessionStorage.getItem('ampoteket:admin-product:v1')!));
  expect(frozen.payload.code).toMatch(/^MIS-[A-F0-9]{5}$/);
  await page.reload();
  await page.getByRole('button', { name: m.retrySave, exact: true }).click();
  await expect(page).toHaveURL(`${origin}/en/admin/products/${frozen.payload.id}`);
  await page.reload();
  await expect(page.getByLabel(fieldLabel(m.nameEn))).toHaveValue('Miscellaneous browser test part');
  // Retry Save replays the identical command, which the backend answers without writing again.
  expect(categoryCreated.commands).toHaveLength(2);
  expect(categoryCreated.commands[1]).toBe(categoryCreated.commands[0]);
  expect(await countRows('products')).toBe(1);
  expect(await countRows('categories', { name: 'Miscellaneous' })).toBe(1);
  expect((await product(frozen.payload.id)).category_id).toBe(frozen.payload.category_id);
  await page.goto(`${origin}/en/admin/products/${frozen.payload.id}`);
  expect(await countRows('attribute_definitions')).toBe(0);
  const freshSpecs = page.locator('.specifications');
  const currentDefinition = standardSpecifications.find(definition => definition.code === 'current')!;
  await specField(freshSpecs, 'current').fill('0.02');
  // A standard specification's definition is created in its first value's own transaction.
  const definitionCreated = await lostResponse('products:setAttribute', () => page.getByRole('button', { name: m.save, exact: true }).click());
  await expect(freshSpecs.getByText(m.unknown, { exact: true })).toBeVisible();
  await expect(page.getByText(m.specificationsNotSaved, { exact: true })).toBeVisible();
  expect(await countRows('product_attributes')).toBe(1);
  await page.reload();
  // Number fields show stored values in engineering units (0.02 A reads 20 mA).
  // The frozen attempt locks its field and is resolved by the next Save.
  await expect(specField(freshSpecs, 'current')).toHaveValue(measurementInput('0.02', 'A', 'en'));
  await expect(specField(freshSpecs, 'current')).toBeDisabled();
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  expect(definitionCreated.commands).toHaveLength(2);
  expect(definitionCreated.commands[1]).toBe(definitionCreated.commands[0]);
  expect(await countRows('attribute_definitions')).toBe(1);
  expect((await attribute(frozen.payload.id, currentDefinition.id)).number_value).toBe('0.02');
  console.log('PASS: predefined specifications without definition rows and lost first-definition response recovery');
  await categoryPicker.selectOption({ label: m.typeNames.BJT });
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  expect((await product(frozen.payload.id)).code).toBe(frozen.payload.code);
  expect((await one<{ name: string }>('categories', { id: (await product(frozen.payload.id)).category_id })).name).toBe('Bipolar transistors');
  const legacyId = crypto.randomUUID();
  await fixtures.insert('categories', [{ id: legacyId, name: 'Legacy parts' }]);
  await editProduct(frozen.payload.id, { category_id: legacyId });
  await page.goto(`${origin}/en/admin/products/${frozen.payload.id}`);
  await expect(categoryPicker).toHaveValue(legacyId);
  await expect(page.getByRole('switch', { name: m.freeLabel, exact: true })).toBeChecked();
  await page.getByRole('switch', { name: m.freeLabel, exact: true }).uncheck();
  await page.getByLabel(fieldLabel(`${m.price} (NOK)`)).fill('2');
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  expect((await product(frozen.payload.id)).category_id).toBe(legacyId);
  await categoryPicker.selectOption({ label: m.typeNames.MIS });
  await categoryPicker.selectOption(legacyId); // An unsaved selection can be undone.
  await editProduct(frozen.payload.id, { category_id: null });
  await page.reload();
  await expect(categoryPicker).toHaveValue('');
  await page.getByLabel(fieldLabel(`${m.price} (NOK)`)).fill('3');
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  expect(await product(frozen.payload.id)).toMatchObject({ category_id: null, code: frozen.payload.code });
  console.log('PASS: standard categories in empty database, automatic MIS prefix, lost category reply recovery, immutable codes and legacy/uncategorized preservation');
  await seedDemoData(run);
  expect(await countRows('cabinets', { is_archived: false })).toBe(12);
  expect(await countRows('bins', { is_archived: false })).toBe(492);
  // A definite rejection ends the frozen attempt. The same unsaved UUID can
  // then choose another category and must receive that category's prefix.
  const resumedId = crypto.randomUUID();
  const resistorCategoryId = (await one<{ id: string }>('categories', { name: 'Resistors' })).id;
  const rejectedDraft = { userId: staffId, revision: null, payload: { id: resumedId, code: 'RES-A3F09', name_nb: 'Gjenopprettet utkast', name_en: 'Recovered draft', description: null, category_id: resistorCategoryId, bin_id: null, unit_code: 'missing_unit', stock_step: '1', sale_step: '1', sale_unit_price_nok: '0', minimum_stock: '0', datasheet_url: null, is_active: false } };
  await page.evaluate(command => sessionStorage.setItem('ampoteket:admin-product:v1', JSON.stringify(command)), rejectedDraft);
  await page.goto(`${origin}/en/admin/products/${resumedId}`);
  await page.getByRole('button', { name: m.retrySave, exact: true }).click();
  await expect(page.getByText(m.failed, { exact: true })).toBeVisible();
  await page.getByRole('group', { name: m.unit, exact: true }).getByRole('radio', { name: 'pcs', exact: true }).click();
  await categoryCard(m.typeNames.MIS).click();
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  expect((await product(resumedId)).code).toMatch(/^MIS-[A-F0-9]{5}$/);
  console.log('PASS: rejected resumed creation changes prefix with category while retaining product UUID');
  const longName = 'Browser acceptance resistor with a deliberately long descriptive name for a narrow phone screen';
  const binId = (await rows<BinRow>('bins', { is_archived: false })).sort(byId)[0].id;
  await page.goto(`${origin}/en/admin/products`);
  await expect(page.getByLabel(fieldLabel(m.search))).toBeEnabled();
  const references = page.getByRole('region', { name: m.referenceRecovery, exact: true });
  await expect(references).toHaveCount(0);
  // A setup attempt saved by the previous UI can still finish unchanged.
  const legacyDefinitionId = crypto.randomUUID();
  await page.evaluate(command => sessionStorage.setItem('ampoteket:admin-product-detail:v1:references', JSON.stringify(command)), { userId: staffId, kind: 'definition', before: null, after: { id: legacyDefinitionId, code: 'browser_test_voltage', label: 'Browser test voltage', value_type: 'number', canonical_unit: 'V' } });
  await page.reload();
  await expect(references.getByRole('heading', { name: m.referenceRecovery, exact: true })).toBeVisible();
  await expect(references.getByRole('button', { name: m.newDefinition, exact: true })).toHaveCount(0);
  await references.getByRole('button', { name: m.retrySave, exact: true }).click();
  await expect(references.getByText(m.referenceSaved, { exact: true })).toBeVisible();
  expect((await one<{ canonical_unit: string | null }>('attribute_definitions', { code: 'browser_test_voltage' })).canonical_unit).toBe('V');
  await page.getByRole('link', { name: m.newProduct, exact: true }).click();
  await categoryCard(m.typeNames.CAP).click();
  await page.getByLabel(fieldLabel(m.nameNb)).fill('Motstand for nettlesertest med langt navn på en smal mobilskjerm');
  await page.getByLabel(fieldLabel(m.nameEn)).fill(longName);
  await page.getByLabel(fieldLabel(`${m.price} (NOK)`)).fill('999999999998.999999');
  await chooseDrawer(page.getByRole('group', { name: m.placement, exact: true }), binId);
  await page.getByRole('switch', { name: m.activeLabel, exact: true }).check();
  const draftSpecs = page.locator('.specifications');
  const draftSpecIds = { numeric: await definitionId('capacitance'), boolean: await definitionId('polarised'), text: await definitionId('package') };
  await specField(draftSpecs, 'capacitance').fill('0.000000000005');
  await specField(draftSpecs, 'polarised').selectOption('false');
  await specField(draftSpecs, 'package').fill('Radial');
  const created = await lostResponse('products:save', () => page.getByRole('button', { name: m.save, exact: true }).click());
  await expect(page.getByText(m.unknown, { exact: true })).toBeVisible();
  const createdBody = JSON.parse(created.commands[0])[0].payload;
  const productId: string = createdBody.id;
  expect(createdBody.code).toMatch(/^CAP-[A-F0-9]{5}$/);
  await page.reload();
  await page.getByRole('button', { name: m.retrySave, exact: true }).click();
  await expect(page).toHaveURL(`${origin}/en/admin/products/${productId}`);
  // The specifications ride in the creation command, so its identical replay is the only retry.
  expect(created.commands).toHaveLength(2);
  expect(created.commands[1]).toBe(created.commands[0]);
  expect(await countRows('products', { id: productId })).toBe(1);
  expect((await product(productId)).sale_unit_price_nok).toBe('999999999998.999999');
  expect((await attribute(productId, draftSpecIds.numeric)).number_value).toBe('0.000000000005');
  expect((await attribute(productId, draftSpecIds.boolean)).boolean_value).toBe(false);
  expect((await attribute(productId, draftSpecIds.text)).text_value).toBe('Radial');
  console.log('PASS: numeric, false boolean and text specifications staged before product creation survive lost response and reload');

  await page.goto(`${origin}/en/admin/products/${productId}`);
  await expect(page.getByLabel(fieldLabel(`${m.price} (NOK)`))).toHaveValue('999999999998.999999');
  const savedUnitItem = page.getByRole('group', { name: m.unit, exact: true }).getByRole('radio', { checked: true });
  await expect(savedUnitItem).toBeDisabled();
  const savedUnit = (await savedUnitItem.textContent())!.trim();
  await expect(page.getByLabel(fieldLabel(`${m.stockStep} (${savedUnit})`))).toBeDisabled();

  await expect(page.getByRole('heading', { level: 1, name: createdBody.code, exact: true })).toBeVisible();
  await expect(page.locator('[aria-current="page"]').filter({ hasText: createdBody.code })).toBeVisible();
  await expect(page.getByRole('link', { name: m.back, exact: true })).toHaveCount(0);
  const placement = page.getByRole('group', { name: m.placement, exact: true });
  const otherBinId = (await rows<BinRow>('bins', { cabinet_id: (await bin(binId)).cabinet_id })).filter(row => row.id !== binId).sort(byId)[0].id;
  const originalDrawer = placement.locator(`[data-item-id="${binId}"]`);
  const targetDrawer = placement.locator(`[data-item-id="${otherBinId}"]`);
  const moveDialog = page.getByRole('alertdialog', { name: m.moveTitle, exact: true });
  await page.getByRole('button', { name: m.clearPlacement, exact: true }).click();
  await chooseDrawer(placement, binId);
  await expect(originalDrawer).toHaveAttribute('aria-current', 'true');
  await originalDrawer.click();
  await expect(moveDialog).toHaveCount(0);
  await targetDrawer.click();
  await expect(moveDialog.getByRole('button', { name: m.cancelMove, exact: true })).toBeFocused();
  await expect(originalDrawer).toHaveAttribute('aria-current', 'true');
  await moveDialog.getByRole('button', { name: m.cancelMove, exact: true }).click();
  await expect(targetDrawer).toBeFocused();
  await expect(originalDrawer).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('Enter');
  await expect(moveDialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(targetDrawer).toBeFocused();
  expect((await product(productId)).bin_id).toBe(binId);
  await targetDrawer.click();
  await moveDialog.getByRole('button', { name: m.confirmMove, exact: true }).click();
  await expect(targetDrawer).toBeFocused();
  expect((await product(productId)).bin_id).toBe(binId);
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  expect((await product(productId)).bin_id).toBe(otherBinId);
  await originalDrawer.click();
  await moveDialog.getByRole('button', { name: m.confirmMove, exact: true }).click();
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  expect((await product(productId)).bin_id).toBe(binId);
  console.log('PASS: drawer move confirmation, Cancel/Escape focus return and draft-only confirmation until product save');

  const rival = await context.newPage();
  await rival.goto(`${origin}/en/admin/products/${productId}`);
  await expect(rival.getByLabel(fieldLabel(m.nameEn))).toHaveValue(longName);
  await page.getByLabel(fieldLabel(m.nameEn)).fill(`${longName} winner`);
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  await rival.getByLabel(fieldLabel(m.nameEn)).fill(`${longName} reviewed`);
  await rival.getByRole('button', { name: m.save, exact: true }).click();
  await expect(rival.getByText(m.stale, { exact: true })).toBeVisible();
  await expect(rival.getByLabel(fieldLabel(m.nameEn))).toHaveValue(`${longName} reviewed`);
  await rival.getByRole('button', { name: m.review, exact: true }).click();
  // Saved names carry the category shorthand the editor locks in front of the typed name.
  await expect(rival.getByText(`${en.categories.capacitors} · ${longName} winner`, { exact: true })).toBeVisible();
  await rival.getByRole('button', { name: m.reviewed, exact: true }).click();
  await rival.getByRole('button', { name: m.save, exact: true }).click();
  await expect(rival.getByText(m.saved, { exact: true })).toBeVisible();
  await rival.close();
  await page.reload();
  await page.getByRole('switch', { name: m.activeLabel, exact: true }).uncheck();
  await page.getByRole('button', { name: m.clearPlacement, exact: true }).click();
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  expect(await product(productId)).toMatchObject({ is_active: false, bin_id: null });
  await chooseDrawer(page.getByRole('group', { name: m.placement, exact: true }), binId);
  await page.getByRole('switch', { name: m.activeLabel, exact: true }).check();
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: m.category, exact: true }).selectOption({ label: m.typeNames.CAP });
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  const specs = page.locator('.specifications');
  const attributeIds = draftSpecIds;
  const specValue = async (id: string, column: keyof AttributeRow) => (await attribute(productId, id))[column];
  const specCount = (id: string) => countRows('product_attributes', { product_id: productId, attribute_id: id });
  await expect(specField(specs, 'capacitance')).toHaveValue(measurementInput('0.000000000005', 'F', 'en'));
  await specField(specs, 'capacitance').fill('0.000000000009');
  await fixtures.patch('product_attributes', { product_id: productId, attribute_id: attributeIds.numeric }, { number_value: '0.000000000007' });
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(specs.getByText(m.attributeChanged(formatMeasurement('0.000000000007', 'F', 'en')), { exact: true })).toBeVisible();
  await expect(page.getByText(m.specificationsNotSaved, { exact: true })).toBeVisible();
  await expect(specField(specs, 'capacitance')).toHaveValue(measurementInput('0.000000000009', 'F', 'en'));
  expect(await specValue(attributeIds.numeric, 'number_value')).toBe('0.000000000007');
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  expect(await specValue(attributeIds.numeric, 'number_value')).toBe('0.000000000009');
  console.log('PASS: specification conflict shows the current value, keeps the draft and replaces it only on the next save');
  await specField(specs, 'capacitance').fill('1k');
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(specs.getByText(m.attributeInvalid, { exact: true })).toBeVisible();
  await expect(specField(specs, 'capacitance')).toBeFocused();
  expect(await specValue(attributeIds.numeric, 'number_value')).toBe('0.000000000009');
  await specField(specs, 'capacitance').fill('0.000000000009');
  await specField(specs, 'polarised').selectOption('');
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  expect(await specCount(attributeIds.boolean)).toBe(0);
  await specField(specs, 'polarised').selectOption('false');
  await specField(specs, 'package').fill('SMD 0805');
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  expect(await specValue(attributeIds.boolean, 'boolean_value')).toBe(false);
  expect(await specValue(attributeIds.text, 'text_value')).toBe('SMD 0805');
  // Min–max splits a number field; a range needs both bounds, and Single value keeps Min.
  const fieldOf = (input: Locator) => input.locator('xpath=ancestor::*[@data-slot="field"][1]');
  const voltageName = `${en.specificationLabels.voltage} (V)`;
  await specField(specs, 'voltage').fill('250');
  await fieldOf(specField(specs, 'voltage')).getByRole('button', { name: m.rangeToggle, exact: true }).click();
  const voltageMin = specInput(specs, `${voltageName}, ${m.rangeMin}`), voltageMax = specInput(specs, `${voltageName}, ${m.rangeMax}`);
  await expect(voltageMax).toBeFocused();
  await expect(voltageMin).toHaveValue('250');
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(specs.getByText(m.attributeRangeIncomplete, { exact: true })).toBeVisible();
  await expect(voltageMax).toBeFocused();
  await voltageMax.fill('0.4k');
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  const voltageId = await definitionId('voltage');
  expect(await attribute(productId, voltageId)).toMatchObject({ number_value: '250', number_max: '400' });
  await expect(voltageMax).toHaveValue('400');
  await fieldOf(voltageMax).getByRole('button', { name: m.singleValue, exact: true }).click();
  await expect(specField(specs, 'voltage')).toHaveValue('250');
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  expect(await attribute(productId, voltageId)).toMatchObject({ number_value: '250', number_max: null });
  console.log('PASS: a range saves both bounds through the staff API, an incomplete one stops on Max, and Single value keeps Min');
  await page.getByRole('combobox', { name: m.category, exact: true }).selectOption({ label: m.typeNames.RES });
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  // Recorded fields outside the new category stay editable; clearing removes the value.
  await specField(specs, 'capacitance').fill('');
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  expect(await specCount(attributeIds.numeric)).toBe(0);
  console.log('PASS: invalid values are marked before any write; cleared fields remove values and recorded fields survive recategorization');

  await specs.getByRole('button', { name: m.newDefinition, exact: true }).click();
  const newType = page.getByRole('dialog', { name: m.newDefinition, exact: true });
  const beforeSpecificationViewport = page.viewportSize()!;
  for (const viewport of [{ width: 667, height: 375 }, { width: 360, height: 320 }]) {
    await page.setViewportSize(viewport);
    await expect(newType).toBeInViewport({ ratio: 1 });
    for (const control of [newType.getByRole('button', { name: m.cancel, exact: true }), newType.getByLabel(fieldLabel(m.canonicalUnit)), newType.getByRole('button', { name: m.saveReference, exact: true })]) {
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeInViewport({ ratio: 1 });
    }
    await fits(page);
  }
  await page.setViewportSize(beforeSpecificationViewport);
  await newType.getByLabel(fieldLabel(m.definitionLabel)).fill('Browser custom frequency');
  // The value type is a segmented choice (number/text/yes-no), not a select.
  await newType.getByLabel(fieldLabel(m.valueType)).getByText(m.numberType, { exact: true }).click();
  await newType.getByLabel(fieldLabel(m.canonicalUnit)).fill('Hz');
  const customCreated = await lostResponse('products:createDefinition', () => newType.getByRole('button', { name: m.saveReference, exact: true }).click());
  await expect(newType.getByText(m.unknown, { exact: true })).toBeVisible();
  await page.reload();
  await specs.getByRole('button', { name: m.referenceRecovery, exact: true }).click();
  await expect(newType.getByLabel(fieldLabel(m.definitionLabel))).toHaveValue('Browser custom frequency');
  await newType.getByRole('button', { name: m.retrySave, exact: true }).click();
  await expect(newType).not.toBeVisible();
  expect(customCreated.commands).toHaveLength(2);
  expect(customCreated.commands[1]).toBe(customCreated.commands[0]);
  const customTypeId = (await one<{ id: string }>('attribute_definitions', { label: 'Browser custom frequency' })).id;
  await specInput(specs, 'Browser custom frequency (Hz)').fill('123.000000001');
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  expect(await specValue(customTypeId, 'number_value')).toBe('123.000000001');
  console.log('PASS: inline specification type creation recovers a lost response after reload and immediately accepts a value');

  // A product and its first specifications are one transaction (products.save), so a
  // partial save cannot happen. A value the backend refuses rolls back the product
  // and its standard category with it; the draft stays for the next Save.
  await page.goto(`${origin}/en/admin/products/new`);
  await categoryCard(m.typeNames.CAP).click();
  await page.getByLabel(fieldLabel(m.nameNb)).fill('Delvis spesifikasjonslagring');
  await page.getByLabel(fieldLabel(m.nameEn)).fill('Partial specification save');
  await page.getByRole('switch', { name: m.freeLabel, exact: true }).check();
  await specField(specs, 'capacitance').fill('0.000000000003');
  const partialName = `${en.categories.capacitors} · Partial specification save`;
  const productsBefore = await countRows('products');
  // Just before the command arrives, the definition stops accepting numbers, so the
  // backend itself refuses the value inside the product's transaction.
  const capacitance = await one<{ value_type: string }>('attribute_definitions', { id: draftSpecIds.numeric });
  const refusedValue = socket.before('products:save', async () => { await fixtures.patch('attribute_definitions', { id: draftSpecIds.numeric }, { value_type: 'text' }); });
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.failed, { exact: true })).toBeVisible();
  refusedValue.stop();
  await fixtures.patch('attribute_definitions', { id: draftSpecIds.numeric }, { value_type: capacitance.value_type });
  expect(refusedValue.sent).toHaveLength(1);
  expect(await countRows('products')).toBe(productsBefore);
  expect(await countRows('products', { name_en: partialName })).toBe(0);
  await expect(page).toHaveURL(`${origin}/en/admin/products/new`);
  await expect(specField(specs, 'capacitance')).toHaveValue(measurementInput('0.000000000003', 'F', 'en'));
  await specField(specs, 'capacitance').fill('0.000000000004');
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`^${origin}/en/admin/products/[0-9a-f-]{36}$`));
  const partialId = (await one<{ id: string }>('products', { name_en: partialName })).id;
  expect(page.url()).toBe(`${origin}/en/admin/products/${partialId}`);
  expect((await attribute(partialId, draftSpecIds.numeric)).number_value).toBe('0.000000000004');
  console.log('PASS: a refused specification rolls back the whole new product; the kept draft saves product and specification together');

  await page.goto(`${origin}/en/admin/products/new`);
  await categoryCard(m.typeNames.RES).click();
  await page.getByLabel(fieldLabel(m.nameNb)).fill('Kollisjonstest');
  await page.getByLabel(fieldLabel(m.nameEn)).fill('Code collision proof');
  await page.getByRole('switch', { name: m.freeLabel, exact: true }).check();
  await page.getByLabel(m.openingStock, { exact: false }).fill('7');
  // Someone else takes the generated code just before the first attempt arrives.
  const collision = socket.before('products:save', async (args) => {
    if (collision.sent.length !== 1) return;
    const { payload } = args as { payload: { code: string } };
    const now = timestamp();
    await fixtures.insert('products', [{ id: crypto.randomUUID(), code: payload.code, name_nb: 'Opptatt kode', name_en: 'Occupied code', description: null, category_id: null,
      bin_id: null, location_note: null, unit_code: 'pcs', stock_step: '1', sale_step: '1', sale_unit_price_nok: '0', minimum_stock: '0', datasheet_url: null,
      purchase_url: null, is_active: true, metadata_revision: 1, created_at: now, updated_at: now }]);
  });
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`^${origin}/en/admin/products/[0-9a-f-]{36}$`));
  collision.stop();
  const collisionBodies = collision.sent.map(args => (JSON.parse(args)[0] as { payload: { id: string; code: string } }).payload);
  expect(collisionBodies).toHaveLength(2); expect(collisionBodies[1].id).toBe(collisionBodies[0].id); expect(collisionBodies[1].code).not.toBe(collisionBodies[0].code);
  const openedId = (await one<{ id: string }>('products', { name_en: `${en.categories.resistors} · Code collision proof` })).id;
  await expect(page.locator('.product-stock').getByText('7 pieces', { exact: true })).toBeVisible();
  expect(await one('stock_levels', { product_id: openedId })).toMatchObject({ quantity: '7', last_counted_at: expect.any(String) });
  await page.goto(`${origin}/en/admin/products/new`);
  await categoryCard(m.typeNames.RES).click();
  await page.getByLabel(fieldLabel(m.nameNb)).fill('Tapt svar med lager');
  await page.getByLabel(fieldLabel(m.nameEn)).fill('Lost reply with stock');
  await page.getByRole('switch', { name: m.freeLabel, exact: true }).check();
  await page.getByLabel(m.openingStock, { exact: false }).fill('3');
  const openedLost = await lostResponse('products:save', () => page.getByRole('button', { name: m.save, exact: true }).click());
  await expect(page.getByText(m.unknown, { exact: true })).toBeVisible();
  const openedLostId: string = JSON.parse(openedLost.commands[0])[0].payload.id;
  await page.reload();
  await expect(page.getByLabel(m.openingStock, { exact: false })).toHaveValue('3');
  await page.getByRole('button', { name: m.retrySave, exact: true }).click();
  await expect(page).toHaveURL(`${origin}/en/admin/products/${openedLostId}`);
  expect(await quantity(openedLostId)).toBe('3');
  expect(await countRows('stock_counts', { product_id: openedLostId })).toBe(1);
  console.log('PASS: opening stock entered on a new product is posted once as its first count, also after a lost creation reply and reload');
  await page.goto(`${origin}/en/admin/products/${productId}`);
  await expect(page.getByLabel(fieldLabel(m.nameEn))).toHaveValue(`${longName} reviewed`);
  console.log('PASS: product creation lost response/reload, exact price, stale review, inactive/unassigned and reactivation');
  const c = en.adminCounts;
  let count = page.getByRole('dialog', { name: c.countProduct, exact: true });
  await page.getByRole('button', { name: c.beginCount, exact: true }).click();
  await count.getByLabel(c.observed, { exact: false }).fill('10');
  await count.getByLabel(fieldLabel(c.note)).fill('Physical opening count in the disposable browser proof');
  await count.getByLabel(fieldLabel(c.pauseConfirmed)).check();
  const counted = await lostResponse('stock:recordSingleCount', () => count.getByRole('button', { name: c.saveCount, exact: true }).click(), true);
  await expect(count.getByText(c.unknown, { exact: true })).toBeVisible();
  await page.reload();
  await count.getByRole('button', { name: c.retryCount, exact: true }).click();
  await expect.poll(() => counted.commands.length).toBe(2);
  await expect(count.getByText(c.unknown, { exact: true })).toHaveCount(0);
  counted.release();
  await expect(count.getByRole('button', { name: c.countAgain, exact: true })).toBeVisible();
  expect(counted.commands).toHaveLength(2); expect(counted.commands[1]).toBe(counted.commands[0]);
  expect(await countRows('stock_counts', { product_id: productId })).toBe(1);
  await count.getByRole('button', { name: c.countAgain, exact: true }).click();
  await count.getByLabel(c.observed, { exact: false }).fill('10');
  await count.getByLabel(fieldLabel(c.pauseConfirmed)).check();
  await count.getByRole('button', { name: c.saveCount, exact: true }).click();
  await expect(count.getByRole('button', { name: c.countAgain, exact: true })).toBeVisible();
  expect(await countRows('stock_counts', { product_id: productId })).toBe(2);
  expect(await countRows('inventory_movements', { product_id: productId })).toBe(1);
  await count.getByRole('button', { name: c.countAgain, exact: true }).click();
  await count.getByLabel(c.observed, { exact: false }).fill('11');
  await count.getByLabel(fieldLabel(c.pauseConfirmed)).check();
  // The same staff member registers a movement from another session after the count form opened.
  const staffApi = await signedInClient(staffEmail);
  await staffApi.mutation(api.stock.adjust, { requestId: crypto.randomUUID(), items: [{ productId, quantityDelta: '1' }], reason: 'Registered movement after the count form opened' });
  await count.getByRole('button', { name: c.saveCount, exact: true }).click();
  await expect(count.getByText(c.stale, { exact: true })).toBeVisible();
  expect(await countRows('stock_counts', { product_id: productId })).toBe(2);
  await count.getByRole('button', { name: c.recount, exact: true }).click();
  await expect(count.getByLabel(c.observed, { exact: false })).toHaveValue('');
  await count.getByLabel(c.observed, { exact: false }).fill('12');
  await count.getByLabel(fieldLabel(c.pauseConfirmed)).check();
  await count.getByRole('button', { name: c.saveCount, exact: true }).click();
  await expect(count.getByRole('button', { name: c.countAgain, exact: true })).toBeVisible();
  expect(await quantity(productId)).toBe('12');
  console.log('PASS: single count lost acknowledgement/reload, zero-difference history and mandatory fresh recount');

  count = page.locator('.count-section');
  await page.goto(`${origin}/en/admin/counts`);
  await page.getByLabel(fieldLabel(c.batchTitle)).fill('Browser batch with several recorded observations');
  const started = await lostResponse('stock:startCountBatch', () => page.getByRole('button', { name: c.start, exact: true }).click(), true);
  await expect(page.getByText(c.unknownStart, { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: c.retryStart, exact: true }).click();
  // The page's own in-flight command must not read back as an interrupted one.
  await expect.poll(() => started.commands.length).toBe(2);
  await expect(page.getByText(c.unknownStart, { exact: true })).toHaveCount(0);
  started.release();
  await expect(page.getByRole('combobox', { name: en.adminOrders.product, exact: true })).toBeVisible();
  expect(started.commands).toHaveLength(2); expect(started.commands[1]).toBe(started.commands[0]);
  const batchId = page.url().split('/').at(-1)!;
  // Count detail picks products with the shared order combobox (search by code, then choose).
  const productCode = (await product(productId)).code;
  await page.getByRole('combobox', { name: en.adminOrders.product, exact: true }).click();
  await page.getByRole('combobox', { name: en.adminOrders.searchProduct, exact: true }).fill(productCode);
  await page.getByRole('option').filter({ hasText: productCode }).click();
  await count.getByRole('button', { name: c.beginCount, exact: true }).click();
  await count.getByLabel(c.observed, { exact: false }).fill('0');
  await count.getByLabel(fieldLabel(c.note)).fill('Keep this physical observation during a failed refresh');
  // The batch is a live subscription: its next update (a retitled batch) fails.
  const historyRead = socket.failReads('stock:countDetail');
  await fixtures.patch('count_batches', { id: batchId }, { title: 'Browser batch, retitled during a failed read' });
  await expect(page.getByText(c.detailLoadFailed, { exact: true })).toBeVisible();
  await expect(count.getByLabel(c.observed, { exact: false })).toHaveValue('0');
  await expect(count.getByLabel(fieldLabel(c.note))).toHaveValue('Keep this physical observation during a failed refresh');
  await expect(count.getByRole('button', { name: c.saveCount, exact: true })).toBeDisabled();
  historyRead.stop();
  await page.getByRole('button', { name: c.retryLoad, exact: true }).click();
  await expect(page.getByText(c.detailLoadFailed, { exact: true })).toHaveCount(0);
  await expect(count.getByLabel(c.observed, { exact: false })).toHaveValue('0');
  console.log('PASS: failed batch refresh preserves physical count input and blocks submission until retry');

  await count.getByLabel(fieldLabel(c.pauseConfirmed)).check();
  await count.getByRole('button', { name: c.saveCount, exact: true }).click();
  await expect(page.locator('.observations [data-slot="item"]')).toHaveCount(1);
  expect(await quantity(productId)).toBe('0');
  // Finishing confirms in the shared AlertDialog; its action sends the command.
  await page.getByRole('button', { name: c.finish, exact: true }).click();
  const finished = await lostResponse('stock:finishCountBatch', () => page.getByRole('alertdialog').getByRole('button', { name: c.finish, exact: true }).click(), true);
  await expect(page.getByText(c.unknownFinish, { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: c.retryFinish, exact: true }).click();
  await expect.poll(() => finished.commands.length).toBe(2);
  await expect(page.getByText(c.unknownFinish, { exact: true })).toHaveCount(0);
  finished.release();
  await expect(page.locator('.finish-section')).toHaveCount(0);
  expect(finished.commands).toHaveLength(2); expect(finished.commands[1]).toBe(finished.commands[0]);
  expect((await one<{ finished_at: string | null }>('count_batches', { id: batchId })).finished_at).not.toBeNull();
  expect(await quantity(productId)).toBe('0');

  const otherApi = await signedInClient(otherEmail);
  const abandoned = (await otherApi.mutation(api.stock.startCountBatch, { requestId: crypto.randomUUID(), title: 'Other owner batch' })).batch_id;
  await page.goto(`${origin}/en/admin/counts/${abandoned}`);
  await expect(page.getByText(c.ownerOnly, { exact: true })).toBeVisible();
  await expect(page.locator('.finish-section')).toHaveCount(0);
  await fixtures.patch('staff_members', { auth_user_id: otherId }, { is_active: false });
  await page.reload();
  await page.getByLabel(fieldLabel(c.closureReason)).fill('Original operator left; retain all previous observations.');
  await page.getByRole('button', { name: c.closeAbandoned, exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: c.closeAbandoned, exact: true }).click();
  await expect(page.locator('.finish-section')).toHaveCount(0);
  const closed = await one<{ owner_id: string; finished_by: string | null; finish_reason: string | null; finished_at: string | null }>('count_batches', { id: abandoned });
  expect(closed.finished_by).not.toBe(closed.owner_id);
  expect(closed.finish_reason).not.toBeNull(); expect(closed.finished_at).not.toBeNull();
  console.log('PASS: batch start/count/finish with original retries, immediate zero count and eligible abandoned-owner closure');
  const sh = en.adminShelf;
  const layout = page.locator('.layout-editor');
  async function previewSize(rows: string, columns: string) {
    for (const [label, desired] of [[sh.resizeRows, Number(rows)], [sh.resizeCols, Number(columns)]] as const) {
      const handle = layout.getByRole('slider', { name: label, exact: true });
      // The editor locks while it reconciles a save; act only once the grips are live.
      await expect(handle).toBeEnabled();
      const current = Number(await handle.getAttribute('aria-valuenow'));
      for (let step = 0; step < Math.abs(desired - current); step++) {
        await handle.press(desired > current ? 'ArrowRight' : 'ArrowLeft');
      }
    }
  }
  async function dragOneColumnWider() {
    const handle = layout.getByRole('slider', { name: sh.resizeHandle, exact: true });
    await handle.scrollIntoViewIfNeeded();
    const corner = await handle.boundingBox();
    const frame = await layout.locator('.cabinet-frame').boundingBox();
    assert.ok(corner && frame, 'Drawer resize corner and cabinet frame are rendered');
    const selectedCell = await layout.locator('[data-item-id][aria-pressed="true"]').boundingBox();
    assert.ok(selectedCell, 'Selected drawer is rendered');
    expect(Math.abs(corner.y + corner.height / 2 - selectedCell.y - selectedCell.height)).toBeLessThan(2);
    const columns = Number(await layout.getByRole('slider', { name: sh.resizeCols, exact: true }).getAttribute('aria-valuenow'));
    const x = corner.x + corner.width / 2, y = corner.y + corner.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + frame.width / columns, y, { steps: 8 });
    await page.mouse.up();
  }
  const liveBinIds = async (cabinet: string): Promise<string[]> => (await rows<BinRow>('bins', { cabinet_id: cabinet, is_archived: false })).sort(byId).map(row => row.id);
  await page.goto(`${origin}/en/admin/shelf`);
  await expect(page.locator('[data-shelf-wall]').getByRole('button')).toHaveCount(12);
  await openShelfCabinet(page, 'C2');
  const seededSpans = page.locator('[data-cabinet-editor]').getByRole('group', { name: sh.layoutPreview, exact: true });
  await expect(seededSpans.getByRole('button', { name: `A1–D1 · ${sh.emptyDrawer}`, exact: true })).toBeVisible();
  await expect(seededSpans.getByRole('button', { name: `C2–D2 · ${sh.emptyDrawer}`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: sh.newCabinet, exact: true }).click();
  await page.getByLabel(fieldLabel(sh.row)).fill('7');
  await page.getByLabel(fieldLabel(sh.column)).fill('F');
  await previewSize('64', '64');
  await expect(layout.locator('[data-item-id]')).toHaveCount(4096);
  for (const width of [360, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const target = await layout.locator('[data-item-id]').first().boundingBox();
    assert.ok(target && target.width >= 24 && target.height >= 24, 'Dense layouts retain 24px targets');
    await fits(page);
  }
  await layout.locator('[data-item-id]').first().focus();
  const documentScroll = await page.evaluate(() => window.scrollY);
  await page.keyboard.press('End');
  expect(await page.evaluate(() => window.scrollY)).toBe(documentScroll);
  expect(await layout.locator('.shelf-viewport').evaluate(element => element.scrollTop > 0 && element.scrollLeft > 0)).toBe(true);
  expect(await layout.locator('[data-item-id]').last().evaluate(element => {
    const target = element.getBoundingClientRect(), frame = element.closest('.shelf-viewport')!.getBoundingClientRect();
    return target.left >= frame.left && target.right <= frame.right && target.top >= frame.top && target.bottom <= frame.bottom;
  })).toBe(true);
  console.log('PASS: accepted dense shelf layout retains touch targets and local keyboard panning without page overflow or document scrolling');
  await previewSize('4', '4');
  await expect(layout.locator('[data-item-id]')).toHaveCount(16);
  const layoutCreated = await lostResponse('shelf:saveLayout', () => page.getByRole('button', { name: sh.save, exact: true }).click());
  await expect(page.getByText(sh.unknown, { exact: true })).toBeVisible();
  const newLayout = JSON.parse(layoutCreated.commands[0])[0];
  const cabinetId: string = newLayout.cabinet.id;
  expect(newLayout.before).toBeNull(); expect(newLayout.beforeBins).toEqual([]);
  expect(newLayout.bins).toHaveLength(16);
  const initialBins = await liveBinIds(cabinetId);
  expect(initialBins).toEqual(newLayout.bins.map((row: { id: string }) => row.id).sort());
  await page.reload();
  await page.getByRole('button', { name: sh.finishChange, exact: true }).click();
  await expect(page.getByText(sh.saved, { exact: true })).toBeVisible();
  expect(layoutCreated.commands).toHaveLength(2);
  expect(layoutCreated.commands[1]).toBe(layoutCreated.commands[0]);
  expect(await liveBinIds(cabinetId)).toEqual(initialBins);
  expect(await countRows('bins', { cabinet_id: cabinetId, row_span: 1, col_span: 1 })).toBe(16);
  // Privileged mutations are tested through the native Convex client with real Auth
  // credentials. Public functions have no service-role bypass on Convex; internal
  // functions answer only the deployment's admin key.
  const deniedCabinetId = crypto.randomUUID();
  const deniedLayout = structuredClone(newLayout);
  deniedLayout.requestId = crypto.randomUUID();
  deniedLayout.cabinet = { ...deniedLayout.cabinet, id: deniedCabinetId, code: `C-${deniedCabinetId}`, outer_row: 29, outer_col: 10 };
  deniedLayout.bins = deniedLayout.bins.map((row: Record<string, unknown>) => {
    const id = crypto.randomUUID(); return { ...row, id, code: `B-${id}`, cabinet_id: deniedCabinetId };
  });
  for (const [kind, client] of [
    ['nonstaff', await signedInClient(nonstaffEmail)],
    ['anonymous', new ConvexHttpClient(convexUrl, { logger: false })]
  ] as const) {
    const refusal = await client.mutation(api.shelf.saveLayout, deniedLayout).then(() => null, (error: unknown) => error);
    expect(rejectionCode(refusal), `${kind} cannot save a shelf layout`).toBe('STAFF_REQUIRED');
    expect(await countRows('cabinets', { id: deniedCabinetId })).toBe(0);
    expect(await countRows('bins', { cabinet_id: deniedCabinetId })).toBe(0);
  }
  console.log('PASS: real shelf-layout permission boundary for staff, signed-in nonstaff and anonymous callers');
  const firstBin = await binAt(cabinetId, 1, 1);
  const secondBin = await binAt(cabinetId, 2, 1);
  const occupiedNeighbor = await binAt(cabinetId, 1, 3);
  await editProduct(productId, { is_active: false, bin_id: firstBin });
  await editProduct(frozen.payload.id, { is_active: false, bin_id: occupiedNeighbor });
  expect(await quantity(productId)).toBe('0');
  // No standing refresh button (design-system §4.2); the map re-reads when the tab regains focus.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await openShelfCabinet(page, 'F7');
  const cabinetDiagram = page.locator('[data-cabinet-editor]').getByRole('group', { name: sh.layoutPreview, exact: true });
  await expect(cabinetDiagram.getByRole('button', { name: 'A1', exact: true })).not.toHaveClass(/\bempty\b/);
  await expect(cabinetDiagram.getByRole('button', { name: `B1 · ${sh.emptyDrawer}`, exact: true })).toHaveClass(/\bempty\b/);
  await expect(page.locator('[data-cabinet-editor]')).toBeVisible();
  const preview = layout.getByRole('group', { name: sh.layoutPreview, exact: true });
  const emptyDrawer = preview.getByRole('button', { name: `B1 · ${sh.emptyDrawer}`, exact: true });
  await expect(emptyDrawer).toHaveClass(/\bempty\b/);
  expect(await emptyDrawer.evaluate(element => element.tagName)).toBe('BUTTON');
  expect(await emptyDrawer.locator('.drawer').evaluate(element => {
    const style = getComputedStyle(element);
    return [style.borderTopStyle, style.borderTopWidth];
  })).toEqual(['dashed', '1px']);
  await emptyDrawer.click(); await expect(emptyDrawer).toHaveAttribute('aria-pressed', 'true');
  await chooseLayoutDrawer(layout, firstBin);
  await expect(preview.getByRole('button', { name: 'A1', exact: true })).not.toHaveClass(/\bempty\b/);
  await dragOneColumnWider();
  await expect(layout.getByRole('slider', { name: sh.resizeHandle, exact: true })).toHaveAttribute('aria-valuenow', '2');
  expect((await bin(firstBin)).col_span).toBe(1);
  await page.getByRole('button', { name: sh.widenDrawer, exact: true }).click();
  await expect(layout.getByText(sh.notEmpty, { exact: true })).toBeVisible();
  await expect(preview.getByRole('button', { name: 'A1–B1', exact: true })).not.toHaveClass(/\bempty\b/);
  await expect(layout.getByRole('slider', { name: sh.resizeHandle, exact: true })).toHaveAttribute('aria-valuenow', '2');
  await chooseLayoutDrawer(layout, secondBin);
  await page.getByRole('button', { name: sh.widenDrawer, exact: true }).click();
  await expect(layout.getByRole('slider', { name: sh.resizeHandle, exact: true })).toHaveAttribute('aria-valuenow', '2');
  const resizeHandle = layout.getByRole('slider', { name: sh.resizeHandle, exact: true });
  await resizeHandle.scrollIntoViewIfNeeded();
  const resizeBox = await resizeHandle.boundingBox();
  const selectedBox = await layout.locator('[data-item-id][aria-pressed="true"]').boundingBox();
  assert.ok(resizeBox && selectedBox, 'Resize cancellation has a rendered drawer and thumb');
  const resizeX = resizeBox.x + resizeBox.width / 2, resizeY = resizeBox.y + resizeBox.height / 2;
  await page.mouse.move(resizeX, resizeY); await page.mouse.down();
  await page.mouse.move(resizeX - selectedBox.width / 2, resizeY, { steps: 5 });
  await expect(resizeHandle).toHaveAttribute('aria-valuenow', '1');
  await resizeHandle.dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse' });
  await expect(resizeHandle).toHaveAttribute('aria-valuenow', '2');
  await page.mouse.move(resizeX - selectedBox.width / 2, resizeY); await page.mouse.up();
  await expect(layout.getByRole('slider', { name: sh.resizeHandle, exact: true })).toHaveAttribute('aria-valuenow', '2');
  await resizeHandle.focus(); await page.keyboard.press('ArrowLeft');
  await expect(layout.getByRole('slider', { name: sh.resizeHandle, exact: true })).toHaveAttribute('aria-valuenow', '1');
  await page.keyboard.press('ArrowRight');
  await expect(layout.getByRole('slider', { name: sh.resizeHandle, exact: true })).toHaveAttribute('aria-valuenow', '2');
  await page.getByRole('button', { name: sh.save, exact: true }).click();
  await expect(page.getByText(sh.saved, { exact: true })).toBeVisible();
  expect(await countRows('bins', { cabinet_id: cabinetId, col_span: 2 })).toBe(2);
  expect((await product(productId)).bin_id).toBe(firstBin);
  expect((await product(frozen.payload.id)).bin_id).toBe(occupiedNeighbor);
  expect(await liveBinIds(cabinetId)).toHaveLength(14);
  console.log('PASS: selectable muted empty drawers, zero-stock/inactive assignments remain occupied, pointer/tap/keyboard width changes, cancelled drags, source identity and assigned-neighbour protection');
  // Fixture: two physical drawers have been taken out, providing a destination for a move.
  // An archived drawer leaves the wall: it keeps its identity but no placement, as shelf.updateBin archives it.
  const takenOut = { is_archived: true, cabinet_id: null, inner_row: null, inner_col: null };
  for (const col of [1, 2]) await fixtures.patch('bins', { cabinet_id: cabinetId, inner_row: 3, inner_col: col }, takenOut);
  // No standing refresh button (design-system §4.2); the map re-reads when the tab regains focus.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('[data-cabinet-editor]').getByRole('button', { name: 'A3', exact: true })).toHaveCount(0);
  await page.locator('[data-cabinet-editor]').getByRole('button', { name: 'A1–B1', exact: true }).click();
  await expect(page.getByRole('link', { name: `${en.categories.resistors} · ${longName} reviewed`, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: sh.archiveBin, exact: true })).toBeDisabled();
  await page.getByRole('button', { name: sh.moveDrawer, exact: true }).click();
  await layout.locator('[data-item-id="vacant:3:1"]').click();
  const moved = await lostResponse('shelf:updateBin', () => page.getByRole('alertdialog').getByRole('button', { name: sh.confirmAction, exact: true }).click());
  await expect(page.getByText(sh.unknown, { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: sh.finishChange, exact: true }).click();
  await expect(page.getByText(sh.saved, { exact: true })).toBeVisible();
  // The move is a compare-and-set, so Finish resends it unchanged and the backend sees it already applied.
  expect(moved.commands).toHaveLength(2); expect(moved.commands[1]).toBe(moved.commands[0]);
  expect(await bin(firstBin)).toMatchObject({ inner_row: 3, col_span: 2 });
  expect((await product(productId)).bin_id).toBe(firstBin);
  expect((await rows<BinRow>('bins', { cabinet_id: cabinetId, inner_row: 1 })).filter(row => row.inner_col <= 2)).toHaveLength(0);
  expect(await liveBinIds(cabinetId)).toHaveLength(12);
  await openShelfCabinet(page, 'F7');
  await page.locator('[data-cabinet-editor]').getByRole('button', { name: 'A3–B3', exact: true }).click();
  await page.getByRole('button', { name: sh.moveDrawer, exact: true }).click();
  await layout.locator(`[data-item-id="${secondBin}"]`).click();
  const swapped = await lostResponse('shelf:swapBins', () => page.getByRole('alertdialog').getByRole('button', { name: sh.swap, exact: true }).click());
  await expect(page.getByText(sh.unknown, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: sh.finishChange, exact: true }).click();
  const drawerSwapToast = page.locator('[data-sonner-toast]').filter({ has: page.getByText(
    sh.swapPreview(`${sh.cabinet('F7')} · ${sh.bin('A3–B3')}`, `${sh.cabinet('F7')} · ${sh.bin('A2–B2')}`), { exact: true }
  ) });
  await expect(drawerSwapToast.getByText(sh.positionsSwapped, { exact: true })).toBeVisible();
  expect(swapped.commands).toHaveLength(2); expect(swapped.commands[1]).toBe(swapped.commands[0]);
  expect((await bin(firstBin)).inner_row).toBe(2);
  expect((await bin(secondBin)).inner_row).toBe(3);
  expect((await product(productId)).bin_id).toBe(firstBin);
  expect(await liveBinIds(cabinetId)).toHaveLength(12);
  // Two empty drawers of one size look identical everywhere, so a drop between them is a no-op.
  const occupied = new Set((await rows<ProductRow>('products')).map(row => row.bin_id));
  const vacant = (await rows<BinRow>('bins', { cabinet_id: cabinetId, is_archived: false })).filter(row => !occupied.has(row.id)).sort(byId);
  const twins = vacant.flatMap(a => vacant.filter(b => b.id > a.id && b.row_span === a.row_span && b.col_span === a.col_span && b.label === a.label)
    .map(b => [a.id, b.id]))[0];
  expect(twins).toHaveLength(2);
  const twinPositions = async () => (await Promise.all(twins.map(bin))).map(row => `${row.inner_row}:${row.inner_col}`).join(' ');
  const twinsBefore = await twinPositions();
  await layout.locator(`[data-item-id="${twins[0]}"]`).click();
  await page.getByRole('button', { name: sh.moveDrawer, exact: true }).click();
  await layout.locator(`[data-item-id="${twins[1]}"]`).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: sh.moveDrawer, exact: true })).toBeEnabled();
  expect(await twinPositions()).toBe(twinsBefore);
  console.log('PASS: generated grid with one atomic save, identical lost-response replay, configured spans, drawer moves/swaps preserve products and vacancies');

  const beforeGrowth = await liveBinIds(cabinetId);
  await expect(page.locator('[data-cabinet-editor]')).toBeVisible();
  await previewSize('4', '5');
  await page.getByRole('button', { name: sh.save, exact: true }).click();
  await expect(page.getByText(sh.saved, { exact: true })).toBeVisible();
  const grown = await liveBinIds(cabinetId);
  expect(grown).toHaveLength(18); expect(grown).toEqual(expect.arrayContaining(beforeGrowth));
  expect((await product(productId)).bin_id).toBe(firstBin);
  expect((await rows<BinRow>('bins', { cabinet_id: cabinetId, inner_row: 1 })).filter(row => row.inner_col <= 2)).toHaveLength(2);
  await expect(page.locator('[data-cabinet-editor]')).toBeVisible();
  await previewSize('1', '5');
  await expect(layout.getByText(sh.notEmpty, { exact: true })).toBeVisible();
  expect(await liveBinIds(cabinetId)).toEqual(grown);
  // Incremental resizing drops empty draft rows before the occupied row blocks it.
  // Discard that draft before checking drawer identities in the saved layout.
  await page.getByRole('button', { name: sh.discardChanges, exact: true }).click();
  await expect(page.locator('[data-cabinet-editor]')).toBeVisible();
  await chooseLayoutDrawer(layout, secondBin);
  await page.getByRole('button', { name: sh.splitLayout, exact: true }).click();
  await previewSize('3', '5');
  // A competing physical move after opening the layout must invalidate its full snapshot.
  const concurrentlyMoved = await binAt(cabinetId, 1, 4);
  await fixtures.patch('bins', { cabinet_id: cabinetId, inner_row: 1, inner_col: 1 }, takenOut);
  await fixtures.patch('bins', { id: concurrentlyMoved }, { inner_col: 1 });
  await page.getByRole('button', { name: sh.save, exact: true }).click();
  await expect(page.getByText(sh.stale, { exact: true })).toBeVisible();
  expect((await bin(concurrentlyMoved)).inner_col).toBe(1);
  expect((await one<{ inner_rows: number }>('cabinets', { id: cabinetId })).inner_rows).toBe(4);
  expect((await bin(secondBin)).col_span).toBe(2);
  // The map re-reads by itself after a stale rejection; the admin reviews the fresh layout.
  await page.getByRole('button', { name: sh.reviewLayout, exact: true }).click();
  await expect(layout.getByRole('slider', { name: sh.resizeRows, exact: true })).toHaveAttribute('aria-valuenow', '4');
  await chooseLayoutDrawer(layout, concurrentlyMoved);
  await expect(layout.locator(`[data-item-id="${concurrentlyMoved}"]`)).toHaveAttribute('aria-label', `A1 · ${sh.emptyDrawer}`);
  await chooseLayoutDrawer(layout, secondBin);
  await page.getByRole('button', { name: sh.splitLayout, exact: true }).click();
  await previewSize('3', '5');
  await page.getByRole('button', { name: sh.save, exact: true }).click();
  await expect(page.getByText(sh.saved, { exact: true })).toBeVisible();
  expect(await one('cabinets', { id: cabinetId })).toMatchObject({ inner_rows: 3, inner_cols: 5 });
  expect(await bin(secondBin)).toMatchObject({ inner_row: 3, inner_col: 1, col_span: 1 });
  expect((await rows<BinRow>('bins', { cabinet_id: cabinetId, is_archived: false })).reduce((sum, row) => sum + row.row_span * row.col_span, 0)).toBe(15);
  expect((await product(productId)).bin_id).toBe(firstBin);
  console.log('PASS: explicit layout adjustment fills vacancies, preserves identities, blocks occupied shrink, and requires current review after a stale snapshot');

  // Larger drawers can also be configured before the cabinet's first save.
  await page.getByRole('button', { name: sh.newCabinet, exact: true }).click();
  await page.getByLabel(fieldLabel(sh.row)).fill('7');
  await page.getByLabel(fieldLabel(sh.column)).fill('G');
  await previewSize('2', '2');
  await layout.getByRole('group', { name: sh.layoutPreview, exact: true }).getByRole('button', { name: `A1 · ${sh.emptyDrawer}`, exact: true }).click();
  await page.getByRole('button', { name: sh.widenDrawer, exact: true }).click();
  await expect(layout.locator('[data-item-id]')).toHaveCount(3);
  await page.getByRole('button', { name: sh.save, exact: true }).click();
  await expect(page.getByText(sh.saved, { exact: true })).toBeVisible();
  const secondCabinet = (await one<{ id: string }>('cabinets', { outer_row: 7, outer_col: 7, is_archived: false })).id;
  expect(await liveBinIds(secondCabinet)).toHaveLength(3);
  expect(await countRows('bins', { cabinet_id: secondCabinet, col_span: 2 })).toBe(1);
  await openShelfCabinet(page, 'F7');
  await expect(page.locator('[data-cabinet-editor]')).toBeVisible();
  await expect(page.getByRole('button', { name: sh.archiveCabinetWithDrawers, exact: true })).toBeDisabled();
  await page.getByRole('button', { name: sh.moveCabinet, exact: true }).click();
  await page.getByRole('group', { name: sh.moveTarget, exact: true }).locator(`[data-item-id="${secondCabinet}"]`).click();
  await page.getByRole('button', { name: sh.swap, exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: sh.swap, exact: true }).click();
  const cabinetSwapToast = page.locator('[data-sonner-toast]').filter({ has: page.getByText(
    sh.swapPreview(sh.cabinet('F7'), sh.cabinet('G7')), { exact: true }
  ) });
  await expect(cabinetSwapToast.getByText(sh.positionsSwapped, { exact: true })).toBeVisible();
  expect((await one<{ outer_col: number }>('cabinets', { id: cabinetId })).outer_col).toBe(7);
  expect((await one<{ outer_col: number }>('cabinets', { id: secondCabinet })).outer_col).toBe(6);
  expect((await product(productId)).bin_id).toBe(firstBin);
  console.log('PASS: initial spanning layout and whole-cabinet swap retain drawer contents');
  // Placement cases deliberately unpublish this product; publish it again for public-label checks.
  await editProduct(productId, { bin_id: binId, is_active: true });
  const geometry = await context.newPage();
  await geometry.addInitScript(() => Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
    configurable: true, value: async () => { throw new DOMException('Denied for responsive proof', 'NotAllowedError'); }
  }));
  for (const viewport of [{ width: 667, height: 375 }, { width: 844, height: 390 }]) {
    await geometry.setViewportSize(viewport);
    await geometry.goto(`${origin}/en/admin/products`);
    await geometry.getByRole('button', { name: m.scanProduct, exact: true }).click();
    const scanner = geometry.getByRole('dialog', { name: m.scanProduct, exact: true });
    const retry = scanner.getByRole('button', { name: en.scanner.retryCamera, exact: true });
    await expect(retry).toBeVisible();
    await expect(scanner).toBeInViewport({ ratio: 1 });
    await retry.scrollIntoViewIfNeeded();
    await expect(retry).toBeInViewport({ ratio: 1 });
    const closeScanner = scanner.getByRole('button', { name: en.scanner.close, exact: true });
    await closeScanner.scrollIntoViewIfNeeded();
    await expect(closeScanner).toBeInViewport({ ratio: 1 });
    await closeScanner.click();
    await fits(geometry);
  }
  console.log('PASS: specification fields/actions and denied-camera retry/close remain reachable in short and landscape viewports');
  for (const locale of ['nb', 'en'] as const) for (const colorScheme of ['light', 'dark'] as const) for (const width of [360, 1280]) {
    const messages = locale === 'nb' ? nb : en;
    const prefix = locale === 'nb' ? '' : '/en';
    const suffix = `${locale}-${colorScheme}-${width}`;
    await geometry.emulateMedia({ colorScheme }); await geometry.setViewportSize({ width, height: 900 });
    await geometry.goto(`${origin}${prefix}/admin/products/new`);
    const standardCards = geometry.getByRole('radiogroup', { name: messages.adminProducts.category, exact: true });
    const standardCard = (prefix: typeof productTypes[number]['prefix']) => standardCards.getByRole('radio', { name: messages.adminProducts.typeNames[prefix], exact: true });
    for (const type of productTypes) await expect(standardCard(type.prefix)).toBeEnabled();
    await standardCard('MIS').click();
    await geometry.getByLabel(fieldLabel(messages.adminProducts.nameEn)).fill(longName);
    // The cards stay put while the form below them grows in and changes with the category.
    const position = async () => standardCards.evaluate(el => { const rect = el.getBoundingClientRect(); return { x: rect.x, top: rect.top + window.scrollY, width: rect.width, height: rect.height }; });
    const before = await position();
    for (const type of productTypes) {
      await standardCard(type.prefix).click();
      expect(await position()).toEqual(before);
      await fits(geometry);
    }
    await geometry.screenshot({ path: `${artifacts}/new-product-${suffix}.png`, fullPage: true });
    await geometry.goto(`${origin}${prefix}/admin/products/${productId}`);
    await expect(geometry.getByLabel(fieldLabel(messages.adminProducts.nameEn))).toHaveValue(`${longName} reviewed`);
    await geometry.getByLabel(fieldLabel(`${messages.adminProducts.price} (${currencySymbol(locale)})`)).focus();
    await geometry.keyboard.press('Tab'); await geometry.keyboard.press('Shift+Tab');
    expect(await geometry.evaluate(() => {
      const input = document.activeElement!;
      const group = input.closest('[data-slot="input-group"]');
      const style = group && getComputedStyle(group);
      return input.matches(':focus-visible') && getComputedStyle(input).outlineStyle === 'none'
        && style && Number.parseFloat(style.outlineWidth) >= 2 && style.outlineStyle !== 'none'
        && style.boxShadow !== 'none';
    })).toBe(true);
    await fits(geometry);
    await geometry.screenshot({ path: `${artifacts}/product-${suffix}.png`, fullPage: true });
    await specField(geometry.locator('.specifications'), 'resistance', messages).fill('1000');
    await fits(geometry);
    await geometry.locator('.specifications').screenshot({ path: `${artifacts}/specifications-${suffix}.png` });
    await geometry.getByRole('button', { name: messages.adminCounts.beginCount, exact: true }).click();
    await geometry.getByLabel(messages.adminCounts.observed, { exact: false }).fill('123');
    await geometry.getByLabel(fieldLabel(messages.adminCounts.note)).fill('Long physical count note. '.repeat(20));
    await fits(geometry);
    await geometry.getByRole('dialog').screenshot({ path: `${artifacts}/single-count-${suffix}.png` });
    await geometry.goto(`${origin}${prefix}/p/${createdBody.code}`);
    // Phones start with the product page's specifications closed.
    if (width < 768) await geometry.locator('#specifications-title button[aria-expanded="false"]').click();
    await expect(geometry.getByText(messages.specificationLabels.polarised, { exact: true })).toBeVisible();
    await expect(geometry.getByText(messages.specificationLabels.package, { exact: true })).toBeVisible();
    const publicMap = geometry.locator('.shelf-map');
    await expect(publicMap.locator('.coordinate-list')).toHaveCount(0);
    await expect(publicMap.locator('.stage [data-item-id][aria-current="true"] .marked-drawer')).toHaveCount(1);
    await publicMap.getByRole('group', { name: messages.shelfMap.wall, exact: true }).getByRole('button', { name: 'A2', exact: true }).click();
    const emptyCabinet = publicMap.getByRole('group', { name: messages.shelfMap.cabinet('A2'), exact: true });
    await expect(emptyCabinet.locator('[data-item-id].empty')).toHaveCount(24);
    await emptyCabinet.getByRole('button', { name: `A1 · ${messages.shelfMap.emptyDrawer}`, exact: true }).click();
    await expect(publicMap.getByText(messages.shelfMap.noProducts, { exact: true })).toBeVisible();
    await fits(geometry);
    await publicMap.screenshot({ path: `${artifacts}/public-shelf-${suffix}.png` });
    await geometry.goto(`${origin}${prefix}/admin/counts/${batchId}`);
    await expect(geometry.locator('.observations [data-slot="item"]')).toHaveCount(1);
    await fits(geometry); await geometry.screenshot({ path: `${artifacts}/batch-${suffix}.png`, fullPage: true });
    await geometry.goto(`${origin}${prefix}/admin/shelf`);
    const cabinetMeasurements: { width: number; height: number; cellWidth: number; cellHeight: number }[] = [];
    for (const [address, rows, columns] of [['A1', 12, 4], ['A2', 8, 3]] as const) {
      await openShelfCabinet(geometry, address);
      await expect(geometry.getByText(messages.adminShelf.grid(rows, columns), { exact: true })).toBeVisible();
      const diagram = geometry.locator('[data-cabinet-editor]').getByRole('group', { name: messages.adminShelf.layoutPreview, exact: true });
      const frame = await diagram.locator('.cabinet-frame').boundingBox();
      const cell = await diagram.locator('.drawer').first().boundingBox();
      assert.ok(frame && cell, 'Seeded cabinet frame and drawers are rendered');
      cabinetMeasurements.push({ width: frame.width, height: frame.height, cellWidth: cell.width, cellHeight: cell.height });
      await fits(geometry);
      await diagram.screenshot({ path: `${artifacts}/cabinet-${address}-${suffix}.png` });
    }
    const [smallDrawers, largeDrawers] = cabinetMeasurements;
    expect(smallDrawers.width - largeDrawers.width).toBeCloseTo(64, 1);
    expect(largeDrawers.height).toBeCloseTo(smallDrawers.height, 1);
    expect(largeDrawers.cellWidth).toBeCloseTo(smallDrawers.cellWidth, 1);
    expect(largeDrawers.cellHeight).toBeGreaterThan(smallDrawers.cellHeight);
    await openShelfCabinet(geometry, 'G7');
    await expect(geometry.locator('[data-cabinet-editor]')).toBeVisible();
    await expect(geometry.getByRole('dialog')).toHaveCount(0);
    const drawerLayout = geometry.locator('.layout-editor');
    const rowControl = drawerLayout.getByRole('slider', { name: messages.adminShelf.resizeRows, exact: true });
    await expect(drawerLayout.locator('[data-item-id]')).toHaveCount(14);
    const contentTop = () => rowControl.evaluate(element => element.getBoundingClientRect().top + window.scrollY);
    const beforeExpansion = await contentTop();
    await chooseLayoutDrawer(drawerLayout, firstBin);
    // Selecting a drawer reveals controls below the map without moving grid handles.
    expect(await contentTop()).toBeCloseTo(beforeExpansion, 2);
    await expect(drawerLayout.getByRole('slider', { name: messages.adminShelf.resizeHandle, exact: true })).toBeVisible();
    await rowControl.focus();
    await geometry.keyboard.press('Tab'); await geometry.keyboard.press('Shift+Tab');
    expect(await geometry.evaluate(() => { const el = document.activeElement!; const style = getComputedStyle(el); return el.matches(':focus-visible') && Number.parseFloat(style.outlineWidth) >= 2; })).toBe(true);
    await fits(geometry);
    await drawerLayout.screenshot({ path: `${artifacts}/drawer-layout-${suffix}.png` });
    await geometry.screenshot({ path: `${artifacts}/placement-${suffix}.png`, fullPage: true });
  }
  await geometry.close();
  await page.goto(`${origin}/en/admin/products`);
  const productCards = page.locator('.products > li');
  await expect(productCards.first()).toBeVisible();
  const productOrder = await productCards.locator('h2 a').evaluateAll(links => links.map(link => link.getAttribute('href')));
  // Stock is a live subscription: its next update (a stock change elsewhere) fails.
  const inventoryOnly = socket.failReads('stock:inventory');
  const searchProducts = page.getByLabel(fieldLabel(en.adminProducts.search));
  await searchProducts.focus();
  await staffApi.mutation(api.stock.adjust, { requestId: crypto.randomUUID(), items: [{ productId: seedProductId(0), quantityDelta: '1' }], reason: 'Stock change during a failed inventory read' });
  await expect(page.getByText(en.adminProducts.inventoryUnavailable, { exact: true })).toBeVisible();
  expect(await productCards.locator('h2 a').evaluateAll(links => links.map(link => link.getAttribute('href')))).toEqual(productOrder);
  await expect(searchProducts).toBeFocused();
  await expect(productCards.first().getByText(en.shop.unavailable, { exact: true })).toBeVisible();
  inventoryOnly.stop();
  await page.getByRole('button', { name: en.adminProducts.retry, exact: true }).click();
  await expect(page.getByText(en.adminProducts.inventoryUnavailable, { exact: true })).toHaveCount(0);
  console.log('PASS: partial inventory failure preserves product order and focus and offers contextual retry');
  // Domain-invalid quantities focus their own field and keep stock/history mounted
  // through an unavailable revalidation, without enabling a stale stock action.
  await page.goto(`${origin}/en/admin/stock?product=${productId}`);
  const stockForm = page.locator('section[aria-labelledby="stock-action-title"]');
  const stockQuantity = stockForm.locator('input[id$="-quantity"]');
  const stockReason = stockForm.getByLabel(fieldLabel(en.adminStock.reason));
  const recordStock = stockForm.getByRole('button', { name: en.adminStock.save, exact: true });
  await expect(recordStock).toBeEnabled();
  await stockQuantity.fill('0');
  await stockReason.fill('Design consistency validation');
  await recordStock.click();
  await expect(stockQuantity).toBeFocused();
  await expect(stockQuantity).toHaveAttribute('aria-invalid', 'true');
  const stockStep = (await product(productId)).stock_step;
  await expect(stockForm.getByText(en.adminStock.invalidQuantity(stockStep, false), { exact: true })).toBeVisible();
  await stockQuantity.fill(stockStep);
  const stockHistory = page.locator('section[aria-labelledby="stock-history-title"]');
  const previousHistory = await stockHistory.textContent();
  // The stock page re-reads when the browser comes back online; that read fails.
  const inventoryRead = socket.failReads('stock:detail');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByText(en.adminStock.unavailable, { exact: true })).toBeVisible();
  await expect(recordStock).toBeDisabled();
  await expect(stockQuantity).toHaveValue(stockStep); await expect(stockQuantity).toBeFocused();
  expect(await stockHistory.textContent()).toBe(previousHistory);
  inventoryRead.stop();
  await page.getByRole('button', { name: en.adminStock.retry, exact: true }).click();
  await expect(recordStock).toBeEnabled();
  await expect(stockReason).toHaveValue('Design consistency validation');
  await fits(page);

  // The log groups entries into day sections; new entries prepend without closing an open row or moving focus.
  await page.goto(`${origin}/en/admin/audit`);
  const auditRows = page.locator('section[aria-labelledby^="audit-"] > [role="list"] > [role="listitem"]');
  await expect(auditRows.first()).toBeVisible();
  const auditTimes = (await rows<{ recorded_at: string }>('audit_log')).map(row => row.recorded_at);
  const osloDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit' });
  const [entryCount, dayCount] = [auditTimes.length, new Set(auditTimes.map(time => osloDay.format(new Date(time)))).size];
  // A day loads whole, so a single day of entries needs no further page.
  if (dayCount === 1) await expect(page.getByRole('button', { name: en.adminAudit.more, exact: true })).toHaveCount(0);
  const rowsBefore = await auditRows.count();
  expect(rowsBefore).toBeLessThan(entryCount);
  // Entry IDs are intentionally never shown; keep a staff row with a disclosure by position.
  const systemActor = `${en.adminAudit.actor}: ${en.adminAudit.system}`;
  const originalIndex = await auditRows.evaluateAll((rows, system) => rows.findIndex(row => row.querySelector('[aria-expanded]') && !row.textContent?.includes(system)), systemActor);
  expect(originalIndex).toBeGreaterThanOrEqual(0);
  const originalRow = auditRows.nth(originalIndex);
  const disclosure = originalRow.locator('[aria-expanded]').first();
  await disclosure.click(); await disclosure.focus();
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  const originalText = await originalRow.innerText();
  // The log is a live subscription. Fixture writes bypass the audit on Convex, so
  // another staff member edits the product through the real API instead.
  const auditApi = await signedInClient(auditEmail);
  await describeProduct(auditApi, productId, 'Design audit refresh proof');
  const changedCode = (await product(productId)).code;
  const editor = `${en.adminAudit.actor}: ${auditName}`;
  await expect(auditRows.first()).toContainText(changedCode);
  await expect(auditRows.first()).toContainText(editor);
  // The edit joins this person's row for the product if one is already open in time, otherwise it adds one row above.
  const rowsAfter = await auditRows.count();
  expect([rowsBefore, rowsBefore + 1]).toContain(rowsAfter);
  const movedRow = auditRows.nth(originalIndex + rowsAfter - rowsBefore);
  expect(await movedRow.innerText()).toBe(originalText);
  const movedDisclosure = movedRow.locator('[aria-expanded]').first();
  await expect(movedDisclosure).toHaveAttribute('aria-expanded', 'true');
  await expect(movedDisclosure).toBeFocused();
  // The next live update (another edit) fails.
  const auditRead = socket.failReads('auditLog:page');
  await describeProduct(auditApi, productId, 'Design audit refresh proof, during a failed read');
  await expect(page.getByText(en.adminAudit.unavailable, { exact: true })).toBeVisible();
  await expect(auditRows).toHaveCount(rowsAfter);
  await expect(movedDisclosure).toBeFocused();
  auditRead.stop();
  await page.getByRole('button', { name: en.adminAudit.retry, exact: true }).click();
  await expect(page.getByText(en.adminAudit.unavailable, { exact: true })).toHaveCount(0);
  await fits(page);
  console.log('PASS: stock field validation and retained failed-read drafts; audit grouping and freshness keep open details and focus');
  await page.goto(`${origin}/en/admin/shelf`);
  // Revoked (not merely no access) needs the reloaded page to have admitted this user first.
  await expect(page.getByRole('button', { name: sh.newCabinet, exact: true })).toBeVisible();
  // Membership is live: revocation shows without any focus or reload.
  await fixtures.patch('staff_members', { auth_user_id: staffId }, { is_active: false });
  await expect(page.getByText(en.admin.revoked, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: sh.newCabinet, exact: true })).toHaveCount(0);
  console.log('PASS: both locales and themes at 360/1280, long-copy geometry, keyboard focus and access revocation');
  expect(diagnostics).toEqual([]);
  console.log('PASS: real admin Auth and operational pages');
} catch (error) {
  for (const [index, page] of (context?.pages() ?? []).entries()) await captureFailure(page, artifacts, String(index));
  throw error;
} finally { await close(); }
