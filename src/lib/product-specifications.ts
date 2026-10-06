import type { AttributeDefinition } from './admin-products';

// Stable identities for categories first created through the standard picker.
// Never change an ID when reordering or translating the choices.
export const productTypes = [
	{ prefix: 'RES', name: 'Resistors', id: '824dd61f-6781-49ae-8000-000000000001' },
	{ prefix: 'CAP', name: 'Capacitors', id: '824dd61f-6781-49ae-8000-000000000002' },
	{ prefix: 'DIO', name: 'Diodes', id: '824dd61f-6781-49ae-8000-000000000003' },
	{ prefix: 'LED', name: 'LEDs', id: '824dd61f-6781-49ae-8000-000000000004' },
	{ prefix: 'BJT', name: 'Bipolar transistors', id: '824dd61f-6781-49ae-8000-000000000005' },
	{ prefix: 'MOS', name: 'MOSFETs', id: '824dd61f-6781-49ae-8000-000000000006' },
	{ prefix: 'MCU', name: 'Controllers', id: '824dd61f-6781-49ae-8000-000000000007' },
	{ prefix: 'SEN', name: 'Sensors', id: '824dd61f-6781-49ae-8000-000000000008' },
	{ prefix: 'MOT', name: 'Motors', id: '824dd61f-6781-49ae-8000-000000000009' },
	{ prefix: 'DRV', name: 'Motor drivers', id: '824dd61f-6781-49ae-8000-00000000000a' },
	{ prefix: 'CON', name: 'Connectors', id: '824dd61f-6781-49ae-8000-00000000000b' },
	{ prefix: 'BRD', name: 'Prototyping', id: '824dd61f-6781-49ae-8000-00000000000c' },
	{ prefix: 'CAB', name: 'Cable', id: '824dd61f-6781-49ae-8000-00000000000d' },
	{ prefix: 'MIS', name: 'Miscellaneous', id: '824dd61f-6781-49ae-8000-00000000000e' }
] as const;
export const productFamilies = productTypes.map(type => type.prefix);
export type ProductFamily = typeof productFamilies[number];

// Existing definitions are reused by code, type and unit. These IDs are only
// used on first creation and must never change when the list is reordered.
export const standardSpecifications = [
	{ id: '30929fae-4785-49a7-8000-000000000001', code: 'resistance', label: 'Resistance', value_type: 'number', canonical_unit: 'ohm' },
	{ id: '30929fae-4785-49a7-8000-000000000002', code: 'capacitance', label: 'Capacitance', value_type: 'number', canonical_unit: 'F' },
	{ id: '30929fae-4785-49a7-8000-000000000003', code: 'voltage', label: 'Voltage', value_type: 'number', canonical_unit: 'V' },
	{ id: '30929fae-4785-49a7-8000-000000000004', code: 'power', label: 'Power', value_type: 'number', canonical_unit: 'W' },
	{ id: '30929fae-4785-49a7-8000-000000000005', code: 'tolerance', label: 'Tolerance', value_type: 'number', canonical_unit: '%' },
	{ id: '30929fae-4785-49a7-8000-000000000006', code: 'package', label: 'Package', value_type: 'text', canonical_unit: null },
	{ id: '30929fae-4785-49a7-8000-000000000007', code: 'model', label: 'Model', value_type: 'text', canonical_unit: null },
	{ id: '30929fae-4785-49a7-8000-000000000008', code: 'colour', label: 'Colour', value_type: 'text', canonical_unit: null },
	{ id: '30929fae-4785-49a7-8000-000000000009', code: 'pitch', label: 'Pitch', value_type: 'number', canonical_unit: 'mm' },
	{ id: '30929fae-4785-49a7-8000-00000000000a', code: 'pins', label: 'Pins', value_type: 'number', canonical_unit: null },
	{ id: '30929fae-4785-49a7-8000-00000000000b', code: 'polarised', label: 'Polarised', value_type: 'boolean', canonical_unit: null },
	{ id: '30929fae-4785-49a7-8000-00000000000c', code: 'interface', label: 'Interface', value_type: 'text', canonical_unit: null },
	{ id: '30929fae-4785-49a7-8000-00000000000d', code: 'step_angle', label: 'Step angle', value_type: 'number', canonical_unit: 'deg' },
	{ id: '30929fae-4785-49a7-8000-00000000000e', code: 'current', label: 'Current', value_type: 'number', canonical_unit: 'A' }
] as const satisfies readonly AttributeDefinition[];

type SpecificationCode = typeof standardSpecifications[number]['code'];
export const categorySpecifications: Record<ProductFamily, readonly SpecificationCode[]> = {
	RES: ['resistance', 'power', 'tolerance', 'package', 'model'],
	CAP: ['capacitance', 'voltage', 'tolerance', 'polarised', 'package', 'model'],
	DIO: ['model', 'voltage', 'current', 'package'],
	LED: ['colour', 'voltage', 'current', 'package', 'model'],
	BJT: ['model', 'voltage', 'current', 'power', 'package'],
	MOS: ['model', 'voltage', 'current', 'power', 'package'],
	MCU: ['model', 'voltage', 'interface', 'pins'],
	SEN: ['model', 'voltage', 'interface'],
	MOT: ['model', 'voltage', 'current', 'power', 'step_angle', 'interface'],
	DRV: ['model', 'voltage', 'current', 'interface', 'package'],
	CON: ['pins', 'pitch', 'current', 'voltage', 'package', 'model'],
	BRD: ['pins', 'pitch', 'package', 'model'],
	CAB: ['colour', 'voltage', 'current', 'model'],
	MIS: standardSpecifications.map(definition => definition.code)
};

/** The public catalog lists categories in picker order, each sorted by its first
 * suggested specification (Miscellaneous by name). amp_catalog's p_sort. */
export const catalogSort: [string, string | null][] = productTypes.map(type => [type.name, type.prefix === 'MIS' ? null : categorySpecifications[type.prefix][0]]);

export function standardSpecificationDefinitions(existing: AttributeDefinition[]): AttributeDefinition[] {
	const standards = standardSpecifications.map(standard => {
		const saved = existing.find(definition => definition.code === standard.code);
		if (saved && (saved.value_type !== standard.value_type || saved.canonical_unit !== standard.canonical_unit)) throw new Error('Conflicting standard specification');
		return saved ?? standard;
	});
	return [...standards, ...existing.filter(definition => !standardSpecifications.some(standard => standard.code === definition.code))];
}

/** The category's suggested fields always show; recorded, added and pending
 * fields stay shown after a category change. Unshown custom types can be added. */
export function productSpecificationFields(family: ProductFamily | null, definitions: AttributeDefinition[], shownIds: string[]): { fields: AttributeDefinition[]; addable: AttributeDefinition[] } {
	const codes: readonly string[] = categorySpecifications[family ?? 'MIS'];
	const suggested = codes.map(code => definitions.find(definition => definition.code === code)).filter((definition): definition is AttributeDefinition => Boolean(definition));
	const fields = [...suggested, ...definitions.filter(definition => !codes.includes(definition.code) && shownIds.includes(definition.id))];
	const addable = definitions.filter(definition => !fields.includes(definition) && !standardSpecifications.some(standard => standard.code === definition.code));
	return { fields, addable };
}
