import { expect, test } from 'bun:test';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { rejection, type ConvexCaller } from './convex';
import { executeDetailCommand, parseAttribute, parseDetailCommand, type AttributeDefinition, type AttributeValue, type DetailCommand } from './admin-products';
import { productSpecificationFields, standardSpecificationDefinitions, standardSpecifications } from './product-specifications';
import { specificationLabel } from './i18n';

const actor = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const existingId = '33333333-3333-4333-8333-333333333333';
const customId = '44444444-4444-4444-8444-444444444444';
function standard(code: string): AttributeDefinition { return standardSpecifications.find(definition => definition.code === code)!; }
function value(attributeId: string, fields: Partial<AttributeValue>): AttributeValue {
	return { product_id: productId, attribute_id: attributeId, number_value: null, number_max: null, text_value: null, boolean_value: null, ...fields };
}
function command(after: AttributeValue): DetailCommand { return { userId: actor, kind: 'attribute', before: null, after }; }
/** Records each mutation by name; `answer` decides its outcome. */
function recorder(answer: (name: string, args: Record<string, unknown>, call: number) => unknown = () => 'saved') {
	const sent: { name: string; args: Record<string, unknown> }[] = [];
	const call = async (fn: FunctionReference<'query' | 'mutation' | 'action'>, args: Record<string, unknown>) => {
		const name = getFunctionName(fn); sent.push({ name, args });
		return answer(name, args, sent.length);
	};
	const client = { query: call, mutation: call, action: call } as unknown as ConvexCaller;
	return { sent, session: (userId = actor) => ({ client, userId }) };
}

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

test('a compatible existing definition keeps its database ID and label', () => {
	const resistance = { ...standard('resistance'), id: existingId, label: 'Recorded resistance' };
	const definitions = standardSpecificationDefinitions([resistance]);
	expect(definitions.filter(definition => definition.code === 'resistance')).toEqual([resistance]);
	expect(productSpecificationFields('RES', definitions, []).fields[0]).toEqual(resistance);
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

test('unknown values and mixed data types are never encoded as zero, false, or empty text', () => {
	const id = standard('resistance').id;
	expect(() => parseAttribute(value(id, {}))).toThrow();
	expect(() => parseAttribute(value(id, { number_value: '0', number_max: null, boolean_value: false }))).toThrow();
	expect(() => parseAttribute(value(id, { text_value: '', boolean_value: false }))).toThrow();
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

for (const [code, fields] of [
	['resistance', { number_value: '9007199254740993.000000000001' }],
	['resistance', { number_value: '0' }],
	['polarised', { boolean_value: false }],
	['model', { text_value: '' }]
] as const) {
	test(`saving ${code} ${JSON.stringify(fields)} sends exactly that value; the backend adds its definition in the same transaction`, async () => {
		const after = value(standard(code).id, fields);
		const { sent, session } = recorder();
		await executeDetailCommand(session(), command(after));
		const { product_id, ...shown } = after;
		expect(sent).toEqual([{ name: 'products:setAttribute', args: { productId: product_id, before: null, after: shown } }]);
	});
}

test('a lost reply retries the original saved command unchanged', async () => {
	const after = value(standard('capacitance').id, { number_value: '0.000000000001' });
	const frozen = JSON.stringify(command(after));
	const { sent, session } = recorder((_name, _args, call) => { if (call === 1) throw new Error('Lost response after commit'); return 'saved'; });
	await expect(executeDetailCommand(session(), parseDetailCommand(JSON.parse(frozen)))).rejects.toThrow('Lost response');
	await executeDetailCommand(session(), parseDetailCommand(JSON.parse(frozen)));
	expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]);
	expect(JSON.stringify(parseDetailCommand(JSON.parse(frozen)))).toBe(frozen);
});

test('a rejected value keeps its code, and another account never sends the command', async () => {
	const pending = command(value(standard('resistance').id, { number_value: '220' }));
	const frozen = JSON.stringify(pending);
	const { sent, session } = recorder(() => { throw rejection('DEFINITION_ID_TAKEN'); });
	await expect(executeDetailCommand(session(), pending)).rejects.toMatchObject({ data: { code: 'DEFINITION_ID_TAKEN' } });
	expect(JSON.stringify(pending)).toBe(frozen);
	await expect(executeDetailCommand(session(existingId), pending)).rejects.toThrow('Detail identity changed');
	expect(sent).toHaveLength(1);
});

test('a newly created custom type is selectable without a value and its lost reply uses the original identity', async () => {
	const definition: AttributeDefinition = { id: customId, code: `custom_${customId.replaceAll('-', '_')}`, label: 'Forward current', value_type: 'number', canonical_unit: 'mA' };
	const frozen = JSON.stringify({ userId: actor, kind: 'definition', before: null, after: definition });
	const { sent, session } = recorder((_name, _args, call) => { if (call === 1) throw new Error('Lost definition reply'); return customId; });
	await expect(executeDetailCommand(session(), parseDetailCommand(JSON.parse(frozen)))).rejects.toThrow('Lost');
	await executeDetailCommand(session(), parseDetailCommand(JSON.parse(frozen)));
	expect(sent).toEqual([{ name: 'products:createDefinition', args: definition }, { name: 'products:createDefinition', args: definition }]);
	for (const family of ['RES', 'LED', null] as const) expect(productSpecificationFields(family, standardSpecificationDefinitions([definition]), []).addable).toContainEqual(definition);
});
