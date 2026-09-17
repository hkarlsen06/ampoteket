import { expect, test } from 'bun:test';
import { ApiError } from './api';
import { executeDetailCommand, parseAttribute, parseDetailCommand, type AttributeDefinition, type AttributeValue, type DetailCommand } from './admin-products';
import { productSpecificationFields, standardSpecificationDefinitions, standardSpecifications } from './product-specifications';
import { specificationLabel } from './i18n';

const actor = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const existingId = '33333333-3333-4333-8333-333333333333';
const customId = '44444444-4444-4444-8444-444444444444';
const session = { userId: actor, token: 'staff-jwt', config: { url: 'https://fixture.invalid', publishableKey: 'sb_publishable_fixture' } };
function standard(code: string): AttributeDefinition { return standardSpecifications.find(definition => definition.code === code)!; }
function value(attributeId: string, fields: Partial<AttributeValue>): AttributeValue {
	return { product_id: productId, attribute_id: attributeId, number_value: null, text_value: null, boolean_value: null, ...fields };
}
function command(after: AttributeValue): DetailCommand { return { userId: actor, kind: 'attribute', before: null, after }; }
const definitionView = '/rest/v1/amp_attribute_definitions';
const valueView = '/rest/v1/amp_product_attributes';

test('empty definition storage offers category-specific fields and every standard field for miscellaneous', () => {
	const definitions = standardSpecificationDefinitions([]);
	const resistors = productSpecificationFields('RES', definitions, []).fields.map(definition => definition.code);
	const capacitors = productSpecificationFields('CAP', definitions, []).fields.map(definition => definition.code);
	expect(resistors).toContain('resistance');
	expect(resistors).toContain('power');
	expect(resistors).toContain('tolerance');
	expect(resistors).not.toContain('capacitance');
	expect(capacitors).toContain('capacitance');
	expect(capacitors).toContain('voltage');
	expect(capacitors).toContain('polarised');
	expect(capacitors).not.toContain('resistance');
	expect(productSpecificationFields('MIS', definitions, []).fields).toEqual(definitions);
	expect(productSpecificationFields(null, definitions, []).fields).toEqual(definitions);
	expect(new Set(definitions.map(definition => definition.id)).size).toBe(definitions.length);
	expect(new Set(definitions.map(definition => definition.code)).size).toBe(definitions.length);
});

test('a compatible existing definition keeps its database ID and label', async () => {
	const resistance = { ...standard('resistance'), id: existingId, label: 'Recorded resistance' };
	const definitions = standardSpecificationDefinitions([resistance]);
	expect(definitions.filter(definition => definition.code === 'resistance')).toEqual([resistance]);
	expect(productSpecificationFields('RES', definitions, []).fields[0]).toEqual(resistance);
	const after = value(existingId, { number_value: '220' });
	let writes = 0;
	await executeDetailCommand(session, command(after), async (input, init) => {
		expect(new URL(String(input)).pathname).toBe(valueView);
		if (init?.method === 'GET') return Response.json([]);
		writes++;
		expect(JSON.parse(String(init?.body))).toEqual(after);
		return Response.json([after]);
	});
	expect(writes).toBe(1);
});

test('an existing standard code with incompatible meaning blocks the standard list', () => {
	for (const change of [{ value_type: 'text' as const, canonical_unit: null }, { canonical_unit: 'kohm' }, { canonical_unit: null }]) {
		expect(() => standardSpecificationDefinitions([{ ...standard('resistance'), id: existingId, ...change }])).toThrow('Conflicting standard specification');
	}
});

test('recategorization keeps recorded and added fields shown, and offers unshown custom types', () => {
	const custom = { id: customId, code: 'workshop_note', label: 'Workshop note', value_type: 'text' as const, canonical_unit: null };
	const unusedCustom = { ...custom, id: existingId, code: 'unused_note' };
	const definitions = standardSpecificationDefinitions([custom, unusedCustom]);
	const resistance = standard('resistance');
	const power = standard('power');
	const { fields, addable } = productSpecificationFields('CAP', definitions, [resistance.id, custom.id, power.id]);
	expect(fields.map(definition => definition.code)).toContain('capacitance');
	for (const definition of [resistance, custom, power]) expect(fields).toContainEqual(definition);
	expect(addable).toEqual([unusedCustom]);
	expect(new Set(fields.map(definition => definition.id)).size).toBe(fields.length);
	expect(productSpecificationFields('CAP', definitions, []).fields).not.toContainEqual(power);
	expect(productSpecificationFields('CAP', definitions, []).addable).not.toContainEqual(power);
});

for (const [code, fields] of [
	['resistance', { number_value: '9007199254740993.000000000001' }],
	['resistance', { number_value: '0' }],
	['polarised', { boolean_value: false }],
	['model', { text_value: '' }]
] as const) {
	test(`saving ${code} ${JSON.stringify(fields)} creates only its required definition and preserves the value`, async () => {
		const definition = standard(code);
		const after = value(definition.id, fields);
		const requests: string[] = [];
		await executeDetailCommand(session, command(after), async (input, init) => {
			const url = new URL(String(input));
			requests.push(`${init?.method} ${url.pathname}`);
			expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer staff-jwt');
			if (init?.method === 'GET') return Response.json([]);
			if (url.pathname === definitionView) {
				expect(JSON.parse(String(init?.body))).toEqual(definition);
				return Response.json([definition]);
			}
			expect(url.pathname).toBe(valueView);
			expect(JSON.parse(String(init?.body))).toEqual(after);
			return Response.json([after]);
		});
		expect(requests).toEqual([`GET ${valueView}`, `GET ${definitionView}`, `POST ${definitionView}`, `POST ${valueView}`]);
	});
}

test('unknown values and mixed data types are never encoded as zero, false, or empty text', () => {
	const id = standard('resistance').id;
	expect(() => parseAttribute(value(id, {}))).toThrow();
	expect(() => parseAttribute(value(id, { number_value: '0', boolean_value: false }))).toThrow();
	expect(() => parseAttribute(value(id, { text_value: '', boolean_value: false }))).toThrow();
});

for (const lostReply of ['definition', 'value'] as const) {
	test(`a lost ${lostReply} reply retries the original saved command without duplicate definitions or values`, async () => {
		const definition = standard('capacitance');
		const after = value(definition.id, { number_value: '0.000000000001' });
		const frozen = JSON.stringify(command(after));
		let definitionExists = false;
		let valueExists = false;
		let definitionWrites = 0;
		let valueWrites = 0;
		const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
			if (new URL(String(input)).pathname === definitionView) {
				if (init?.method === 'GET') return Response.json(definitionExists ? [definition] : []);
				definitionWrites++;
				definitionExists = true;
				expect(JSON.parse(String(init?.body))).toEqual(definition);
				if (lostReply === 'definition') throw new Error('Lost response after commit');
				return Response.json([definition]);
			}
			expect(new URL(String(input)).pathname).toBe(valueView);
			if (init?.method === 'GET') return Response.json(valueExists ? [after] : []);
			valueWrites++;
			valueExists = true;
			expect(JSON.parse(String(init?.body))).toEqual(after);
			if (lostReply === 'value') throw new Error('Lost response after commit');
			return Response.json([after]);
		};
		await expect(executeDetailCommand(session, parseDetailCommand(JSON.parse(frozen)), fetcher)).rejects.toThrow('Lost response');
		await executeDetailCommand(session, parseDetailCommand(JSON.parse(frozen)), fetcher);
		await executeDetailCommand(session, parseDetailCommand(JSON.parse(frozen)), fetcher);
		expect(definitionWrites).toBe(1);
		expect(valueWrites).toBe(1);
		expect(JSON.stringify(parseDetailCommand(JSON.parse(frozen)))).toBe(frozen);
	});
}

test('a concurrent first definition creation reconciles a unique violation before saving the value', async () => {
	const definition = standard('voltage');
	const after = value(definition.id, { number_value: '5' });
	let definitionReads = 0;
	let definitionWrites = 0;
	let valueWrites = 0;
	await executeDetailCommand(session, command(after), async (input, init) => {
		if (new URL(String(input)).pathname === definitionView) {
			if (init?.method === 'GET') return Response.json(definitionReads++ ? [definition] : []);
			definitionWrites++;
			return Response.json({ code: '23505' }, { status: 409 });
		}
		if (init?.method === 'GET') return Response.json([]);
		valueWrites++;
		return Response.json([after]);
	});
	expect(definitionReads).toBe(2);
	expect(definitionWrites).toBe(1);
	expect(valueWrites).toBe(1);
});

test('a unique conflict with no matching standard ID remains rejected and never writes a value', async () => {
	const after = value(standard('voltage').id, { number_value: '5' });
	let valueWrites = 0;
	await expect(executeDetailCommand(session, command(after), async (input, init) => {
		if (init?.method === 'GET') return Response.json([]);
		if (new URL(String(input)).pathname === definitionView) return Response.json({ code: '23505' }, { status: 409 });
		valueWrites++;
		return Response.json([after]);
	})).rejects.toBeInstanceOf(ApiError);
	expect(valueWrites).toBe(0);
});

test('an occupied standard ID with conflicting code, type, or unit never receives a value', async () => {
	const definition = standard('resistance');
	const after = value(definition.id, { number_value: '220' });
	for (const change of [{ code: 'something_else' }, { value_type: 'text', canonical_unit: null }, { canonical_unit: 'kohm' }, { id: existingId }]) {
		let writes = 0;
		await expect(executeDetailCommand(session, command(after), async (input, init) => {
			if (init?.method !== 'GET') writes++;
			return Response.json(new URL(String(input)).pathname === definitionView ? [{ ...definition, ...change }] : []);
		})).rejects.toThrow('Specification identity differs');
		expect(writes).toBe(0);
	}
});

test('denied definition creation preserves the error and stops before the attribute write', async () => {
	const pending = command(value(standard('resistance').id, { number_value: '220' }));
	const frozen = JSON.stringify(pending);
	let valueWrites = 0;
	await expect(executeDetailCommand(session, pending, async (input, init) => {
		if (init?.method === 'GET') return Response.json([]);
		if (new URL(String(input)).pathname === definitionView) return Response.json({ code: '42501' }, { status: 403 });
		valueWrites++;
		return Response.json([pending.after]);
	})).rejects.toMatchObject({ status: 403, body: { code: '42501' } });
	expect(valueWrites).toBe(0);
	expect(JSON.stringify(pending)).toBe(frozen);
	await expect(executeDetailCommand({ ...session, userId: existingId }, pending, async () => {
		throw new Error('A different account must never send this command');
	})).rejects.toThrow('Detail identity changed');
});

test('standard labels translate matching metadata and keep custom or conflicting meanings as recorded', () => {
	const resistance = standard('resistance');
	expect(specificationLabel('resistance', resistance, 'nb')).toBe('Resistans');
	expect(specificationLabel('resistance', resistance, 'en')).toBe('Resistance');
	expect(specificationLabel('resistance', { label: 'Saved resistance', value_type: 'number', unit: 'ohm' }, 'nb')).toBe('Resistans');
	expect(specificationLabel('workshop_note', { label: 'Workshop note', value_type: 'text' }, 'nb')).toBe('Workshop note');
	for (const change of [{ value_type: 'text' }, { canonical_unit: 'kohm' }]) {
		expect(specificationLabel('resistance', { ...resistance, label: 'Special resistance', ...change }, 'nb')).toBe('Special resistance');
	}
});

test('a newly created custom type is selectable without a value and its lost reply uses the original identity', async () => {
	const definition: AttributeDefinition = { id: customId, code: `custom_${customId.replaceAll('-', '_')}`, label: 'Forward current', value_type: 'number', canonical_unit: 'mA' };
	const frozen = JSON.stringify({ userId: actor, kind: 'definition', before: null, after: definition });
	let exists = false; let writes = 0;
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		expect(new URL(String(input)).pathname).toBe(definitionView);
		if (init?.method === 'GET') return Response.json(exists ? [definition] : []);
		expect(JSON.parse(String(init?.body))).toEqual(definition);
		exists = true; writes++; throw new Error('Lost definition reply');
	};
	await expect(executeDetailCommand(session, parseDetailCommand(JSON.parse(frozen)), fetcher)).rejects.toThrow('Lost');
	await executeDetailCommand(session, parseDetailCommand(JSON.parse(frozen)), fetcher);
	expect(writes).toBe(1);
	for (const family of ['RES', 'LED', null] as const) expect(productSpecificationFields(family, standardSpecificationDefinitions([definition]), []).addable).toContainEqual(definition);
});
