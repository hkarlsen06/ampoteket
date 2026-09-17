/** SQL search versus the existing exact display/search implementation.
 * One disposable transaction; no public API or hosted credentials are used. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseApiJson } from '../../src/lib/api';
import { parseCatalogProducts, readCatalogFacets } from '../../src/lib/catalog';
import { catalogFacets, catalogSearchLabels, parseCatalogQuery, searchCatalog } from '../../src/lib/catalog-search';
import { formatMeasurement, formatMeasurementText } from '../../src/lib/format';

execFileSync('python3', ['scripts/disposable_db_guard.py']);
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const labels = `${quote(JSON.stringify(catalogSearchLabels()))}::jsonb`;
const names = ['1000 ohm resistor', '1,25 uF capacitor', '1.25 uF capacitor', '1000 to 2000 ohm',
	'1000 til 2000 ohm', '1 000 ohm', '1000/2000 ohm', '2x1000 ohm', '1000 mΩ', '0.000005 F',
	'1000 Ohms / 0.005 A', '−1000 ohm', '1 MHz controller', '0 F', '1000 ohm and 2000 ohm'];
const compactSearches: Record<string, string[]> = {
	'q=searcha': ['SEARCH-A'], 'q=SEARCHA': ['SEARCH-A'], 'q=earcha': ['SEARCH-A'],
	'q=searcha+1000+ohm': ['SEARCH-A'], 'q=searcha&category=Resistors&eq.package=0603': ['SEARCH-A'],
	'q=searcha&category=Capacitors': [], 'q=sot23': []
};
const searches = ['', 'q=1+kΩ', 'q=1000+ohm', 'q=1,25+µF', 'q=1.25+µF', 'q=STRASSE+μ', 'q=åæø+σ',
	'q=motstander', 'q=resistors', 'q=kapasitans', 'q=5+pF', 'q=false+nei', 'q=SoT-23', 'q=SEARCH-A',
	'q=not-present', 'category=Resistors&category=Capacitors', 'eq.package=0603', 'eq.package=sot-23',
	'eq.package=', 'eq.polarised=false', 'min.capacitance=0.000000000005&max.capacitance=0.000000000005',
	'eq.value=9007199254740993.000000000001', 'min.value=9007199254740993.000000000002',
	'category=Resistors&q=1000&eq.package=0603', 'after=SEARCH-C', ...Object.keys(compactSearches)];
const badSearches: [string, string][] = [
	['category=Unknown', 'UNKNOWN_CATALOG_CATEGORY'], ['eq.absent=1', 'UNKNOWN_CATALOG_ATTRIBUTE'],
	['min.package=1', 'INVALID_CATALOG_FILTER'], ['eq.polarised=no', 'INVALID_CATALOG_FILTER'],
	['min.capacitance=2&max.capacitance=1', 'INVALID_CATALOG_FILTER'], ['eq.capacitance=NaN', 'INVALID_CATALOG_FILTER'],
	['eq.capacitance=1e-12', 'INVALID_CATALOG_FILTER'], ['after=REMOVED', 'CATALOG_CURSOR_MISSING']
];
const measurementCases = ['ohm', 'Ω', 'F', 'H', 'V', 'A', 'W', 'Hz', 'm', 'custom', null].flatMap(unit =>
	['0', '-0.000000000000001', '0.000000000005', '0.00125', '1', '1000', '9007199254740993.000000000001'].flatMap(value =>
		(['nb', 'en'] as const).map(locale => ({ unit, value, locale }))));
const nameCases = names.flatMap(value => (['nb', 'en'] as const).map(locale => ({ value, locale })));
function rpc(search: string, limit = 50) {
	const query = parseCatalogQuery(new URLSearchParams(search));
	return `public.amp_catalog(p_after_code=>${query.after ? quote(query.after) : 'NULL'},p_limit=>${limit},
		p_q=>${quote(query.q)},p_categories=>ARRAY(SELECT jsonb_array_elements_text(${quote(JSON.stringify(query.categories))}::jsonb)),
		p_conditions=>${quote(JSON.stringify(query.conditions))}::jsonb,p_labels=>${labels})`;
}
const cabinet = "'74000000-0000-4000-8000-000000000001'::uuid";
const drawer = "'75000000-0000-4000-8000-000000000001'::uuid";
const locationCases: [string, string[]][] = [
	[`p_cabinet_ids=>ARRAY[${cabinet}],p_q=>'SEARCH',p_limit=>2`, ['SEARCH-A', 'SEARCH-D']],
	["p_cabinet_ids=>ARRAY[md5('search-cab')::uuid]", ['SEARCH-B', 'SEARCH-C']],
	["p_cabinet_ids=>ARRAY[md5('search-cab')::uuid],p_q=>'searchb controller'", ['SEARCH-B']],
	["p_bin_ids=>ARRAY[md5('search-bin-b')::uuid,md5('search-bin-c')::uuid]", ['SEARCH-B', 'SEARCH-C']],
	[`p_cabinet_ids=>ARRAY[${cabinet}],p_bin_ids=>ARRAY[md5('search-bin-b')::uuid],p_q=>'SEARCH'`, ['SEARCH-A', 'SEARCH-B', 'SEARCH-D', 'SEARCH-E', 'SEARCH-F', 'SEARCH-G']],
	["p_cabinet_ids=>ARRAY[md5('search-cab')::uuid],p_bin_ids=>ARRAY[md5('search-bin-b')::uuid]", ['SEARCH-B', 'SEARCH-C']],
	["p_bin_ids=>ARRAY[md5('search-bin-c')::uuid],p_categories=>ARRAY['Capacitors'],p_q=>'1.25',p_conditions=>'{\"capacitance\":{\"eq\":\"0.00000001\"}}'", ['SEARCH-C']],
	["p_bin_ids=>ARRAY[md5('search-bin-b')::uuid],p_categories=>ARRAY['Capacitors']", []],
	[`p_cabinet_ids=>ARRAY[md5('search-cab')::uuid],p_bin_id=>${drawer}`, []],
	["p_cabinet_ids=>ARRAY[md5('search-cab')::uuid],p_after_code=>'SEARCH-A',p_limit=>1", ['SEARCH-B']],
	["p_cabinet_ids=>ARRAY[md5('search-cab')::uuid],p_after_code=>'SEARCH-B',p_limit=>1", ['SEARCH-C']],
	["p_cabinet_ids=>ARRAY[md5('search-cab')::uuid],p_after_code=>'SEARCH-C',p_limit=>1", []],
	["p_cabinet_ids=>ARRAY[md5('search-empty-cab')::uuid]", []],
	["p_bin_ids=>ARRAY[md5('search-empty-bin')::uuid]", []]
];
// A valid UUID is insufficient: stale selections must fail even on no-match queries.
const badLocations = (['cabinet', 'bin'] as const).flatMap(kind => {
	const table = kind === 'cabinet' ? 'cabinets' : 'bins', id = kind === 'cabinet' ? cabinet : drawer;
	return ['NULL', 'ARRAY[NULL]::uuid[]', `ARRAY[${id},${id}]`,
		`ARRAY(SELECT md5(n::text)::uuid FROM generate_series(1,${kind === 'cabinet' ? 101 : 4097}) n)`,
		"ARRAY['00000000-0000-0000-0000-000000000000'::uuid]",
		`ARRAY(SELECT id FROM app.${table} WHERE is_archived LIMIT 1)`]
		.map(value => `SELECT * FROM public.amp_catalog(p_q=>'not-present',p_${kind}_ids=>${value})`);
});
const sql = `BEGIN;
${readFileSync('supabase/tests/fixtures.sql', 'utf8')}
INSERT INTO app.categories(id,name) VALUES (md5('search-resistors')::uuid,'Resistors'),(md5('search-capacitors')::uuid,'Capacitors');
INSERT INTO app.products(id,code,name_nb,name_en,category_id,bin_id,unit_code,stock_step,sale_step,sale_unit_price_nok,is_active)
SELECT md5(code)::uuid,code,nb,en,md5(category)::uuid,'75000000-0000-4000-8000-000000000001','pcs',1,1,1,true FROM (VALUES
 ('SEARCH-A','1000 ohm motstand','1000 ohm resistor','search-resistors'),
 ('SEARCH-B','STRASSE µ styring','STRASSE µ controller','search-resistors'),
 ('SEARCH-C','1,25 uF kondensator','1.25 uF capacitor','search-capacitors'),
 ('SEARCH-D','1000 to 2000 ohm','1000 to 2000 ohm','search-resistors'),
 ('SEARCH-E','1 000 ohm','1 000 ohm','search-resistors'),
 ('SEARCH-F','ÅÆØ Σ Straße','ÅÆØ Σ Straße','search-resistors'),
 ('SEARCH-G','Uten felter','Without specifications','search-capacitors')) AS rows(code,nb,en,category);
INSERT INTO app.attribute_definitions(id,code,label,value_type,canonical_unit) SELECT md5(code)::uuid,* FROM (VALUES
 ('resistance','Resistance','number','ohm'),('capacitance','Capacitance','number','F'),
 ('value','Value','number',NULL),('package','Package','text',NULL),('polarised','Polarised','boolean',NULL)) AS fields(code,label,value_type,canonical_unit);
INSERT INTO app.product_attributes(product_id,attribute_id,number_value,text_value,boolean_value) VALUES
 (md5('SEARCH-A')::uuid,md5('resistance')::uuid,1000,NULL,NULL),
 (md5('SEARCH-A')::uuid,md5('capacitance')::uuid,0.000000000005,NULL,NULL),
 (md5('SEARCH-A')::uuid,md5('value')::uuid,9007199254740993.000000000001,NULL,NULL),
 (md5('SEARCH-A')::uuid,md5('package')::uuid,NULL,'0603',NULL),
 (md5('SEARCH-A')::uuid,md5('polarised')::uuid,NULL,NULL,false),
 (md5('SEARCH-B')::uuid,md5('package')::uuid,NULL,'SoT-23',NULL),
 (md5('SEARCH-C')::uuid,md5('capacitance')::uuid,0.000000010000,NULL,NULL),
 (md5('SEARCH-C')::uuid,md5('package')::uuid,NULL,'',NULL);
CREATE FUNCTION pg_temp.search_error(p_sql text) RETURNS text LANGUAGE plpgsql AS $$ BEGIN
 EXECUTE p_sql; RETURN 'NO_ERROR'; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $$;
SELECT jsonb_build_object('kind','base','data',(SELECT jsonb_agg(t) FROM public.amp_catalog() t));
${searches.map((search, index) => `SELECT jsonb_build_object('kind','search','index',${index},'data',(SELECT coalesce(jsonb_agg(t.code),'[]') FROM ${rpc(search)} t));`).join('\n')}
${badSearches.map(([search], index) => `SELECT jsonb_build_object('kind','error','index',${index},'data',pg_temp.search_error(${quote(`SELECT * FROM ${rpc(search)}`)}));`).join('\n')}
${measurementCases.map(({ unit, value, locale }, index) => `SELECT jsonb_build_object('kind','measurement','index',${index},'data',app.catalog_measurement(${quote(value)}::numeric,${unit === null ? 'NULL' : quote(unit)},${quote(locale)},${labels}->'units'));`).join('\n')}
${nameCases.map(({ value, locale }, index) => `SELECT jsonb_build_object('kind','name','index',${index},'data',app.catalog_name_measurements(${quote(value)},${quote(locale)},${labels}->'units'));`).join('\n')}
SELECT jsonb_build_object('kind','facets','data',public.amp_catalog_facets(ARRAY['Resistors']));
SELECT jsonb_build_object('kind','drawer','data',(SELECT jsonb_agg(t.code) FROM public.amp_catalog(p_bin_id=>'75000000-0000-4000-8000-000000000001') t));
SELECT jsonb_build_object('kind','empty-drawer','data',(SELECT count(*) FROM public.amp_catalog(p_bin_id=>'00000000-0000-4000-8000-000000000000')));
SELECT jsonb_build_object('kind','boundary','data',pg_temp.search_error(${quote(`SELECT * FROM public.amp_catalog(p_conditions=>'[]')`)}));
SELECT jsonb_build_object('kind','boundary','data',pg_temp.search_error(${quote(`SELECT * FROM public.amp_catalog(p_labels=>'[]')`)}));
SELECT jsonb_build_object('kind','boundary','data',pg_temp.search_error(${quote(`SELECT * FROM public.amp_catalog(p_labels=>' {"units":{"F":[{"symbol":"F","exponent":999}]}}')`)}));
INSERT INTO app.cabinets(id,code,outer_row,outer_col,inner_rows,inner_cols) VALUES
 (md5('search-cab')::uuid,'SEARCH-CAB',1,2,1,2),(md5('search-empty-cab')::uuid,'SEARCH-EMPTY-CAB',1,3,1,1);
INSERT INTO app.bins(id,code,cabinet_id,inner_row,inner_col) VALUES
 (md5('search-bin-b')::uuid,'SEARCH-BIN-B',md5('search-cab')::uuid,1,1),
 (md5('search-bin-c')::uuid,'SEARCH-BIN-C',md5('search-cab')::uuid,1,2),
 (md5('search-empty-bin')::uuid,'SEARCH-EMPTY-BIN',md5('search-empty-cab')::uuid,1,1);
UPDATE app.products SET bin_id=md5('search-bin-b')::uuid WHERE code='SEARCH-B';
UPDATE app.products SET bin_id=md5('search-bin-c')::uuid WHERE code='SEARCH-C';
${locationCases.map(([args], index) => `SELECT jsonb_build_object('kind','location','index',${index},'data',(SELECT coalesce(jsonb_agg(t.code),'[]') FROM public.amp_catalog(${args}) t));`).join('\n')}
${badLocations.map((query, index) => `SELECT jsonb_build_object('kind','location-error','index',${index},'data',pg_temp.search_error(${quote(query)}));`).join('\n')}
ROLLBACK;`;
const output = execFileSync('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const rows = output.trim().split('\n').map(line => parseApiJson(line) as { kind: string; index: string; data: unknown });
const products = parseCatalogProducts(rows.find(row => row.kind === 'base')!.data);
for (const row of rows) {
	const index = Number(row.index);
	if (row.kind === 'search') {
		assert.deepEqual(row.data, searchCatalog(products, parseCatalogQuery(new URLSearchParams(searches[index]))).products.map(product => product.code), searches[index]);
		if (Object.hasOwn(compactSearches, searches[index])) assert.deepEqual(row.data, compactSearches[searches[index]], searches[index]);
	}
	if (row.kind === 'error') assert.equal(row.data, badSearches[index][1], badSearches[index][0]);
	if (row.kind === 'measurement') {
		const c = measurementCases[index]; assert.equal(row.data, formatMeasurement(c.value, c.unit, c.locale), JSON.stringify(c));
	}
	if (row.kind === 'name') {
		const c = nameCases[index]; assert.equal(row.data, formatMeasurementText(c.value, c.locale), JSON.stringify(c));
	}
	if (row.kind === 'boundary') assert.equal(row.data, 'INVALID_CATALOG_QUERY');
	if (row.kind === 'location') assert.deepEqual(row.data, locationCases[index][1], locationCases[index][0]);
	if (row.kind === 'location-error') assert.equal(row.data, 'INVALID_CATALOG_FILTER', badLocations[index]);
	if (row.kind === 'drawer') assert.deepEqual(row.data, products.map(product => product.code));
	if (row.kind === 'empty-drawer') assert.equal(row.data, '0');
	if (row.kind === 'facets') {
		const facets = await readCatalogFacets({ url: 'https://example.invalid', publishableKey: 'test' }, { fetcher: async () => new Response(JSON.stringify(row.data)) });
		const expected = catalogFacets(products, ['Resistors']);
		assert.deepEqual(facets.categories, expected.categories);
		assert.deepEqual(facets.attributes.sort((a, b) => a.code.localeCompare(b.code)), expected.attributes.sort((a, b) => a.code.localeCompare(b.code)));
	}
}
console.log(`PASS: SQL catalog search matches ${searches.length} existing search cases, ${measurementCases.length} exact measurements, ${nameCases.length} name formats, typed filters, complete facets, ${locationCases.length} location queries and ${badLocations.length} invalid location selections`);
