/** Actual pages and gateway, disposable PostgreSQL/Auth, trusted HTTPS and real browser storage. */
import { firefox, expect, type BrowserContext, type Page, type Locator } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fieldLabel, signIn, fits, captureFailure, proofEnvironment } from './web-proof/harness';
import { generateSeedSql } from './seed-test-data';
import { en } from '../src/lib/i18n/en';
import { nb } from '../src/lib/i18n/nb';
import { productTypes } from '../src/lib/admin-products';
import { standardSpecifications } from '../src/lib/product-specifications';
import { formatMeasurement, measurementInput } from '../src/lib/format';

const { directory, origin, api, publicKey, anonKey, serviceKey, password, secrets, sql, createUser, startWorker } = await proofEnvironment();
const staffEmail = 'admin-staff@example.test';
const nonstaffEmail = 'admin-nonstaff@example.test';
const staffId = await createUser(staffEmail);
await createUser(nonstaffEmail);
const otherEmail = 'admin-other@example.test';
const otherId = await createUser(otherEmail);
await sql(`INSERT INTO app.staff_members(auth_user_id,display_name) VALUES ('${staffId}', 'Browser operator'), ('${otherId}', 'Other operator');`);
let context: BrowserContext | undefined;
const { ready, close } = await startWorker(() => context);
const artifacts = resolve('test-results/admin');
await mkdir(artifacts, { recursive: true });

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const diagnostics: string[] = [];
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
  const cabinetId = await sql(`SELECT cabinet_id FROM app.bins WHERE id=${literal(binId)}`);
  const drawer = scope.locator(`[data-item-id="${binId}"]`);
  // The picker zooms into one cabinet at a time; return to the wall when another is open.
  if (!await drawer.count()) {
    const wall = scope.getByRole('button', { name: new RegExp(`^(${nb.shelfMap.showWall}|${en.shelfMap.showWall})$`) });
    if (await wall.count()) await wall.click();
    await scope.locator(`[data-item-id="${cabinetId}"]`).click();
  }
  await drawer.click();
  await expect(drawer).toHaveAttribute('aria-pressed', 'true');
}
async function chooseLayoutDrawer(scope: Locator, binId: string) {
  const drawer = scope.locator(`[data-item-id="${binId}"]`);
  await drawer.click();
  await expect(drawer).toHaveAttribute('aria-pressed', 'true');
}
async function lostResponse(page: Page, endpoint: string, method: string, action: () => Promise<void>, holdRetry = false) {
  const commands: string[] = [];
  let release = () => {};
  const released = holdRetry ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve();
  const pattern = `${api.origin}/rest/v1/${endpoint}*`;
  await page.route(pattern, async (route) => {
    if (route.request().method() !== method) { await route.continue(); return; }
    commands.push(route.request().postData() ?? '');
    if (commands.length === 1) {
      const response = await route.fetch();
      expect(response.ok(), 'The mutation committed before its acknowledgement was lost').toBe(true);
      await route.abort('failed');
    } else { await released; await route.continue(); }
  });
  await action();
  return { commands, release, stop: () => page.unroute(pattern) };
}
try {
  await ready();
  context = await firefox.launchPersistentContext(`${directory}/profile`, { headless: true, ignoreHTTPSErrors: false });
  context.on('page', (tab) => tab.on('pageerror', (error) => diagnostics.push(error.message)));
  const page = await context.newPage();
  await signIn(page, origin, nonstaffEmail, password);
  await expect(page.getByText(en.admin.noAccess, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await signIn(page, origin, staffEmail, password);
  await expect(page.getByRole('heading', { name: en.admin.overview, exact: true })).toBeVisible();
  expect(await sql('SELECT count(*) FROM app.cabinets WHERE NOT is_archived')).toBe('12');
  expect(await sql('SELECT count(*) FROM app.bins WHERE NOT is_archived')).toBe('492');
  const m = en.adminProducts;
  // Standard choices work before any categories or catalog fixtures exist.
  expect(await sql('SELECT count(*) FROM app.categories')).toBe('0');
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
  // A membership transport failure must block writes without remounting this draft.
  const draftGeometry = await page.locator('#product-name-en').boundingBox();
  const membershipRead = `${api.origin}/rest/v1/amp_staff_members*`;
  await page.route(membershipRead, route => route.abort('failed'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText(en.admin.unavailable, { exact: true })).toBeVisible();
  await expect(page.locator('#product-name-en')).toHaveValue('Miscellaneous browser test part');
  expect(await page.locator('#product-name-en').evaluate(element => Boolean(element.closest('[inert]')))).toBe(true);
  expect(await page.locator('#product-name-en').boundingBox()).toEqual(draftGeometry);
  await page.locator('#product-name-en').evaluate(element => (element as HTMLInputElement).form!.requestSubmit());
  expect(await sql('SELECT count(*) FROM app.products')).toBe('0');
  await page.unroute(membershipRead);
  await page.getByRole('button', { name: en.admin.retry, exact: true }).click();
  await expect(page.getByLabel(fieldLabel(m.nameEn))).toHaveValue('Miscellaneous browser test part');
  await page.getByLabel(fieldLabel(`${m.price} (NOK)`)).fill('0.0000001');
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.invalidPrice, { exact: true })).toBeVisible();
  await expect(page.getByLabel(fieldLabel(`${m.price} (NOK)`))).toBeFocused();
  await expect(page.getByLabel(fieldLabel(`${m.price} (NOK)`))).toHaveAttribute('aria-invalid', 'true');
  expect(await sql('SELECT count(*) FROM app.products')).toBe('0');
  await page.getByLabel(fieldLabel(`${m.price} (NOK)`)).fill('0');
  console.log('PASS: temporary access-check failure preserves draft and blocks writes; invalid price identifies and focuses its field');
  const categoryCreated = await lostResponse(page, 'amp_categories', 'POST', () => page.getByRole('button', { name: m.save, exact: true }).click());
  await expect(page.getByText(m.unknown, { exact: true })).toBeVisible();
  expect(await sql('SELECT count(*) FROM app.products')).toBe('0');
  const frozen = await page.evaluate(() => JSON.parse(sessionStorage.getItem('ampoteket:admin-product:v1')!));
  expect(frozen.payload.code).toMatch(/^MIS-[A-F0-9]{5}$/);
  await page.reload();
  await page.getByRole('button', { name: m.retrySave, exact: true }).click();
  await expect(page).toHaveURL(`${origin}/en/admin/products/${frozen.payload.id}`);
  await page.reload();
  await expect(page.getByLabel(fieldLabel(m.nameEn))).toHaveValue('Miscellaneous browser test part');
  expect(categoryCreated.commands).toHaveLength(1);
  await categoryCreated.stop();
  expect(await sql("SELECT count(*) FROM app.categories WHERE name='Miscellaneous'")).toBe('1');
  expect(await sql(`SELECT category_id FROM app.products WHERE id=${literal(frozen.payload.id)}`)).toBe(frozen.payload.category_id);
  await page.goto(`${origin}/en/admin/products/${frozen.payload.id}`);
  expect(await sql('SELECT count(*) FROM app.attribute_definitions')).toBe('0');
  const freshSpecs = page.locator('.specifications');
  const currentDefinition = standardSpecifications.find(definition => definition.code === 'current')!;
  await specField(freshSpecs, 'current').fill('0.02');
  const definitionCreated = await lostResponse(page, 'amp_attribute_definitions', 'POST', () => page.getByRole('button', { name: m.save, exact: true }).click());
  await expect(freshSpecs.getByText(m.unknown, { exact: true })).toBeVisible();
  await expect(page.getByText(m.specificationsNotSaved, { exact: true })).toBeVisible();
  expect(await sql('SELECT count(*) FROM app.product_attributes')).toBe('0');
  await page.reload();
  // Number fields show stored values in engineering units (0.02 A reads 20 mA).
  // The frozen attempt locks its field and is resolved by the next Save.
  await expect(specField(freshSpecs, 'current')).toHaveValue(measurementInput('0.02', 'A', 'en'));
  await expect(specField(freshSpecs, 'current')).toBeDisabled();
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  expect(definitionCreated.commands).toHaveLength(1);
  await definitionCreated.stop();
  expect(await sql('SELECT count(*) FROM app.attribute_definitions')).toBe('1');
  expect(await sql(`SELECT number_value FROM app.product_attributes WHERE product_id=${literal(frozen.payload.id)} AND attribute_id='${currentDefinition.id}'`)).toBe('0.02');
  console.log('PASS: predefined specifications without definition rows and lost first-definition response recovery');
  await categoryPicker.selectOption({ label: m.typeNames.BJT });
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  expect(await sql(`SELECT code FROM app.products WHERE id=${literal(frozen.payload.id)}`)).toBe(frozen.payload.code);
  expect(await sql(`SELECT c.name FROM app.products p JOIN app.categories c ON c.id=p.category_id WHERE p.id=${literal(frozen.payload.id)}`)).toBe('Bipolar transistors');
  const legacyId = crypto.randomUUID();
  await sql(`INSERT INTO app.categories(id,name) VALUES ('${legacyId}', 'Legacy parts'); UPDATE app.products SET category_id='${legacyId}' WHERE id=${literal(frozen.payload.id)};`);
  await page.goto(`${origin}/en/admin/products/${frozen.payload.id}`);
  await expect(categoryPicker).toHaveValue(legacyId);
  await page.getByLabel(fieldLabel(`${m.price} (NOK)`)).fill('2');
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  expect(await sql(`SELECT category_id FROM app.products WHERE id=${literal(frozen.payload.id)}`)).toBe(legacyId);
  await categoryPicker.selectOption({ label: m.typeNames.MIS });
  await categoryPicker.selectOption(legacyId); // An unsaved selection can be undone.
  await sql(`UPDATE app.products SET category_id=NULL WHERE id=${literal(frozen.payload.id)}`);
  await page.reload();
  await expect(categoryPicker).toHaveValue('');
  await page.getByLabel(fieldLabel(`${m.price} (NOK)`)).fill('3');
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  expect(await sql(`SELECT category_id IS NULL AND code=${literal(frozen.payload.code)} FROM app.products WHERE id=${literal(frozen.payload.id)}`)).toBe('t');
  console.log('PASS: standard categories in empty database, automatic MIS prefix, lost category reply recovery, immutable codes and legacy/uncategorized preservation');
  await sql("SET ampoteket.test_seed = 'disposable-only';\n" + generateSeedSql());
  expect(await sql('SELECT count(*) FROM app.cabinets WHERE NOT is_archived')).toBe('12');
  expect(await sql('SELECT count(*) FROM app.bins WHERE NOT is_archived')).toBe('492');
  // A definite rejection ends the frozen attempt. The same unsaved UUID can
  // then choose another category and must receive that category's prefix.
  const resumedId = crypto.randomUUID();
  const resistorCategoryId = await sql("SELECT id FROM app.categories WHERE name='Resistors'");
  const rejectedDraft = { userId: staffId, revision: null, payload: { id: resumedId, code: 'RES-A3F09', name_nb: 'Gjenopprettet utkast', name_en: 'Recovered draft', description: null, category_id: resistorCategoryId, bin_id: null, unit_code: 'missing_unit', stock_step: '1', sale_step: '1', sale_unit_price_nok: '0', minimum_stock: '0', datasheet_url: null, is_active: false } };
  await page.evaluate(command => sessionStorage.setItem('ampoteket:admin-product:v1', JSON.stringify(command)), rejectedDraft);
  await page.goto(`${origin}/en/admin/products/${resumedId}`);
  await page.getByRole('button', { name: m.retrySave, exact: true }).click();
  await expect(page.getByText(m.failed, { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: m.unit, exact: true }).selectOption('pcs');
  await categoryCard(m.typeNames.MIS).click();
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  expect(await sql(`SELECT code FROM app.products WHERE id='${resumedId}'`)).toMatch(/^MIS-[A-F0-9]{5}$/);
  console.log('PASS: rejected resumed creation changes prefix with category while retaining product UUID');
  const longName = 'Browser acceptance resistor with a deliberately long descriptive name for a narrow phone screen';
  const binId = await sql("SELECT id FROM app.bins WHERE NOT is_archived ORDER BY id LIMIT 1");
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
  expect(await sql("SELECT canonical_unit FROM app.attribute_definitions WHERE code='browser_test_voltage'")).toBe('V');
  await page.getByRole('link', { name: m.newProduct, exact: true }).click();
  await categoryCard(m.typeNames.CAP).click();
  await page.getByLabel(fieldLabel(m.nameNb)).fill('Motstand for nettlesertest med langt navn på en smal mobilskjerm');
  await page.getByLabel(fieldLabel(m.nameEn)).fill(longName);
  await page.getByLabel(fieldLabel(`${m.price} (NOK)`)).fill('999999999998.999999');
  await page.locator('#product-placement-trigger').click();
  await chooseDrawer(page.getByRole('group', { name: m.placement, exact: true }), binId);
  await page.getByRole('button', { name: m.closeDrawer, exact: true }).click();
  await page.getByRole('switch', { name: m.activeLabel, exact: true }).check();
  const draftSpecs = page.locator('.specifications');
  const draftSpecIds = {
    numeric: await sql("SELECT id FROM app.attribute_definitions WHERE code='capacitance'"),
    boolean: await sql("SELECT id FROM app.attribute_definitions WHERE code='polarised'"),
    text: await sql("SELECT id FROM app.attribute_definitions WHERE code='package'")
  };
  await specField(draftSpecs, 'capacitance').fill('0.000000000005');
  await specField(draftSpecs, 'polarised').selectOption('false');
  await specField(draftSpecs, 'package').fill('Radial');
  const created = await lostResponse(page, 'amp_products', 'POST', () => page.getByRole('button', { name: m.save, exact: true }).click());
  await expect(page.getByText(m.unknown, { exact: true })).toBeVisible();
  const createdBody = JSON.parse(created.commands[0]);
  const productId: string = createdBody.id;
  expect(createdBody.code).toMatch(/^CAP-[A-F0-9]{5}$/);
  await page.reload();
  await page.getByRole('button', { name: m.retrySave, exact: true }).click();
  await expect(page).toHaveURL(`${origin}/en/admin/products/${productId}`);
  expect(created.commands).toHaveLength(1);
  await created.stop();
  expect(await sql(`SELECT count(*) FROM app.products WHERE id=${literal(productId)}`)).toBe('1');
  expect(await sql(`SELECT sale_unit_price_nok FROM app.products WHERE id=${literal(productId)}`)).toBe('999999999998.999999');
  expect(await sql(`SELECT number_value FROM app.product_attributes WHERE product_id=${literal(productId)} AND attribute_id='${draftSpecIds.numeric}'`)).toBe('0.000000000005');
  expect(await sql(`SELECT boolean_value FROM app.product_attributes WHERE product_id=${literal(productId)} AND attribute_id='${draftSpecIds.boolean}'`)).toBe('f');
  expect(await sql(`SELECT text_value FROM app.product_attributes WHERE product_id=${literal(productId)} AND attribute_id='${draftSpecIds.text}'`)).toBe('Radial');
  console.log('PASS: numeric, false boolean and text specifications staged before product creation survive lost response and reload');

  await page.goto(`${origin}/en/admin/products/${productId}`);
  await expect(page.getByLabel(fieldLabel(`${m.price} (NOK)`))).toHaveValue('999999999998.999999');
  await expect(page.getByRole('combobox', { name: m.unit, exact: true })).toBeDisabled();
  const savedUnit = await page.getByRole('combobox', { name: m.unit, exact: true }).inputValue();
  await expect(page.getByLabel(fieldLabel(`${m.stockStep} (${savedUnit})`))).toBeDisabled();

  await expect(page.getByRole('heading', { level: 1, name: createdBody.code, exact: true })).toBeVisible();
  await expect(page.locator('[aria-current="page"]').filter({ hasText: createdBody.code })).toBeVisible();
  await expect(page.getByRole('link', { name: m.back, exact: true })).toHaveCount(0);
  await page.locator('#product-placement-trigger').click();
  const placement = page.getByRole('group', { name: m.placement, exact: true });
  const otherBinId = await sql(`SELECT id FROM app.bins WHERE cabinet_id=(SELECT cabinet_id FROM app.bins WHERE id=${literal(binId)}) AND id<>${literal(binId)} ORDER BY id LIMIT 1`);
  const originalDrawer = placement.locator(`[data-item-id="${binId}"]`);
  const targetDrawer = placement.locator(`[data-item-id="${otherBinId}"]`);
  const moveDialog = page.getByRole('alertdialog', { name: m.moveTitle, exact: true });
  await page.getByRole('button', { name: m.clearPlacement, exact: true }).click();
  await placement.locator(`[data-item-id="${await sql(`SELECT cabinet_id FROM app.bins WHERE id=${literal(binId)}`)}"]`).click();
  await originalDrawer.click();
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
  expect(await sql(`SELECT bin_id FROM app.products WHERE id=${literal(productId)}`)).toBe(binId);
  await targetDrawer.click();
  await moveDialog.getByRole('button', { name: m.confirmMove, exact: true }).click();
  await expect(targetDrawer).toHaveAttribute('aria-current', 'true');
  await expect(targetDrawer).toBeFocused();
  expect(await sql(`SELECT bin_id FROM app.products WHERE id=${literal(productId)}`)).toBe(binId);
  await page.getByRole('button', { name: m.closeDrawer, exact: true }).click();
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  expect(await sql(`SELECT bin_id FROM app.products WHERE id=${literal(productId)}`)).toBe(otherBinId);
  await page.locator('#product-placement-trigger').click();
  await originalDrawer.click();
  await moveDialog.getByRole('button', { name: m.confirmMove, exact: true }).click();
  await page.getByRole('button', { name: m.closeDrawer, exact: true }).click();
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  expect(await sql(`SELECT bin_id FROM app.products WHERE id=${literal(productId)}`)).toBe(binId);
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
  await page.locator('#product-placement-trigger').click();
  await page.getByRole('button', { name: m.clearPlacement, exact: true }).click();
  await page.getByRole('button', { name: m.closeDrawer, exact: true }).click();
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  expect(await sql(`SELECT NOT is_active AND bin_id IS NULL FROM app.products WHERE id=${literal(productId)}`)).toBe('t');
  await page.locator('#product-placement-trigger').click();
  await chooseDrawer(page.getByRole('group', { name: m.placement, exact: true }), binId);
  await page.getByRole('button', { name: m.closeDrawer, exact: true }).click();
  await page.getByRole('switch', { name: m.activeLabel, exact: true }).check();
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: m.category, exact: true }).selectOption({ label: m.typeNames.CAP });
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  const specs = page.locator('.specifications');
  const attributeIds = { numeric: await sql("SELECT id FROM app.attribute_definitions WHERE code='capacitance'"),
    boolean: await sql("SELECT id FROM app.attribute_definitions WHERE code='polarised'"), text: await sql("SELECT id FROM app.attribute_definitions WHERE code='package'") };
  const specValue = (id: string, column: string) => sql(`SELECT ${column} FROM app.product_attributes WHERE product_id='${productId}' AND attribute_id='${id}'`);
  await expect(specField(specs, 'capacitance')).toHaveValue(measurementInput('0.000000000005', 'F', 'en'));
  await specField(specs, 'capacitance').fill('0.000000000009');
  await sql(`UPDATE app.product_attributes SET number_value=0.000000000007 WHERE product_id='${productId}' AND attribute_id='${attributeIds.numeric}'`);
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
  expect(await sql(`SELECT count(*) FROM app.product_attributes WHERE product_id='${productId}' AND attribute_id='${attributeIds.boolean}'`)).toBe('0');
  await specField(specs, 'polarised').selectOption('false');
  await specField(specs, 'package').fill('SMD 0805');
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  expect(await specValue(attributeIds.boolean, 'boolean_value')).toBe('f');
  expect(await specValue(attributeIds.text, 'text_value')).toBe('SMD 0805');
  await page.getByRole('combobox', { name: m.category, exact: true }).selectOption({ label: m.typeNames.RES });
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  // Recorded fields outside the new category stay editable; clearing removes the value.
  await specField(specs, 'capacitance').fill('');
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  expect(await sql(`SELECT count(*) FROM app.product_attributes WHERE product_id='${productId}' AND attribute_id='${attributeIds.numeric}'`)).toBe('0');
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
  const customCreated = await lostResponse(page, 'amp_attribute_definitions', 'POST', () => newType.getByRole('button', { name: m.saveReference, exact: true }).click());
  await expect(newType.getByText(m.unknown, { exact: true })).toBeVisible();
  await page.reload();
  await specs.getByRole('button', { name: m.referenceRecovery, exact: true }).click();
  await expect(newType.getByLabel(fieldLabel(m.definitionLabel))).toHaveValue('Browser custom frequency');
  await newType.getByRole('button', { name: m.retrySave, exact: true }).click();
  await expect(newType).not.toBeVisible();
  expect(customCreated.commands).toHaveLength(1);
  await customCreated.stop();
  const customTypeId = await sql("SELECT id FROM app.attribute_definitions WHERE label='Browser custom frequency'");
  expect(await sql("SELECT count(*) FROM app.attribute_definitions WHERE label='Browser custom frequency'")).toBe('1');
  await specInput(specs, 'Browser custom frequency (Hz)').fill('123.000000001');
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  expect(await sql(`SELECT number_value FROM app.product_attributes WHERE product_id='${productId}' AND attribute_id='${customTypeId}'`)).toBe('123.000000001');
  console.log('PASS: inline specification type creation recovers a lost response after reload and immediately accepts a value');

  await page.goto(`${origin}/en/admin/products/new`);
  await categoryCard(m.typeNames.CAP).click();
  await page.getByLabel(fieldLabel(m.nameNb)).fill('Delvis spesifikasjonslagring');
  await page.getByLabel(fieldLabel(m.nameEn)).fill('Partial specification save');
  await specField(specs, 'capacitance').fill('0.000000000003');
  const rejectedAttribute = `${api.origin}/rest/v1/amp_product_attributes*`;
  await page.route(rejectedAttribute, route => route.request().method() === 'POST'
    ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: '23514', message: 'Injected specification rejection' }) })
    : route.continue());
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page.getByText(m.specificationsIncomplete, { exact: true })).toBeVisible();
  const partialId = await sql(`SELECT id FROM app.products WHERE name_en=${literal(`${en.categories.capacitors} · Partial specification save`)}`);
  expect(partialId).toMatch(/^[0-9a-f-]{36}$/);
  expect(await sql(`SELECT count(*) FROM app.product_attributes WHERE product_id='${partialId}'`)).toBe('0');
  await page.unroute(rejectedAttribute);
  await sql(`UPDATE app.products SET description='Metadata changed after creation' WHERE id='${partialId}'`);
  await page.reload();
  await page.getByRole('button', { name: m.reviewSpecifications, exact: true }).click();
  await expect(page.getByText(m.specificationMetadataKept, { exact: true })).toBeVisible();
  await expect(specField(specs, 'capacitance')).toHaveValue(measurementInput('0.000000000003', 'F', 'en'));
  await specField(specs, 'capacitance').fill('0.000000000004');
  await page.getByRole('button', { name: m.saveReviewedSpecifications, exact: true }).click();
  await expect(page).toHaveURL(`${origin}/en/admin/products/${partialId}`);
  expect(await sql(`SELECT description FROM app.products WHERE id='${partialId}'`)).toBe('Metadata changed after creation');
  expect(await sql(`SELECT number_value FROM app.product_attributes WHERE product_id='${partialId}' AND attribute_id='${draftSpecIds.numeric}'`)).toBe('0.000000000004');
  expect(await sql(`SELECT count(*) FROM app.products WHERE name_en=${literal(`${en.categories.capacitors} · Partial specification save`)}`)).toBe('1');
  console.log('PASS: partial specification failure survives reload and explicit correction preserves current product metadata');

  await page.goto(`${origin}/en/admin/products/new`);
  await categoryCard(m.typeNames.RES).click();
  await page.getByLabel(fieldLabel(m.nameNb)).fill('Kollisjonstest');
  await page.getByLabel(fieldLabel(m.nameEn)).fill('Code collision proof');
  await page.getByLabel(m.openingStock, { exact: false }).fill('7');
  const collisionBodies: { id: string; code: string }[] = [];
  const productEndpoint = `${api.origin}/rest/v1/amp_products*`;
  await page.route(productEndpoint, async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON(); collisionBodies.push(body);
      if (collisionBodies.length === 1) await sql(`INSERT INTO app.products(code,name_nb,name_en,unit_code,stock_step,sale_step,sale_unit_price_nok) VALUES (${literal(body.code)},'Opptatt kode','Occupied code','pcs',1,1,0)`);
    }
    await route.continue();
  });
  await page.getByRole('button', { name: m.save, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`^${origin}/en/admin/products/[0-9a-f-]{36}$`));
  await page.unroute(productEndpoint);
  expect(collisionBodies).toHaveLength(2); expect(collisionBodies[1].id).toBe(collisionBodies[0].id); expect(collisionBodies[1].code).not.toBe(collisionBodies[0].code);
  expect(await sql(`SELECT count(*) FROM app.products WHERE name_en=${literal(`${en.categories.resistors} · Code collision proof`)}`)).toBe('1');
  const openedId = await sql(`SELECT id FROM app.products WHERE name_en=${literal(`${en.categories.resistors} · Code collision proof`)}`);
  await expect(page.locator('.product-stock').getByText('7 pieces', { exact: true })).toBeVisible();
  expect(await sql(`SELECT quantity||'/'||(last_counted_at IS NOT NULL) FROM app.inventory WHERE product_id=${literal(openedId)}`)).toBe('7/true');
  await page.goto(`${origin}/en/admin/products/new`);
  await categoryCard(m.typeNames.RES).click();
  await page.getByLabel(fieldLabel(m.nameNb)).fill('Tapt svar med lager');
  await page.getByLabel(fieldLabel(m.nameEn)).fill('Lost reply with stock');
  await page.getByLabel(m.openingStock, { exact: false }).fill('3');
  const openedLost = await lostResponse(page, 'amp_products', 'POST', () => page.getByRole('button', { name: m.save, exact: true }).click());
  await expect(page.getByText(m.unknown, { exact: true })).toBeVisible();
  const openedLostId: string = JSON.parse(openedLost.commands[0]).id;
  await page.reload();
  await expect(page.getByLabel(m.openingStock, { exact: false })).toHaveValue('3');
  await page.getByRole('button', { name: m.retrySave, exact: true }).click();
  await expect(page).toHaveURL(`${origin}/en/admin/products/${openedLostId}`);
  await openedLost.stop();
  expect(await sql(`SELECT quantity||'/'||(SELECT count(*) FROM app.stock_counts WHERE product_id=${literal(openedLostId)}) FROM app.inventory WHERE product_id=${literal(openedLostId)}`)).toBe('3/1');
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
  const counted = await lostResponse(page, 'rpc/amp_record_single_count', 'POST', () => count.getByRole('button', { name: c.saveCount, exact: true }).click(), true);
  await expect(count.getByText(c.unknown, { exact: true })).toBeVisible();
  await page.reload();
  await count.getByRole('button', { name: c.retryCount, exact: true }).click();
  await expect.poll(() => counted.commands.length).toBe(2);
  await expect(count.getByText(c.unknown, { exact: true })).toHaveCount(0);
  counted.release();
  await expect(count.getByRole('button', { name: c.countAgain, exact: true })).toBeVisible();
  expect(counted.commands).toHaveLength(2); expect(counted.commands[1]).toBe(counted.commands[0]);
  await counted.stop();
  expect(await sql(`SELECT count(*) FROM app.stock_counts WHERE product_id=${literal(productId)}`)).toBe('1');
  await count.getByRole('button', { name: c.countAgain, exact: true }).click();
  await count.getByLabel(c.observed, { exact: false }).fill('10');
  await count.getByLabel(fieldLabel(c.pauseConfirmed)).check();
  await count.getByRole('button', { name: c.saveCount, exact: true }).click();
  await expect(count.getByRole('button', { name: c.countAgain, exact: true })).toBeVisible();
  expect(await sql(`SELECT count(*) FROM app.stock_counts WHERE product_id=${literal(productId)}`)).toBe('2');
  expect(await sql(`SELECT count(*) FROM app.inventory_movements WHERE product_id=${literal(productId)}`)).toBe('1');
  await count.getByRole('button', { name: c.countAgain, exact: true }).click();
  await count.getByLabel(c.observed, { exact: false }).fill('11');
  await count.getByLabel(fieldLabel(c.pauseConfirmed)).check();
  await sql(`SELECT set_config('request.jwt.claims', '${JSON.stringify({ sub: staffId, role: 'authenticated' })}', false); SET ROLE authenticated;
    SELECT public.amp_adjust_stock('${crypto.randomUUID()}', '[{"product_id":"${productId}","quantity_delta":"1"}]', 'Registered movement after the count form opened');`);
  await count.getByRole('button', { name: c.saveCount, exact: true }).click();
  await expect(count.getByText(c.stale, { exact: true })).toBeVisible();
  expect(await sql(`SELECT count(*) FROM app.stock_counts WHERE product_id=${literal(productId)}`)).toBe('2');
  await count.getByRole('button', { name: c.recount, exact: true }).click();
  await expect(count.getByLabel(c.observed, { exact: false })).toHaveValue('');
  await count.getByLabel(c.observed, { exact: false }).fill('12');
  await count.getByLabel(fieldLabel(c.pauseConfirmed)).check();
  await count.getByRole('button', { name: c.saveCount, exact: true }).click();
  await expect(count.getByRole('button', { name: c.countAgain, exact: true })).toBeVisible();
  expect(await sql(`SELECT quantity FROM app.inventory WHERE product_id=${literal(productId)}`)).toBe('12');
  console.log('PASS: single count lost acknowledgement/reload, zero-difference history and mandatory fresh recount');

  count = page.locator('.count-section');
  await page.goto(`${origin}/en/admin/counts`);
  await page.getByLabel(fieldLabel(c.batchTitle)).fill('Browser batch with several recorded observations');
  const started = await lostResponse(page, 'rpc/amp_start_count_batch', 'POST', () => page.getByRole('button', { name: c.start, exact: true }).click(), true);
  await expect(page.getByText(c.unknownStart, { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: c.retryStart, exact: true }).click();
  // The page's own in-flight command must not read back as an interrupted one.
  await expect.poll(() => started.commands.length).toBe(2);
  await expect(page.getByText(c.unknownStart, { exact: true })).toHaveCount(0);
  started.release();
  await expect(page.getByRole('combobox', { name: en.adminOrders.product, exact: true })).toBeVisible();
  expect(started.commands).toHaveLength(2); expect(started.commands[1]).toBe(started.commands[0]);
  await started.stop();
  const batchId = page.url().split('/').at(-1)!;
  // Count detail picks products with the shared order combobox (search by code, then choose).
  const productCode = await sql(`SELECT code FROM app.products WHERE id=${literal(productId)}`);
  await page.getByRole('combobox', { name: en.adminOrders.product, exact: true }).click();
  await page.getByRole('combobox', { name: en.adminOrders.searchProduct, exact: true }).fill(productCode);
  await page.getByRole('option').filter({ hasText: productCode }).click();
  await count.getByRole('button', { name: c.beginCount, exact: true }).click();
  await count.getByLabel(c.observed, { exact: false }).fill('0');
  await count.getByLabel(fieldLabel(c.note)).fill('Keep this physical observation during a failed refresh');
  const historyRead = `${api.origin}/rest/v1/amp_stock_counts*`;
  await page.route(historyRead, route => route.abort('failed'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText(c.unavailable, { exact: true })).toBeVisible();
  await expect(count.getByLabel(c.observed, { exact: false })).toHaveValue('0');
  await expect(count.getByLabel(fieldLabel(c.note))).toHaveValue('Keep this physical observation during a failed refresh');
  await expect(count.getByRole('button', { name: c.saveCount, exact: true })).toBeDisabled();
  await page.unroute(historyRead);
  await page.getByRole('button', { name: c.retryLoad, exact: true }).click();
  await expect(page.getByText(c.unavailable, { exact: true })).toHaveCount(0);
  await expect(count.getByLabel(c.observed, { exact: false })).toHaveValue('0');
  console.log('PASS: failed batch refresh preserves physical count input and blocks submission until retry');

  await count.getByLabel(fieldLabel(c.pauseConfirmed)).check();
  await count.getByRole('button', { name: c.saveCount, exact: true }).click();
  await expect(page.locator('.observations [data-slot="item"]')).toHaveCount(1);
  expect(await sql(`SELECT quantity FROM app.inventory WHERE product_id=${literal(productId)}`)).toBe('0');
  // Finishing confirms in the shared AlertDialog; its action sends the command.
  await page.getByRole('button', { name: c.finish, exact: true }).click();
  const finished = await lostResponse(page, 'rpc/amp_finish_count_batch', 'POST', () => page.getByRole('alertdialog').getByRole('button', { name: c.finish, exact: true }).click(), true);
  await expect(page.getByText(c.unknownFinish, { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: c.retryFinish, exact: true }).click();
  await expect.poll(() => finished.commands.length).toBe(2);
  await expect(page.getByText(c.unknownFinish, { exact: true })).toHaveCount(0);
  finished.release();
  await expect(page.locator('.finish-section')).toHaveCount(0);
  expect(finished.commands).toHaveLength(2); expect(finished.commands[1]).toBe(finished.commands[0]);
  await finished.stop();
  expect(await sql(`SELECT finished_at IS NOT NULL FROM app.count_batches WHERE id=${literal(batchId)}`)).toBe('t');
  expect(await sql(`SELECT quantity FROM app.inventory WHERE product_id=${literal(productId)}`)).toBe('0');

  const abandoned = (await sql(`SELECT set_config('request.jwt.claims', '${JSON.stringify({ sub: otherId, role: 'authenticated' })}', false); SET ROLE authenticated; SELECT public.amp_start_count_batch('${crypto.randomUUID()}', 'Other owner batch')->>'batch_id';`)).split('\n').at(-1)!;
  await page.goto(`${origin}/en/admin/counts/${abandoned}`);
  await expect(page.getByText(c.ownerOnly, { exact: true })).toBeVisible();
  await expect(page.locator('.finish-section')).toHaveCount(0);
  await sql(`UPDATE app.staff_members SET is_active=false WHERE auth_user_id='${otherId}';`);
  await page.reload();
  await page.getByLabel(fieldLabel(c.closureReason)).fill('Original operator left; retain all previous observations.');
  await page.getByRole('button', { name: c.closeAbandoned, exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: c.closeAbandoned, exact: true }).click();
  await expect(page.locator('.finish-section')).toHaveCount(0);
  expect(await sql(`SELECT b.owner_id<>b.finished_by AND b.finish_reason IS NOT NULL AND b.finished_at IS NOT NULL FROM app.count_batches b WHERE id='${abandoned}'`)).toBe('t');
  console.log('PASS: batch start/count/finish with original retries, immediate zero count and eligible abandoned-owner closure');
  const sh = en.adminShelf;
  const cabinetLabel = 'Browser cabinet, "quoted": a long placement description';
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
  const liveBinIds = async (cabinet: string): Promise<string[]> => JSON.parse(await sql(`SELECT coalesce(jsonb_agg(id ORDER BY id),'[]') FROM app.bins WHERE cabinet_id='${cabinet}' AND NOT is_archived`));
  await page.goto(`${origin}/en/admin/shelf`);
  await expect(page.locator('section[aria-labelledby="wall-title"]').getByRole('button')).toHaveCount(12);
  await page.locator('section[aria-labelledby="wall-title"]').getByRole('button', { name: 'C2', exact: true }).click();
  const seededSpans = page.locator('[data-cabinet-editor]').getByRole('group', { name: sh.layoutPreview, exact: true });
  await expect(seededSpans.getByRole('button', { name: `A1–D1 · ${sh.emptyDrawer}`, exact: true })).toBeVisible();
  await expect(seededSpans.getByRole('button', { name: `C2–D2 · ${sh.emptyDrawer}`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: sh.newCabinet, exact: true }).click();
  await page.getByLabel(fieldLabel(sh.label)).fill(cabinetLabel);
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
  const layoutCreated = await lostResponse(page, 'rpc/amp_save_shelf_layout', 'POST', () => page.getByRole('button', { name: sh.save, exact: true }).click());
  await expect(page.getByText(sh.unknown, { exact: true })).toBeVisible();
  const newLayout = JSON.parse(layoutCreated.commands[0]);
  const cabinetId: string = newLayout.p_cabinet.id;
  expect(newLayout.p_before).toBeNull(); expect(newLayout.p_before_bins).toEqual([]);
  expect(newLayout.p_bins).toHaveLength(16);
  const initialBins = await liveBinIds(cabinetId);
  expect(initialBins).toEqual(newLayout.p_bins.map((bin: { id: string }) => bin.id).sort());
  await page.reload();
  await page.getByRole('button', { name: sh.retry, exact: true }).click();
  await expect(page.getByText(sh.saved, { exact: true })).toBeVisible();
  expect(layoutCreated.commands).toHaveLength(2);
  expect(layoutCreated.commands[1]).toBe(layoutCreated.commands[0]); await layoutCreated.stop();
  expect(await liveBinIds(cabinetId)).toEqual(initialBins);
  expect(await sql(`SELECT count(*) FROM app.bins WHERE cabinet_id='${cabinetId}' AND row_span=1 AND col_span=1`)).toBe('16');
  // Privileged RPCs are tested over HTTP with real Auth credentials, not SQL alone.
  const authResponse = await fetch(`${api.origin}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: publicKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: nonstaffEmail, password })
  });
  assert.ok(authResponse.ok, 'Temporary nonstaff Auth session created');
  const nonstaffSession = await authResponse.json() as { access_token: string; refresh_token: string };
  assert.ok(typeof nonstaffSession.access_token === 'string' && typeof nonstaffSession.refresh_token === 'string');
  secrets.push(nonstaffSession.access_token, nonstaffSession.refresh_token);
  const deniedCabinetId = crypto.randomUUID();
  const deniedLayout = structuredClone(newLayout);
  deniedLayout.p_request_id = crypto.randomUUID();
  deniedLayout.p_cabinet = { ...deniedLayout.p_cabinet, id: deniedCabinetId, code: `C-${deniedCabinetId}`, outer_row: 29, outer_col: 10 };
  deniedLayout.p_bins = deniedLayout.p_bins.map((bin: Record<string, unknown>) => {
    const id = crypto.randomUUID(); return { ...bin, id, code: `B-${id}`, cabinet_id: deniedCabinetId };
  });
  for (const [kind, key, token] of [
    ['nonstaff', publicKey, nonstaffSession.access_token],
    ['anonymous', publicKey, anonKey],
    ['service role', serviceKey, serviceKey]
  ] as const) {
    const response = await fetch(`${api.origin}/rest/v1/rpc/amp_save_shelf_layout`, {
      method: 'POST', headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(deniedLayout)
    });
    expect([401, 403], `${kind} cannot save a shelf layout`).toContain(response.status);
    if (kind === 'nonstaff') expect((await response.json() as { message: string }).message).toBe('STAFF_REQUIRED');
    expect(await sql(`SELECT count(*) FROM app.cabinets WHERE id='${deniedCabinetId}'`)).toBe('0');
    expect(await sql(`SELECT count(*) FROM app.bins WHERE cabinet_id='${deniedCabinetId}'`)).toBe('0');
  }
  console.log('PASS: real HTTP shelf-layout permission boundary for staff, nonstaff, anonymous and service role');
  const firstBin = await sql(`SELECT id FROM app.bins WHERE cabinet_id='${cabinetId}' AND inner_row=1 AND inner_col=1`);
  const secondBin = await sql(`SELECT id FROM app.bins WHERE cabinet_id='${cabinetId}' AND inner_row=2 AND inner_col=1`);
  const occupiedNeighbor = await sql(`SELECT id FROM app.bins WHERE cabinet_id='${cabinetId}' AND inner_row=1 AND inner_col=3`);
  await sql(`UPDATE app.products SET is_active=false,bin_id='${firstBin}' WHERE id='${productId}';
    UPDATE app.products SET is_active=false,bin_id='${occupiedNeighbor}' WHERE id='${frozen.payload.id}';`);
  expect(await sql(`SELECT quantity FROM app.inventory WHERE product_id='${productId}'`)).toBe('0');
  // No standing refresh button (design-system §4.2); the map re-reads when the tab regains focus.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.locator('section[aria-labelledby="wall-title"]').getByRole('button', { name: 'F7', exact: true }).click();
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
  })).toEqual(['solid', '1px']);
  await emptyDrawer.click(); await expect(emptyDrawer).toHaveAttribute('aria-pressed', 'true');
  await chooseLayoutDrawer(layout, firstBin);
  await expect(preview.getByRole('button', { name: 'A1', exact: true })).not.toHaveClass(/\bempty\b/);
  await dragOneColumnWider();
  await expect(layout.getByRole('slider', { name: sh.resizeHandle, exact: true })).toHaveAttribute('aria-valuenow', '2');
  expect(await sql(`SELECT col_span FROM app.bins WHERE id='${firstBin}'`)).toBe('1');
  await layout.getByRole('button', { name: sh.widenDrawer, exact: true }).click();
  await expect(page.locator('[data-sonner-toast]').getByText(sh.notEmpty, { exact: true })).toBeVisible();
  await expect(preview.getByRole('button', { name: 'A1–B1', exact: true })).not.toHaveClass(/\bempty\b/);
  await expect(layout.getByRole('slider', { name: sh.resizeHandle, exact: true })).toHaveAttribute('aria-valuenow', '2');
  await chooseLayoutDrawer(layout, secondBin);
  await layout.getByRole('button', { name: sh.widenDrawer, exact: true }).click();
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
  expect(await sql(`SELECT count(*) FROM app.bins WHERE cabinet_id='${cabinetId}' AND col_span=2`)).toBe('2');
  expect(await sql(`SELECT bin_id FROM app.products WHERE id='${productId}'`)).toBe(firstBin);
  expect(await sql(`SELECT bin_id FROM app.products WHERE id='${frozen.payload.id}'`)).toBe(occupiedNeighbor);
  expect(await liveBinIds(cabinetId)).toHaveLength(14);
  console.log('PASS: selectable muted empty drawers, zero-stock/inactive assignments remain occupied, pointer/tap/keyboard width changes, cancelled drags, source identity and assigned-neighbour protection');
  // Fixture: two physical drawers have been taken out, providing a destination for a move.
  await sql(`UPDATE app.bins SET is_archived=true WHERE cabinet_id='${cabinetId}' AND inner_row=3 AND inner_col IN (1,2)`);
  // No standing refresh button (design-system §4.2); the map re-reads when the tab regains focus.
  // Wait for a drawer read that starts after the change, as a returning admin would.
  const reread = page.waitForResponse(response => response.url().includes('/rest/v1/amp_bins') && response.request().method() === 'GET');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await reread;
  await expect(page.locator('section[aria-labelledby="cabinet-title"]').getByRole('button', { name: 'A3', exact: true })).toHaveCount(0);
  await page.locator('section[aria-labelledby="cabinet-title"]').getByRole('button', { name: 'A1–B1', exact: true }).click();
  await expect(page.getByRole('link', { name: `${en.categories.resistors} · ${longName} reviewed`, exact: true })).toBeVisible();
  const drawerMenu = page.getByRole('menubar', { name: sh.drawerActions, exact: true });
  await drawerMenu.getByRole('menuitem', { name: sh.binKind, exact: true }).click();
  await expect(page.getByRole('menuitem', { name: sh.archiveBin, exact: true })).toBeDisabled();
  await page.getByRole('menuitem', { name: sh.moveDrawer, exact: true }).click();
  await layout.locator('[data-item-id="vacant:3:1"]').click();
  const moved = await lostResponse(page, 'amp_bins', 'PATCH', () => page.getByRole('alertdialog').getByRole('button', { name: sh.confirmAction, exact: true }).click());
  await expect(page.getByText(sh.unknown, { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: sh.retry, exact: true }).click();
  await expect(page.getByText(sh.saved, { exact: true })).toBeVisible();
  expect(moved.commands).toHaveLength(1); await moved.stop();
  expect(await sql(`SELECT inner_row=3 AND col_span=2 FROM app.bins WHERE id='${firstBin}'`)).toBe('t');
  expect(await sql(`SELECT bin_id FROM app.products WHERE id='${productId}'`)).toBe(firstBin);
  expect(await sql(`SELECT count(*) FROM app.bins WHERE cabinet_id='${cabinetId}' AND inner_row=1 AND inner_col IN (1,2)`)).toBe('0');
  expect(await liveBinIds(cabinetId)).toHaveLength(12);
  await page.locator('section[aria-labelledby="wall-title"]').getByRole('button', { name: 'F7', exact: true }).click();
  await page.locator('section[aria-labelledby="cabinet-title"]').getByRole('button', { name: 'A3–B3', exact: true }).click();
  await drawerMenu.getByRole('menuitem', { name: sh.binKind, exact: true }).click();
  await page.getByRole('menuitem', { name: sh.moveDrawer, exact: true }).click();
  await layout.locator(`[data-item-id="${secondBin}"]`).click();
  const swapped = await lostResponse(page, 'rpc/amp_swap_bins', 'POST', () => page.getByRole('alertdialog').getByRole('button', { name: sh.confirmAction, exact: true }).click());
  await expect(page.getByText(sh.unknown, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: sh.retry, exact: true }).click();
  const drawerSwapToast = page.locator('[data-sonner-toast]').filter({ has: page.getByText(
    sh.swapPreview(`${sh.cabinet('F7')} · ${sh.bin('A3–B3')}`, `${sh.cabinet('F7')} · ${sh.bin('A2–B2')}`), { exact: true }
  ) });
  await expect(drawerSwapToast.getByText(sh.positionsSwapped, { exact: true })).toBeVisible();
  expect(swapped.commands).toHaveLength(2); expect(swapped.commands[1]).toBe(swapped.commands[0]); await swapped.stop();
  expect(await sql(`SELECT inner_row FROM app.bins WHERE id='${firstBin}'`)).toBe('2');
  expect(await sql(`SELECT inner_row FROM app.bins WHERE id='${secondBin}'`)).toBe('3');
  expect(await sql(`SELECT bin_id FROM app.products WHERE id='${productId}'`)).toBe(firstBin);
  expect(await liveBinIds(cabinetId)).toHaveLength(12);
  console.log('PASS: generated grid with one atomic save, identical lost-response replay, configured spans, drawer moves/swaps preserve products and vacancies');

  const beforeGrowth = await liveBinIds(cabinetId);
  await expect(page.locator('[data-cabinet-editor]')).toBeVisible();
  await previewSize('4', '5');
  await page.getByRole('button', { name: sh.save, exact: true }).click();
  await expect(page.getByText(sh.saved, { exact: true })).toBeVisible();
  const grown = await liveBinIds(cabinetId);
  expect(grown).toHaveLength(18); expect(grown).toEqual(expect.arrayContaining(beforeGrowth));
  expect(await sql(`SELECT bin_id FROM app.products WHERE id='${productId}'`)).toBe(firstBin);
  expect(await sql(`SELECT count(*) FROM app.bins WHERE cabinet_id='${cabinetId}' AND inner_row=1 AND inner_col IN (1,2)`)).toBe('2');
  await expect(page.locator('[data-cabinet-editor]')).toBeVisible();
  await previewSize('1', '5');
  await expect(page.locator('[data-sonner-toast]').getByText(sh.notEmpty, { exact: true })).toBeVisible();
  expect(await liveBinIds(cabinetId)).toEqual(grown);
  // Incremental resizing drops empty draft rows before the occupied row blocks it.
  // Discard that draft before checking drawer identities in the saved layout.
  await page.getByRole('button', { name: sh.discardChanges, exact: true }).click();
  await expect(page.locator('[data-cabinet-editor]')).toBeVisible();
  await chooseLayoutDrawer(layout, secondBin);
  await layout.getByRole('button', { name: sh.splitLayout, exact: true }).click();
  await previewSize('3', '5');
  // A competing physical move after opening the layout must invalidate its full snapshot.
  const concurrentlyMoved = await sql(`SELECT id FROM app.bins WHERE cabinet_id='${cabinetId}' AND inner_row=1 AND inner_col=4`);
  await sql(`UPDATE app.bins SET is_archived=true WHERE cabinet_id='${cabinetId}' AND inner_row=1 AND inner_col=1;
    UPDATE app.bins SET inner_col=1 WHERE id='${concurrentlyMoved}'`);
  await page.getByRole('button', { name: sh.save, exact: true }).click();
  await expect(page.getByText(sh.stale, { exact: true })).toBeVisible();
  expect(await sql(`SELECT inner_col FROM app.bins WHERE id='${concurrentlyMoved}'`)).toBe('1');
  expect(await sql(`SELECT inner_rows FROM app.cabinets WHERE id='${cabinetId}'`)).toBe('4');
  expect(await sql(`SELECT col_span FROM app.bins WHERE id='${secondBin}'`)).toBe('2');
  // The map re-reads by itself after a stale rejection; the admin reviews the fresh layout.
  await page.getByRole('button', { name: sh.reviewLayout, exact: true }).click();
  await expect(layout.getByRole('slider', { name: sh.resizeRows, exact: true })).toHaveAttribute('aria-valuenow', '4');
  await chooseLayoutDrawer(layout, concurrentlyMoved);
  await expect(layout.locator(`[data-item-id="${concurrentlyMoved}"]`)).toHaveAttribute('aria-label', `A1 · ${sh.emptyDrawer}`);
  await chooseLayoutDrawer(layout, secondBin);
  await layout.getByRole('button', { name: sh.splitLayout, exact: true }).click();
  await previewSize('3', '5');
  await page.getByRole('button', { name: sh.save, exact: true }).click();
  await expect(page.getByText(sh.saved, { exact: true })).toBeVisible();
  expect(await sql(`SELECT inner_rows=3 AND inner_cols=5 FROM app.cabinets WHERE id='${cabinetId}'`)).toBe('t');
  expect(await sql(`SELECT inner_row=3 AND inner_col=1 AND col_span=1 FROM app.bins WHERE id='${secondBin}'`)).toBe('t');
  expect(await sql(`SELECT sum(row_span*col_span) FROM app.bins WHERE cabinet_id='${cabinetId}' AND NOT is_archived`)).toBe('15');
  expect(await sql(`SELECT bin_id FROM app.products WHERE id='${productId}'`)).toBe(firstBin);
  console.log('PASS: explicit layout adjustment fills vacancies, preserves identities, blocks occupied shrink, and requires current review after a stale snapshot');

  // Larger drawers can also be configured before the cabinet's first save.
  await page.getByRole('button', { name: sh.newCabinet, exact: true }).click();
  await page.getByLabel(fieldLabel(sh.label)).fill('Browser second cabinet');
  await page.getByLabel(fieldLabel(sh.row)).fill('7');
  await page.getByLabel(fieldLabel(sh.column)).fill('G');
  await previewSize('2', '2');
  await layout.getByRole('group', { name: sh.layoutPreview, exact: true }).getByRole('button', { name: `A1 · ${sh.emptyDrawer}`, exact: true }).click();
  await layout.getByRole('button', { name: sh.widenDrawer, exact: true }).click();
  await expect(layout.locator('[data-item-id]')).toHaveCount(3);
  await page.getByRole('button', { name: sh.save, exact: true }).click();
  await expect(page.getByText(sh.saved, { exact: true })).toBeVisible();
  const secondCabinet = await sql("SELECT id FROM app.cabinets WHERE label='Browser second cabinet'");
  expect(await liveBinIds(secondCabinet)).toHaveLength(3);
  expect(await sql(`SELECT count(*) FROM app.bins WHERE cabinet_id='${secondCabinet}' AND col_span=2`)).toBe('1');
  await page.locator('section[aria-labelledby="wall-title"]').getByRole('button', { name: 'F7', exact: true }).click();
  await expect(page.locator('[data-cabinet-editor]')).toBeVisible();
  await page.getByRole('button', { name: sh.details, exact: true }).click();
  await expect(page.getByRole('button', { name: sh.archiveCabinetWithDrawers, exact: true })).toBeDisabled();
  await page.getByRole('button', { name: sh.moveCabinet, exact: true }).click();
  await page.getByRole('group', { name: sh.swapTarget, exact: true }).locator(`[data-item-id="${secondCabinet}"]`).click();
  await page.getByRole('button', { name: sh.swap, exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: sh.confirmAction, exact: true }).click();
  const cabinetSwapToast = page.locator('[data-sonner-toast]').filter({ has: page.getByText(
    sh.swapPreview(sh.cabinet('F7'), sh.cabinet('G7')), { exact: true }
  ) });
  await expect(cabinetSwapToast.getByText(sh.positionsSwapped, { exact: true })).toBeVisible();
  expect(await sql(`SELECT outer_col FROM app.cabinets WHERE id='${cabinetId}'`)).toBe('7');
  expect(await sql(`SELECT outer_col FROM app.cabinets WHERE id='${secondCabinet}'`)).toBe('6');
  expect(await sql(`SELECT bin_id FROM app.products WHERE id='${productId}'`)).toBe(firstBin);
  console.log('PASS: initial spanning layout and whole-cabinet swap retain drawer contents');
  // Placement cases deliberately unpublish this product; publish it again for public-label checks.
  await sql(`UPDATE app.products SET bin_id='${binId}',is_active=true WHERE id='${productId}'`);
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
    await geometry.getByLabel(fieldLabel(`${messages.adminProducts.price} (NOK)`)).focus();
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
    // Phones start with the product page's specifications and shelf map closed.
    if (width < 768) for (const id of ['specifications-title', 'map-title']) await geometry.locator(`#${id} button[aria-expanded="false"]`).click();
    await expect(geometry.getByText(messages.specificationLabels.polarised, { exact: true })).toBeVisible();
    await expect(geometry.getByText(messages.specificationLabels.package, { exact: true })).toBeVisible();
    const publicMap = geometry.locator('.shelf-map');
    await expect(publicMap.locator('.coordinate-list')).toHaveCount(0);
    const currentDrawer = publicMap.locator('.stage [data-item-id][aria-current="true"]');
    await expect(currentDrawer).toHaveCount(1);
    await expect(currentDrawer).not.toHaveClass(/empty/);
    await publicMap.getByRole('button', { name: messages.shelfMap.showWall, exact: true }).click();
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
      await geometry.locator('section[aria-labelledby="wall-title"]').getByRole('button', { name: address, exact: true }).click();
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
    await geometry.locator('section[aria-labelledby="wall-title"]').getByRole('button', { name: 'G7', exact: true }).click();
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
  const inventoryOnly = `${api.origin}/rest/v1/amp_inventory?*`;
  await page.route(inventoryOnly, route => route.abort('failed'));
  const searchProducts = page.getByLabel(fieldLabel(en.adminProducts.search));
  await searchProducts.focus();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByText(en.adminProducts.inventoryUnavailable, { exact: true })).toBeVisible();
  expect(await productCards.locator('h2 a').evaluateAll(links => links.map(link => link.getAttribute('href')))).toEqual(productOrder);
  await expect(searchProducts).toBeFocused();
  await expect(productCards.first().getByText(en.shop.unavailable, { exact: true })).toBeVisible();
  await page.unroute(inventoryOnly);
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
  const stockStep = await sql(`SELECT stock_step FROM app.products WHERE id=${literal(productId)}`);
  await expect(stockForm.getByText(en.adminStock.invalidQuantity(stockStep, false), { exact: true })).toBeVisible();
  await stockQuantity.fill(stockStep);
  const stockHistory = page.locator('section[aria-labelledby="stock-history-title"]');
  const previousHistory = await stockHistory.textContent();
  const inventoryRead = `${api.origin}/rest/v1/amp_inventory?*`;
  await page.route(inventoryRead, route => route.abort('failed'));
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByText(en.adminStock.unavailable, { exact: true })).toBeVisible();
  await expect(recordStock).toBeDisabled();
  await expect(stockQuantity).toHaveValue(stockStep); await expect(stockQuantity).toBeFocused();
  expect(await stockHistory.textContent()).toBe(previousHistory);
  await page.unroute(inventoryRead);
  await page.getByRole('button', { name: en.adminStock.retry, exact: true }).click();
  await expect(recordStock).toBeEnabled();
  await expect(stockReason).toHaveValue('Design consistency validation');
  await fits(page);

  // New audit entries prepend without throwing away older pages or an open row.
  await page.goto(`${origin}/en/admin/audit`);
  const auditRows = page.locator('[data-slot="item"][role="listitem"]');
  await expect(auditRows).toHaveCount(30);
  await page.getByRole('button', { name: en.adminAudit.more, exact: true }).click();
  await expect(auditRows).toHaveCount(60);
  const originalHead = await auditRows.first().locator('[data-slot="item-description"]').innerText();
  const headId = /Log entry (\d+)/.exec(originalHead)![1];
  const originalRow = auditRows.filter({ hasText: en.adminAudit.entryId(headId) });
  const disclosure = originalRow.getByRole('button', { name: en.adminAudit.details, exact: true });
  await disclosure.click(); await disclosure.focus();
  await sql(`UPDATE app.products SET description='Design audit refresh proof' WHERE id=${literal(productId)}`);
  const newHead = await sql('SELECT max(id) FROM app.audit_log');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(auditRows.first()).toContainText(en.adminAudit.entryId(newHead));
  await expect(auditRows).toHaveCount(61);
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  await expect(disclosure).toBeFocused();
  const auditRead = `${api.origin}/rest/v1/amp_audit_log?*`;
  await page.route(auditRead, route => route.abort('failed'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText(en.adminAudit.unavailable, { exact: true })).toBeVisible();
  await expect(auditRows).toHaveCount(61);
  await expect(disclosure).toBeFocused();
  await page.unroute(auditRead);
  await page.getByRole('button', { name: en.adminAudit.retry, exact: true }).click();
  await expect(page.getByText(en.adminAudit.unavailable, { exact: true })).toHaveCount(0);
  await fits(page);
  console.log('PASS: stock field validation and retained failed-read drafts; audit freshness keeps older pages, open details and focus');
  await page.goto(`${origin}/en/admin/shelf`);
  // Revoked (not merely no access) needs the reloaded page to have admitted this user first.
  await expect(page.getByRole('button', { name: sh.newCabinet, exact: true })).toBeVisible();
  await sql(`UPDATE app.staff_members SET is_active=false WHERE auth_user_id='${staffId}'`);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText(en.admin.revoked, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: sh.newCabinet, exact: true })).toHaveCount(0);
  console.log('PASS: both locales and themes at 360/1280, long-copy geometry, keyboard focus and access revocation');
  expect(diagnostics).toEqual([]);
  console.log('PASS: real admin Auth and operational pages');
} catch (error) {
  for (const [index, page] of (context?.pages() ?? []).entries()) await captureFailure(page, artifacts, String(index));
  throw error;
} finally { await close(); }
