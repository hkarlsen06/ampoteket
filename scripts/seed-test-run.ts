import { strict as assert } from 'node:assert';
import { readCompleteCatalog, lookupCatalogProduct, type CatalogAttribute } from '../src/lib/catalog';
import { generateSeedSql, seedProductId, seedProductCode, SEED_AUTH_ID, SEED_STAFF_ID, DEMO_PARTS } from './seed-test-data';
import { WORKSHOP_PARTS } from './seed-workshop-data';
import { readShelfTopology, locateProduct } from '../src/lib/shelf-map';
import { normalizeDecimal } from '../src/lib/decimal';

// Only the wrapper's freshly created private directory is accepted. No URL flag,
// .env loading or ambient libpq connection/service setting is used.
const [directory, countText, checkText, profile = 'synthetic'] = process.argv.slice(2);
if (!/^\/tmp\/ampoteket-seed\.[A-Za-z0-9]{8}$/.test(directory ?? '') ||
	!/^\d+$/.test(countText ?? '') || !['true', 'false'].includes(checkText) ||
	!['synthetic', 'empty', 'workshop'].includes(profile)) {
	throw new Error('Use scripts/seed-test.sh');
}
const parts = profile === 'workshop' ? WORKSHOP_PARTS : DEMO_PARTS;
const count = profile === 'workshop' ? parts.length : Number(countText);
const seed = count === 0 ? '' : generateSeedSql(count, profile === 'workshop' ? {
	parts,
	description: 'Unofficial development sample inspired by workshop photos. Stock and placement are illustrative.'
} : undefined);
const status = await Bun.file(`${directory}/status.json`).json();
const database = new URL(status.DB_URL);
const api = new URL(status.API_URL);
if (api.hostname !== '127.0.0.1' || api.protocol !== 'http:' || database.hostname !== '127.0.0.1' ||
	database.protocol !== 'postgresql:' || database.pathname !== '/postgres') {
	throw new Error('Seed runner refuses nonlocal services.');
}
const projectId = `ampoteket-seed-${directory.split('.').at(-1)}`;
const inspect = Bun.spawn(['docker', 'inspect', `supabase_db_${projectId}`, '--format', '{{ index .Config.Labels "com.supabase.cli.project" }}'], { stdout: 'pipe', stderr: 'pipe' });
const label = (await new Response(inspect.stdout).text()).trim();
assert.equal(await inspect.exited, 0, 'Owned disposable database container exists');
assert.equal(label, projectId, 'Database belongs to the newly created seed project');

const environment = { ...process.env };
for (const name of Object.keys(environment)) if (name.startsWith('PG')) delete environment[name];
Object.assign(environment, { PGHOST: database.hostname, PGPORT: database.port,
	PGUSER: decodeURIComponent(database.username), PGPASSWORD: decodeURIComponent(database.password),
	PGDATABASE: 'postgres', PGSSLMODE: 'disable' });
const publicKey = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
assert.equal(typeof publicKey, 'string');
function redact(value: string): string {
	return [status.SERVICE_ROLE_KEY, status.SECRET_KEY, publicKey, decodeURIComponent(database.password)]
		.filter((secret): secret is string => typeof secret === 'string' && secret.length > 0)
		.reduce((result, secret) => result.replaceAll(secret, '[redacted]'), value);
}
async function sql(query: string): Promise<string> {
	const child = Bun.spawn(['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], {
		env: environment, stdin: new Blob([query]), stdout: 'pipe', stderr: 'pipe'
	});
	const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	if (code !== 0) throw new Error(redact(`Disposable seed SQL failed: ${error}`));
	return output.trim();
}
async function manifest(): Promise<string> {
	const child = Bun.spawn(['python3', 'scripts/database-manifest.py'], { env: environment, stdout: 'pipe', stderr: 'pipe' });
	const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	if (code !== 0) throw new Error(redact(`Seed manifest failed: ${error}`));
	return output;
}
if (count === 0) {
	await sql(await Bun.file('supabase/tests/initial-layout.sql').text());
	assert.deepEqual(await readCompleteCatalog({ url: api.origin, publishableKey: publicKey }), [], 'Development catalog is empty');
}
if (count === 0 || profile === 'workshop') {
	// Create through Auth so its identity metadata is complete. Install the requested
	// four-character password only in this verified disposable database: Auth's
	// password creation policy requires at least six characters.
	const serviceKey = status.SERVICE_ROLE_KEY;
	assert.equal(typeof serviceKey, 'string');
	const response = await fetch(`${api.origin}/auth/v1/admin/users`, {
		method: 'POST',
		headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ email: 'test@test.no', email_confirm: true })
	});
	assert.ok(response.ok, 'Local development Auth user created');
	await sql(`UPDATE auth.users SET encrypted_password=extensions.crypt('test', extensions.gen_salt('bf'))
		WHERE email='test@test.no';
		SELECT app.grant_staff_access('test@test.no', 'Local test admin');`);
	const login = await fetch(`${api.origin}/auth/v1/token?grant_type=password`, {
		method: 'POST', headers: { apikey: publicKey, 'Content-Type': 'application/json' },
		body: JSON.stringify({ email: 'test@test.no', password: 'test' })
	});
	assert.ok(login.ok, 'Development admin can sign in with password test');
	const session = await login.json();
	const membership = await fetch(`${api.origin}/rest/v1/amp_staff_members?select=is_active`, {
		headers: { apikey: publicKey, Authorization: `Bearer ${session.access_token}` }
	});
	assert.ok(membership.ok, 'Development admin can read its membership');
	assert.deepEqual(await membership.json(), [{ is_active: true }]);
	console.log('PASS: active development admin login (test@test.no / test)');
}
if (count !== 0) {
	const config = { url: api.origin, publishableKey: publicKey };
	const initialTopology = await readShelfTopology(config);
	const guardedSeed = "SET ampoteket.test_seed = 'disposable-only';\n" + seed;
	if (checkText === 'true') {
		await assert.rejects(sql(seed), /TEST_SEED_REQUIRES_DISPOSABLE_DATABASE/);
		assert.equal(await sql('SELECT count(*) FROM app.products;'), '0', 'Guard rejection leaves empty database');
	}
	await sql(guardedSeed);
	await sql("NOTIFY pgrst, 'reload schema';");
	const products = await readCompleteCatalog(config);
	assert.equal(products.length, count, 'Every seeded product is publicly readable across API page caps');
	console.log(profile === 'workshop'
		? `Seeded ${count} unofficial workshop sample products in the actual 12-cabinet, 492-drawer layout. Stock, product placement and unlisted prices are illustrative.`
		: `Seeded ${count} synthetic products in the initial workshop shelf layout.`);
	if (checkText === 'true') {
		const before = await manifest();
		await sql(guardedSeed);
		assert.equal(await manifest(), before, 'Rerun changes no rows, sequences or audit entries');
		if (profile === 'synthetic') {
			const cap = await lookupCatalogProduct(config, seedProductCode(5));
			assert.equal(cap?.attributes.capacitance.value, '0.000000000005');
			assert.equal(await sql(`SELECT quantity::text FROM app.inventory WHERE product_id='${seedProductId(11)}';`), '-3');
			assert.equal(await sql(`SELECT quantity::text FROM app.inventory WHERE product_id='${seedProductId(29)}';`), '12.345');
			assert.equal(await sql(`SELECT quantity=0 AND last_counted_at IS NOT NULL FROM app.inventory WHERE product_id='${seedProductId(10)}';`), 't');
			assert.equal(await sql(`SELECT quantity=0 AND last_counted_at IS NULL FROM app.inventory WHERE product_id='${seedProductId(25)}';`), 't');
			assert.equal(await sql(`SELECT sale_unit_price_nok::text FROM app.products WHERE id='${seedProductId(29)}';`), '12.345678');
		}
		const topology = await readShelfTopology(config);
		assert.deepEqual(topology.cabinets, initialTopology.cabinets, 'Seeding preserves the physical cabinets');
		assert.deepEqual(topology.bins.map(({ has_products, ...bin }) => bin),
			initialTopology.bins.map(({ has_products, ...bin }) => bin), 'Seeding preserves the physical drawers');
		const byId = new Map(products.map(product => [product.product_id, product]));
		for (let index = 0; index < count; index++) {
			const part = parts[index % parts.length];
			const product = byId.get(seedProductId(index));
			assert.ok(product);
			assert.equal(product.code, seedProductCode(index, parts));
			assert.equal(normalizeDecimal(product.sale_unit_price_nok), normalizeDecimal(part.price));
			assert.equal(product.unit_code, part.unit ?? 'pcs');
			assert.equal(normalizeDecimal(product.quantity), normalizeDecimal(part.stock ?? '0'));
			assert.equal(normalizeDecimal(product.sale_step), normalizeDecimal(part.saleStep ?? (part.unit === 'm' ? '0.1' : '1')));
			for (const [code, value] of Object.entries(part.attributes)) {
				const attribute: CatalogAttribute | undefined = product.attributes[code];
				assert.ok(attribute, `Public specification ${code} exists`);
				assert.equal(attribute.value_type === 'number' ? normalizeDecimal(attribute.value) : attribute.value,
					attribute.value_type === 'number' ? normalizeDecimal(String(value)) : value);
			}
			assert.ok(locateProduct(topology, product), 'Every product has a publicly readable shelf position');
		}
		assert.equal(await sql("SELECT count(*) FROM app.audit_log WHERE table_name='products' AND (actor_id IS NULL OR database_role<>'authenticated');"), '0');
		const expectedStock = Array.from({ length: count }, (_, index) =>
			`('${seedProductId(index)}'::uuid,${parts[index % parts.length].stock ?? '0'}::numeric)`
		).join(',');
		assert.equal(await sql(`WITH expected(product_id,quantity) AS (VALUES ${expectedStock})
			SELECT count(*) FROM expected e JOIN app.inventory i USING(product_id) WHERE e.quantity<>i.quantity;`), '0');
		assert.equal(await sql(`SELECT count(*) FROM app.inventory_events WHERE actor_id IS DISTINCT FROM '${SEED_STAFF_ID}'::uuid;`), '0');
		assert.equal(await sql(`SELECT count(*) FROM app.inventory_movements m JOIN app.products p ON p.id=m.product_id
			WHERE mod(m.quantity_delta,p.stock_step)<>0;`), '0');
		// A rerun must preserve later real edits and stock operations in the test session.
		await sql(`BEGIN; SET LOCAL request.jwt.claims='{"sub":"${SEED_AUTH_ID}","role":"authenticated"}'; SET LOCAL ROLE authenticated;
			UPDATE app.products SET name_nb='Redigert syntetisk motstand',name_en='Edited synthetic resistor',sale_unit_price_nok=7 WHERE id='${seedProductId(0)}';
			DELETE FROM app.product_attributes WHERE product_id='${seedProductId(0)}';
			SELECT public.amp_withdraw_stock('de000009-0000-4000-8000-000000000001','[{"product_id":"${seedProductId(0)}","quantity":"2"}]','Seed repeatability check'); COMMIT;`);
		const edited = await manifest();
		await sql(guardedSeed);
		assert.equal(await manifest(), edited, 'Rerun preserves edited metadata, removed attributes and later stock movements');
		console.log('PASS: seed guard, complete catalog and shelf map, exact prices/units, all opening balances, movement steps, audit actors and unchanged reruns');
	}
	if (profile === 'workshop') {
		const historySql = await Bun.file('scripts/seed-workshop-orders.sql').text();
		if (checkText === 'true') await assert.rejects(sql(historySql), /WORKSHOP_HISTORY_REQUIRES_DISPOSABLE_SEED/);
		const history = "SET ampoteket.test_seed = 'disposable-only';\n" + historySql;
		await sql(history);
		assert.equal(await sql("SELECT count(*) FROM app.purchase_orders WHERE supplier_reference LIKE 'DEMO-YEAR-%';"), '24');
		assert.equal(await sql("SELECT count(*) FROM app.sales;"), '156');
		assert.equal(await sql("SELECT count(*) FROM app.checkouts c LEFT JOIN app.sales s ON s.checkout_id=c.id WHERE s.checkout_id IS NULL;"), '3');
		assert.equal(await sql("SELECT count(*) FROM app.stock_counts WHERE event_id IN (SELECT id FROM app.inventory_events WHERE note='Fictional spot count; no difference');"), '4');
		assert.equal(await sql("SELECT count(*) FROM app.inventory i WHERE i.quantity < 0;"), '0');
		assert.equal(await sql("SELECT count(*) FROM app.purchase_line_progress WHERE received_quantity>0 AND outstanding_quantity>0;"), '9');
		assert.ok(Number(await sql("SELECT count(*) FROM app.inventory_events WHERE kind='sale' AND recorded_at >= now()-interval '30 days';")) >= 10);
		if (checkText === 'true') {
			const after = await manifest();
			await sql(history);
			assert.equal(await manifest(), after, 'Workshop history rerun preserves every row');
		}
		console.log('Seeded 24 fictional supplier orders, 22 receipts, 156 registered sales, 3 open checkouts and 4 spot counts across a year.');
	}
}
if (checkText !== 'true') {
	// The development launcher reads this owned, private file without printing secrets.
	console.log(`Seed settings: ${directory}/status.json`);
	console.log('In another terminal, start the app with these public settings (no files are changed):');
	// The known URL and generated key are safe shell words; never print service credentials.
	assert.match(publicKey, /^[A-Za-z0-9_.-]+$/);
	console.log(`PUBLIC_SUPABASE_URL='${api.origin}' PUBLIC_SUPABASE_PUBLISHABLE_KEY='${publicKey}' bun run dev`);
	if (typeof status.STUDIO_URL === 'string' && status.STUDIO_URL) console.log(`Studio: ${status.STUDIO_URL}`);
	if (profile === 'synthetic' && count !== 0) console.log('The fixture staff identity has no password or login. This is guest catalog test data.');
}
