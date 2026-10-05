import { expect, test } from 'bun:test';
import { memory } from './test-storage';
import { ApiError } from './api';
import { formatMoney } from './format';
import { readProductSpecificationReview, replaceReviewedProductCommand, clearProductCommand, definitiveProductFailure, ProductSpecificationsError, executeDetailCommand, executeProductCommand, generateCategoryProductCode, generateProductCode, isProductCodeCollision, parseAdminProduct, parseAttribute, parseProductWrite, persistProductCommand, ProductFieldError, productCategoryOptions, productTypes, readAdminProducts, readProductAttributes, readProductCommand, StaleProductError, type ProductCommand, type ProductWrite } from './admin-products';
const actor = '11111111-1111-4111-8111-111111111111'; const id = '22222222-2222-4222-8222-222222222222'; const bin = '33333333-3333-4333-8333-333333333333';
const attribute = '44444444-4444-4444-8444-444444444444';
const session = { userId: actor, token: 'staff-jwt', config: { url: 'https://fixture.invalid', publishableKey: 'sb_publishable_fixture' } };
const payload: ProductWrite = { id, code: 'RES-A3F09', name_nb: 'Motstand', name_en: 'Resistor', description: null, category_id: null, bin_id: bin, location_note: null, unit_code: 'pcs', stock_step: '1', sale_step: '1', sale_unit_price_nok: '999999999998.999999', minimum_stock: '0', datasheet_url: null, purchase_url: null, is_active: true };
const product = { ...payload, metadata_revision: '9007199254740993' };
test('unit price display pads to two decimals and preserves sub-øre precision in both languages', () => {
	for (const [stored, nb, en] of [['1.5', '1,50 kr', '1.50 NOK'], ['0.275', '0,275 kr', '0.275 NOK'], ['0', '0,00 kr', '0.00 NOK']]) {
		const price = parseProductWrite({ ...payload, sale_unit_price_nok: stored }).sale_unit_price_nok;
		expect(formatMoney(price, 'nb')).toBe(nb);
		expect(formatMoney(price, 'en')).toBe(en);
	}
});
test('product boundary keeps exact prices and opaque revisions and enforces steps, identity and active placement', () => {
	expect(parseAdminProduct(product)).toEqual(product);
	for (const change of [{ stock_step: '0' }, { unit_code: 'pcs', sale_step: '0.5' }, { stock_step: '2', sale_step: '3' }, { sale_unit_price_nok: '0.0000001' }, { sale_unit_price_nok: 1 }, { location_note: 'Filamenthylla' }, { datasheet_url: 'javascript:alert(1)' }, { metadata_revision: Number.MAX_SAFE_INTEGER + 1 }]) expect(() => parseAdminProduct({ ...product, ...change })).toThrow();
	expect(parseProductWrite({ ...payload, unit_code: 'm', stock_step: '0.001', sale_step: '0.1' }).sale_step).toBe('0.1');
	expect(parseProductWrite({ ...payload, bin_id: null, is_active: false }).bin_id).toBeNull();
	expect(parseProductWrite({ ...payload, minimum_stock: '25' }).minimum_stock).toBe('25');
	expect(generateProductCode('CAP', { getRandomValues: <T extends ArrayBufferView>(array: T) => { new Uint8Array(array.buffer).set([0xab, 0xcd, 0xef]); return array; } })).toBe('CAP-ABCDE');
});
test('complete admin products and composite attribute reads traverse short pages to empty', async () => {
	let pages = 0; const rows = await readAdminProducts(session, async (input, init) => {
		const url = new URL(String(input)); expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer staff-jwt'); expect(url.searchParams.get('select')).not.toContain('*');
		if (pages++) { expect(url.searchParams.get('and')).toBe(`(id.gt.${id})`); return Response.json([]); } return Response.json([product]);
	}); expect(rows).toEqual([product]); expect(pages).toBe(2);
	pages = 0; const attributes = await readProductAttributes(session, id, async input => { const url = new URL(String(input)); expect(url.searchParams.get('product_id')).toBe(`eq.${id}`); if (pages++) { expect(url.searchParams.get('and')).toBe(`(attribute_id.gt.${attribute})`); return Response.json([]); } return Response.json([{ product_id: id, attribute_id: attribute, number_value: '0.000000000001', text_value: null, boolean_value: null }]); });
	expect(attributes[0].number_value).toBe('0.000000000001'); expect(pages).toBe(2);
});
test('frozen product persistence rejects replacing payload or actor and can recover same identity after a lost creation reply', async () => {
	const storage = memory(); const command: ProductCommand = { userId: actor, payload, revision: null }; persistProductCommand(storage, command); expect(readProductCommand(storage)).toEqual(command);
	expect(() => persistProductCommand(storage, { ...command, payload: { ...payload, code: 'RES-FFFFF' } })).toThrow();
	clearProductCommand(storage, { ...command, userId: bin }); expect(readProductCommand(storage)).toEqual(command);
	let exists = false; let inserts = 0;
	const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => { if (init?.method === 'GET') return Response.json(exists ? [product] : []); inserts++; exists = true; throw new Error('Lost response after commit'); };
	await expect(executeProductCommand(session, command, fetcher)).rejects.toThrow('Lost');
	expect(await executeProductCommand(session, readProductCommand(storage)!, fetcher)).toEqual(product); expect(inserts).toBe(1);
	await expect(executeProductCommand({ ...session, userId: bin }, command, fetcher)).rejects.toThrow('identity');
	clearProductCommand(storage, command); expect(readProductCommand(storage)).toBeNull();
});
test('product edits send immutable identity only in filters, retain revision and reject stale or zero-row saves', async () => {
	const command: ProductCommand = { userId: actor, payload: { ...payload, name_en: 'Changed' }, revision: product.metadata_revision }; let writes = 0;
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		if (init?.method === 'GET') return Response.json([product]); writes++; const url = new URL(String(input)); expect(url.searchParams.get('metadata_revision')).toBe('eq.9007199254740993'); expect(url.searchParams.get('id')).toBe(`eq.${id}`);
		const sent = JSON.parse(String(init?.body)); for (const key of ['id', 'code', 'unit_code', 'stock_step', 'metadata_revision']) expect(sent).not.toHaveProperty(key); expect(sent.sale_unit_price_nok).toBe('999999999998.999999'); return Response.json([]);
	}; await expect(executeProductCommand(session, command, fetcher)).rejects.toBeInstanceOf(StaleProductError); expect(writes).toBe(1);
	await expect(executeProductCommand(session, { ...command, revision: '2' }, fetcher)).rejects.toBeInstanceOf(StaleProductError); expect(writes).toBe(1);
});
test('only definite unique product-code collisions permit a different code candidate', () => {
	expect(isProductCodeCollision(new ApiError(409, { code: '23505', message: 'duplicate key value violates unique constraint "products_code_key"' }))).toBe(true);
	for (const error of [new Error('timeout'), new ApiError(409, { code: '23505', message: 'duplicate key value violates unique constraint "products_pkey"' }), new ApiError(500, { code: '23505', message: 'products_code_key' }), new ApiError(409, { code: 'OTHER', message: 'products_code_key' })]) expect(isProductCodeCollision(error)).toBe(false);
});
test('typed attributes preserve tiny numbers, false and empty text, reject mixing, and guard the original value on update', async () => {
	const original = { product_id: id, attribute_id: attribute, number_value: '0.000000000001', text_value: null, boolean_value: null };
	expect(parseAttribute(original).number_value).toBe('0.000000000001'); expect(parseAttribute({ ...original, number_value: null, boolean_value: false }).boolean_value).toBe(false); expect(parseAttribute({ ...original, number_value: null, text_value: '' }).text_value).toBe('');
	expect(() => parseAttribute({ ...original, boolean_value: false })).toThrow(); expect(() => parseAttribute({ ...original, number_value: 'NaN' })).toThrow();
	const after = { ...original, number_value: '0.000000000002' }; let writes = 0;
	await executeDetailCommand(session, { userId: actor, kind: 'attribute', before: original, after }, async (input, init) => { if (init?.method === 'GET') return Response.json([original]); writes++; const url = new URL(String(input)); expect(url.searchParams.get('number_value')).toBe('eq.0.000000000001'); expect(url.searchParams.get('text_value')).toBe('is.null'); expect(init?.method).toBe('PATCH'); return Response.json([after]); }); expect(writes).toBe(1);
});
test('attribute removal uses DELETE with guarded values and retries an already absent row without another write', async () => {
	const before = { product_id: id, attribute_id: attribute, number_value: null, text_value: 'a,b"c.(d)&name=other#value', boolean_value: null }; let exists = true; let writes = 0;
	const command = { userId: actor, kind: 'attribute' as const, before, after: null };
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => { if (init?.method === 'GET') return Response.json(exists ? [before] : []); writes++; expect(init?.method).toBe('DELETE'); const params = new URL(String(input)).searchParams; expect(params.get('text_value')).toBe('eq.a,b"c.(d)&name=other#value'); expect(params.has('name')).toBe(false); exists = false; return Response.json([before]); };
	await executeDetailCommand(session, command, fetcher); await executeDetailCommand(session, command, fetcher); expect(writes).toBe(1);
});
test('an empty database offers every standard category and selection generates its code automatically', () => {
	const options = productCategoryOptions([]);
	expect(options.map(option => option.prefix)).toEqual(['RES', 'CAP', 'DIO', 'LED', 'BJT', 'MOS', 'MCU', 'SEN', 'MOT', 'DRV', 'CON', 'BRD', 'CAB', 'MIS']);
	expect(new Set(options.map(option => option.id)).size).toBe(14);
	for (const option of options) expect(generateCategoryProductCode(option.id, [])).toMatch(new RegExp(`^${option.prefix}-[0-9A-F]{5}$`));
	expect(options.find(option => option.prefix === 'MIS')?.name).toBe('Miscellaneous');
	expect(() => generateCategoryProductCode(null, [])).toThrow();
	expect(() => generateCategoryProductCode(id, [])).toThrow();
});
test('a rejected unsaved product keeps its code candidate only while it remains valid for the selected category', () => {
	const resistor = productTypes.find(type => type.prefix === 'RES')!;
	const miscellaneous = productTypes.find(type => type.prefix === 'MIS')!;
	expect(generateCategoryProductCode(resistor.id, [], 'RES-A3F09')).toBe('RES-A3F09');
	expect(generateCategoryProductCode(miscellaneous.id, [], 'RES-A3F09')).toMatch(/^MIS-[0-9A-F]{5}$/);
	for (const previousCode of ['RES-A3F0', 'RES-A3F099', 'RES-ZZZZZ', 'RES-a3f09', 'RES-A3F09-extra']) {
		const candidate = generateCategoryProductCode(resistor.id, [], previousCode);
		expect(candidate).toMatch(/^RES-[0-9A-F]{5}$/);
		expect(candidate).not.toBe(previousCode);
	}
});
test('standard categories reuse existing canonical-name identities without offering custom categories', async () => {
	const categories = [{ id: attribute, name: 'Resistors' }, { id: bin, name: 'Custom category' }];
	const option = productCategoryOptions(categories).find(option => option.prefix === 'RES')!;
	expect(option.id).toBe(attribute);
	expect(generateCategoryProductCode(option.id, categories)).toMatch(/^RES-[0-9A-F]{5}$/);
	expect(productCategoryOptions(categories).some(option => option.id === bin)).toBe(false);
	const command: ProductCommand = { userId: actor, payload: { ...payload, category_id: option.id }, revision: null };
	const saved = { ...product, category_id: option.id }; let writes = 0;
	const result = await executeProductCommand(session, command, async (input, init) => {
		expect(new URL(String(input)).pathname).toBe('/rest/v1/amp_products');
		if (init?.method === 'GET') return Response.json([]);
		writes++; expect(JSON.parse(String(init?.body))).toEqual(command.payload); return Response.json([saved]);
	});
	expect(result).toEqual(saved); expect(writes).toBe(1);
});
test('first use creates a standard category before the product with the same staff identity', async () => {
	const type = productTypes.find(type => type.prefix === 'MIS')!; const category = { id: type.id, name: type.name };
	const command: ProductCommand = { userId: actor, payload: { ...payload, category_id: type.id, code: generateCategoryProductCode(type.id, []) }, revision: null };
	const saved = { ...command.payload, metadata_revision: '1' }; const requests: string[] = [];
	const result = await executeProductCommand(session, command, async (input, init) => {
		const url = new URL(String(input)); const view = url.pathname.split('/').at(-1)!;
		requests.push(`${init?.method} ${view}`); expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer staff-jwt');
		if (init?.method === 'GET') return Response.json([]);
		if (view === 'amp_categories') { expect(JSON.parse(String(init?.body))).toEqual(category); return Response.json([category]); }
		expect(JSON.parse(String(init?.body))).toEqual(command.payload); return Response.json([saved]);
	});
	expect(result).toEqual(saved); expect(result.code).toMatch(/^MIS-[0-9A-F]{5}$/);
	expect(requests).toEqual(['GET amp_products', 'GET amp_categories', 'POST amp_categories', 'POST amp_products']);
});
test('recategorization retains the existing product code and guards the metadata revision', async () => {
	const type = productTypes.find(type => type.prefix === 'MIS')!;
	const command: ProductCommand = { userId: actor, payload: { ...payload, category_id: type.id }, revision: product.metadata_revision };
	const saved = { ...command.payload, metadata_revision: '9007199254740994' }; let writes = 0;
	const result = await executeProductCommand(session, command, async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname.endsWith('/amp_categories')) { expect(init?.method).toBe('GET'); return Response.json([{ id: type.id, name: type.name }]); }
		if (init?.method === 'GET') return Response.json([product]);
		writes++; expect(init?.method).toBe('PATCH'); expect(url.searchParams.get('metadata_revision')).toBe(`eq.${product.metadata_revision}`);
		const sent = JSON.parse(String(init?.body)); expect(sent.category_id).toBe(type.id); expect(sent).not.toHaveProperty('code'); return Response.json([saved]);
	});
	expect(result.code).toBe('RES-A3F09'); expect(result.category_id).toBe(type.id); expect(writes).toBe(1);
});
test('a lost category acknowledgement preserves the frozen product and retries one category and one product', async () => {
	const type = productTypes.find(type => type.prefix === 'MOS')!; const category = { id: type.id, name: type.name };
	const command: ProductCommand = { userId: actor, payload: { ...payload, code: generateCategoryProductCode(type.id, []), category_id: type.id }, revision: null };
	const storage = memory(); persistProductCommand(storage, command);
	const saved = { ...command.payload, metadata_revision: '1' }; let categoryExists = false; let productExists = false; let categoryWrites = 0; let productWrites = 0;
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		if (new URL(String(input)).pathname.endsWith('/amp_categories')) {
			if (init?.method === 'GET') return Response.json(categoryExists ? [category] : []);
			categoryWrites++; expect(JSON.parse(String(init?.body))).toEqual(category); categoryExists = true; throw new Error('Lost category response after commit');
		}
		if (init?.method === 'GET') return Response.json(productExists ? [saved] : []);
		productWrites++; expect(JSON.parse(String(init?.body))).toEqual(command.payload); productExists = true; return Response.json([saved]);
	};
	await expect(executeProductCommand(session, command, fetcher)).rejects.toThrow('Lost category response');
	expect(readProductCommand(storage)).toEqual(command); expect(productWrites).toBe(0);
	expect(() => persistProductCommand(storage, { ...command, payload: { ...command.payload, category_id: productTypes[0].id, code: 'RES-FFFFF' } })).toThrow('Unresolved');
	expect(await executeProductCommand(session, readProductCommand(storage)!, fetcher)).toEqual(saved);
	expect(await executeProductCommand(session, readProductCommand(storage)!, fetcher)).toEqual(saved);
	expect(categoryWrites).toBe(1); expect(productWrites).toBe(1); expect(readProductCommand(storage)).toEqual(command);
});
test('concurrent first category creation reconciles a definite unique violation before creating the product', async () => {
	const type = productTypes.find(type => type.prefix === 'CAP')!; const category = { id: type.id, name: type.name };
	const command: ProductCommand = { userId: actor, payload: { ...payload, code: 'CAP-ABCDE', category_id: type.id }, revision: null };
	const saved = { ...command.payload, metadata_revision: '1' }; let categoryReads = 0; let categoryWrites = 0; let productWrites = 0;
	const result = await executeProductCommand(session, command, async (input, init) => {
		if (new URL(String(input)).pathname.endsWith('/amp_categories')) {
			if (init?.method === 'GET') return Response.json(categoryReads++ ? [category] : []);
			categoryWrites++; return Response.json({ code: '23505', message: 'duplicate key value violates unique constraint "categories_pkey"' }, { status: 409 });
		}
		if (init?.method === 'GET') return Response.json([]);
		productWrites++; expect(categoryReads).toBe(2); return Response.json([saved]);
	});
	expect(result).toEqual(saved); expect(categoryWrites).toBe(1); expect(productWrites).toBe(1);
});
test('category permission failures never permit product creation', async () => {
	const type = productTypes[0]; const command: ProductCommand = { userId: actor, payload: { ...payload, category_id: type.id }, revision: null };
	for (const deniedMethod of ['GET', 'POST']) {
		let productWrites = 0;
		await expect(executeProductCommand(session, command, async (input, init) => {
			if (new URL(String(input)).pathname.endsWith('/amp_categories')) {
				if (init?.method === deniedMethod) return Response.json({ code: '42501', message: 'permission denied' }, { status: 403 });
				return Response.json([]);
			}
			if (init?.method === 'GET') return Response.json([]);
			productWrites++; return Response.json([{ ...product, category_id: type.id }]);
		})).rejects.toBeInstanceOf(ApiError);
		expect(productWrites).toBe(0);
	}
});
test('conflicting standard category identities prevent product writes during lookup, acknowledgement and collision reconciliation', async () => {
	const type = productTypes[0]; const command: ProductCommand = { userId: actor, payload: { ...payload, category_id: type.id }, revision: null };
	for (const conflict of [{ id: type.id, name: 'Different category' }, { id: attribute, name: type.name }]) {
		for (const phase of ['lookup', 'acknowledgement', 'collision']) {
			let categoryReads = 0; let productWrites = 0;
			await expect(executeProductCommand(session, command, async (input, init) => {
				if (new URL(String(input)).pathname.endsWith('/amp_categories')) {
					if (init?.method === 'GET') return Response.json(phase === 'lookup' || categoryReads++ > 0 ? [conflict] : []);
					if (phase === 'collision') return Response.json({ code: '23505' }, { status: 409 });
					return Response.json([conflict]);
				}
				if (init?.method === 'GET') return Response.json([]);
				productWrites++; return Response.json([{ ...product, category_id: type.id }]);
			})).rejects.toThrow('Category identity differs');
			expect(productWrites).toBe(0);
		}
	}
});


test('product validation identifies the rejected field without weakening exactness or placement rules', () => {
	for (const [field, value] of [['stock_step', '0'], ['sale_step', '0.5'], ['sale_unit_price_nok', '0.0000001'], ['minimum_stock', '-1'], ['minimum_stock', '1.5'], ['location_note', 'Filamenthylla'], ['datasheet_url', 'ftp://example.test/file'], ['purchase_url', 'javascript:alert(1)'], ['name_en', '']] as const) {
		try { parseProductWrite({ ...payload, [field]: value }); throw new Error('Expected field rejection'); }
		catch (error) { expect(error).toBeInstanceOf(ProductFieldError); expect((error as ProductFieldError).field).toBe(field); }
	}
});

test('new-product specifications are frozen, validated and survive a lost value reply without duplicate writes', async () => {
	const values = [{ attribute_id: attribute, number_value: '9007199254740993.000000000001', text_value: null, boolean_value: null }];
	const command: ProductCommand = { userId: actor, payload, revision: null, attributes: values };
	const storage = memory(); persistProductCommand(storage, command);
	expect(readProductCommand(storage)).toEqual(command);
	expect(() => persistProductCommand(storage, { ...command, attributes: [{ ...values[0], number_value: '1' }] })).toThrow('Unresolved');
	clearProductCommand(storage, { ...command, attributes: [] });
	expect(readProductCommand(storage)).toEqual(command);
	for (const change of [{ revision: '1' }, { attributes: [values[0], values[0]] }, { attributes: [{ ...values[0], boolean_value: false }] }]) {
		expect(() => persistProductCommand(memory(), { ...command, ...change })).toThrow();
	}
	let productWrites = 0; let attributeWrites = 0; let exists = false; let saved = false;
	const after = { ...values[0], product_id: id };
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		if (new URL(String(input)).pathname.endsWith('/amp_products')) {
			if (init?.method === 'GET') return Response.json(exists ? [product] : []);
			exists = true; productWrites++; return Response.json([product]);
		}
		expect(new URL(String(input)).pathname.endsWith('/amp_product_attributes')).toBe(true);
		if (init?.method === 'GET') return Response.json(saved ? [after] : []);
		expect(JSON.parse(String(init?.body))).toEqual(after);
		saved = true; attributeWrites++; throw new Error('Lost specification acknowledgement');
	};
	await expect(executeProductCommand(session, command, fetcher)).rejects.toBeInstanceOf(ProductSpecificationsError);
	expect(readProductCommand(storage)).toEqual(command);
	expect(await executeProductCommand(session, readProductCommand(storage)!, fetcher)).toEqual(product);
	expect(productWrites).toBe(1); expect(attributeWrites).toBe(1);
	await expect(executeProductCommand({ ...session, userId: bin }, command, fetcher)).rejects.toThrow('identity');
});

test('a rejected or concurrently changed staged specification cannot masquerade as a wholly rejected product', async () => {
	const attributes = [{ attribute_id: attribute, number_value: null, text_value: 'draft', boolean_value: null }];
	const command: ProductCommand = { userId: actor, payload, revision: null, attributes };
	for (const stale of [false, true]) {
		let thrown: unknown;
		try {
			await executeProductCommand(session, command, async (input, init) => {
				if (new URL(String(input)).pathname.endsWith('/amp_products')) return Response.json([product]);
				if (init?.method === 'GET') return Response.json(stale ? [{ ...attributes[0], product_id: id, text_value: 'concurrent change' }] : []);
				return Response.json({ code: '23514' }, { status: 400 });
			});
		} catch (error) { thrown = error; }
		expect(thrown).toBeInstanceOf(ProductSpecificationsError);
		expect(definitiveProductFailure(thrown)).toBe(false);
		expect((thrown as Error).cause).toBeInstanceOf(stale ? StaleProductError : ApiError);
	}
});

test('partial-specification recovery keeps newer metadata, atomically freezes explicit review, and guards concurrent values', async () => {
	const intended = { attribute_id: attribute, number_value: null, text_value: 'intended', boolean_value: null };
	const command: ProductCommand = { userId: actor, payload, revision: null, attributes: [intended] };
	const newerProduct = { ...product, name_en: 'Changed by another admin', metadata_revision: '9007199254740994' };
	const existing = { ...intended, product_id: id, text_value: 'Recorded by another admin' };
	const storage = memory(); persistProductCommand(storage, command);
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		expect(init?.method).toBe('GET');
		const url = new URL(String(input));
		if (url.pathname.endsWith('/amp_products')) return Response.json([newerProduct]);
		return Response.json(url.searchParams.has('and') ? [] : [existing]);
	};
	await expect(executeProductCommand(session, command, fetcher)).rejects.toBeInstanceOf(ProductSpecificationsError);
	const review = await readProductSpecificationReview(session, command, fetcher);
	expect(review).toEqual({ product: newerProduct, attributes: [existing] });
	const corrected = [{ ...intended, text_value: 'Reviewed correction' }];
	const replacement = replaceReviewedProductCommand(storage, command, review, corrected);
	expect(readProductCommand(storage)).toEqual(replacement);
	expect(replacement.payload.name_en).toBe(newerProduct.name_en);
	expect(replacement.attributeBefore?.[0].text_value).toBe(existing.text_value);
	for (const changedAgain of [false, true]) {
		let writes = 0;
		const retry = executeProductCommand(session, replacement, async (input, init) => {
			const url = new URL(String(input));
			if (url.pathname.endsWith('/amp_products')) { expect(init?.method).toBe('GET'); return Response.json([newerProduct]); }
			if (init?.method === 'GET') return Response.json([{ ...existing, text_value: changedAgain ? 'Changed after review' : existing.text_value }]);
			writes++; expect(init?.method).toBe('PATCH'); expect(url.searchParams.get('text_value')).toBe(`eq.${existing.text_value}`);
			return Response.json([{ ...existing, ...corrected[0] }]);
		});
		if (changedAgain) { await expect(retry).rejects.toBeInstanceOf(ProductSpecificationsError); expect(writes).toBe(0); }
		else { expect(await retry).toEqual(newerProduct); expect(writes).toBe(1); }
	}
	expect(() => replaceReviewedProductCommand(storage, command, review, corrected)).toThrow('command changed');
	const freshStorage = memory(); persistProductCommand(freshStorage, command);
	for (const changed of [{ id: bin }, { code: 'CAP-12345' }, { unit_code: 'm' }, { stock_step: '2' }]) {
		expect(() => replaceReviewedProductCommand(freshStorage, command, { ...review, product: { ...newerProduct, ...changed } }, corrected)).toThrow('identity');
	}
	expect(() => replaceReviewedProductCommand(freshStorage, command, { ...review, attributes: [{ ...existing, product_id: bin }] }, corrected)).toThrow('identity');
	expect(() => replaceReviewedProductCommand({ getItem: freshStorage.getItem, setItem: () => { throw new Error('Storage full'); } }, command, review, corrected)).toThrow('Storage full');
	expect(readProductCommand(freshStorage)).toEqual(command);
	await expect(readProductSpecificationReview({ ...session, userId: bin }, command, fetcher)).rejects.toThrow('identity');
});

test('reviewed specification removal deletes only its guarded saved value and retains empty-draft recovery after metadata changes', async () => {
	const intended = { attribute_id: attribute, number_value: null, text_value: 'draft', boolean_value: null };
	const command: ProductCommand = { userId: actor, payload, revision: null, attributes: [intended] };
	const existing = { ...intended, product_id: id };
	const unrelated = { ...existing, attribute_id: bin, text_value: 'Keep this unrelated specification' };
	const storage = memory(); persistProductCommand(storage, command);
	const replacement = replaceReviewedProductCommand(storage, command, { product, attributes: [existing, unrelated] }, []);
	expect(replacement.attributes).toEqual([]);
	expect(replacement.attributeBefore).toEqual([intended]);
	for (const changed of [false, true]) {
		let removed = false; let deletes = 0;
		const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			if (url.pathname.endsWith('/amp_products')) return Response.json([product]);
			expect(url.searchParams.get('attribute_id')).toBe(`eq.${attribute}`);
			if (init?.method === 'GET') return Response.json(removed ? [] : [{ ...existing, text_value: changed ? 'Changed after review' : existing.text_value }]);
			expect(init?.method).toBe('DELETE');
			expect(url.searchParams.get('text_value')).toBe(`eq.${existing.text_value}`);
			deletes++; removed = true; return Response.json([existing]);
		};
		if (changed) { await expect(executeProductCommand(session, replacement, fetcher)).rejects.toBeInstanceOf(ProductSpecificationsError); expect(deletes).toBe(0); }
		else { await executeProductCommand(session, replacement, fetcher); await executeProductCommand(session, replacement, fetcher); expect(deletes).toBe(1); }
	}
	await expect(executeProductCommand(session, replacement, async (_input, init) => {
		expect(init?.method).toBe('GET');
		return Response.json([{ ...product, name_en: 'Changed since review' }]);
	})).rejects.toBeInstanceOf(ProductSpecificationsError);
	expect(readProductCommand(storage)).toEqual(replacement);
});
