import { expect, test } from 'bun:test';
import { existingProducts, likelyDuplicates, normalizeName, onStandardSeries, unlikelyValue, type ExistingProduct } from './product-warnings';
import type { AdminProduct } from './admin-products';

test('knows the E24 and E96 series in every decade', () => {
	for (const value of ['0.0000000047', '0.000000000169', '3900', '2000', '1000000', '0.27', '10', '1', '0.000001', '47000']) expect(onStandardSeries(value)).toBe(true);
	for (const value of ['0.0000000006', '0.000000000125', '17', '0', '1234']) expect(onStandardSeries(value)).toBe(false);
});

test('warns about unlikely resistances and capacitances', () => {
	// 600 pF: off both series; precision parts exist, so the wording stays neutral.
	expect(unlikelyValue('capacitance', '0.0000000006', 'en')).toEqual({ code: 'capacitance', reason: 'series', shown: '600 pF', restated: null });
	expect(unlikelyValue('capacitance', '0.000000000169', 'en')).toBeNull();
	expect(unlikelyValue('capacitance', '0.0000000047', 'en')).toBeNull();
	expect(unlikelyValue('capacitance', '0.0022', 'nb')).toEqual({ code: 'capacitance', reason: 'large', shown: '2,2 mF', restated: '2 200 µF' });
	expect(unlikelyValue('capacitance', '0.0022', 'en')).toEqual({ code: 'capacitance', reason: 'large', shown: '2.2 mF', restated: '2,200 µF' });
	expect(unlikelyValue('capacitance', '0.001', 'en')?.reason).toBe('large');
	expect(unlikelyValue('capacitance', '0.00047', 'en')).toBeNull();
	// The shelf stocks 0,5 pF RF capacitors and 0,1–0,82 Ω current-sense resistors: off-series, not small.
	expect(unlikelyValue('capacitance', '0.0000000000005', 'nb')).toEqual({ code: 'capacitance', reason: 'series', shown: '0,5 pF', restated: null });
	expect(unlikelyValue('capacitance', '0.00000000000005', 'nb')?.reason).toBe('small');
	expect(unlikelyValue('capacitance', '0.000000000001', 'en')).toBeNull();
	expect(unlikelyValue('resistance', '0.27', 'nb')).toBeNull();
	expect(unlikelyValue('resistance', '0.047', 'nb')).toEqual({ code: 'resistance', reason: 'small', shown: '47 mΩ', restated: '0,047 Ω' });
	expect(unlikelyValue('resistance', '3900', 'en')).toBeNull();
	expect(unlikelyValue('resistance', '2000', 'en')).toBeNull();
	expect(unlikelyValue('resistance', '1000000', 'en')).toBeNull();
	expect(unlikelyValue('resistance', '10000000', 'en')).toBeNull();
	expect(unlikelyValue('resistance', '22000000', 'en')).toEqual({ code: 'resistance', reason: 'large', shown: '22 MΩ', restated: null });
	expect(unlikelyValue('resistance', '1700', 'en')).toEqual({ code: 'resistance', reason: 'series', shown: '1.7 kΩ', restated: null });
	// A 0 Ω link is a real part; other specifications are not checked.
	expect(unlikelyValue('resistance', '0', 'en')).toBeNull();
	expect(unlikelyValue('voltage', '17', 'en')).toBeNull();
});

const capacitors = '824dd61f-6781-49ae-8000-000000000002';
const resistors = '824dd61f-6781-49ae-8000-000000000001';
const row = (id: string, code: string, name_nb: string, name_en: string, category_id: string | null, numbers: ExistingProduct['numbers'] = {}, is_active = true): ExistingProduct =>
	({ id, code, name_nb, name_en, category_id, bin_id: null, is_active, numbers });

test('normalises names before comparing them', () => {
	expect(normalizeName('  Arduino   Nano\t')).toBe('arduino nano');
	expect(normalizeName('KAMERAMODUL')).toBe(normalizeName('kameramodul'));
	expect(normalizeName('Blå')).toBe(normalizeName('BLÅ'));
});

test('finds products a new one probably repeats', () => {
	const existing = [
		row('a', 'CAP-00001', 'Kondensator · keramisk 0,5 pF 300 V', 'Capacitor · ceramic 0.5 pF 300 V', capacitors, { capacitance: '0.0000000000005', voltage: '300' }),
		row('b', 'CAP-00002', 'Kondensator · elektrolytisk 100 µF', 'Capacitor · electrolytic 100 µF', capacitors, { capacitance: '0.0001' }, false),
		row('c', 'RES-00001', 'Motstand · 100 Ω', 'Resistor · 100 Ω', resistors, { resistance: '100' }),
		row('d', 'MCU-00001', 'Arduino Nano', 'Arduino Nano', null),
		row('e', 'CAP-00003', 'Kondensator · film 100 µF 63 V', 'Capacitor · film 100 µF 63 V', capacitors, { capacitance: '0.000100', voltage: '63' })
	];
	const candidate = { id: null, category_id: capacitors, name_nb: '', name_en: '', valueCode: 'capacitance' as const, value: '0.0000000000005' };
	expect(likelyDuplicates(candidate, existing).map(p => p.code)).toEqual(['CAP-00001']);
	// Exact decimals: 0.0001 and 0.000100 are the same; published products come first.
	expect(likelyDuplicates({ ...candidate, value: '0.0001' }, existing).map(p => p.code)).toEqual(['CAP-00003', 'CAP-00002']);
	// The value only matches within the category.
	expect(likelyDuplicates({ ...candidate, category_id: resistors, valueCode: 'resistance', value: '0.0001' }, existing)).toEqual([]);
	expect(likelyDuplicates({ ...candidate, category_id: resistors, valueCode: 'resistance', value: '100.0' }, existing).map(p => p.code)).toEqual(['RES-00001']);
	// Names match in either language, ignoring case and spacing.
	expect(likelyDuplicates({ id: null, category_id: null, name_nb: '  arduino  NANO ', name_en: '', valueCode: null, value: null }, existing).map(p => p.code)).toEqual(['MCU-00001']);
	expect(likelyDuplicates({ id: null, category_id: null, name_nb: 'Ny', name_en: 'capacitor · ceramic 0.5 pF 300 V', valueCode: null, value: null }, existing).map(p => p.code)).toEqual(['CAP-00001']);
	expect(likelyDuplicates({ id: null, category_id: null, name_nb: 'Arduino Uno', name_en: 'Arduino Uno', valueCode: null, value: null }, existing)).toEqual([]);
	// A creation being retried is not its own duplicate.
	expect(likelyDuplicates({ id: 'd', category_id: null, name_nb: 'Arduino Nano', name_en: '', valueCode: null, value: null }, existing)).toEqual([]);
});

test('reads the duplicate check numbers from specifications', () => {
	const product = { id: 'p', code: 'CAP-00001', name_nb: 'a', name_en: 'b', category_id: capacitors, bin_id: null, is_active: true } as AdminProduct;
	const definitions = [
		{ id: 'cap', code: 'capacitance', label: 'Capacitance', value_type: 'number' as const, canonical_unit: 'F' },
		{ id: 'volt', code: 'voltage', label: 'Voltage', value_type: 'number' as const, canonical_unit: 'V' },
		{ id: 'pkg', code: 'package', label: 'Package', value_type: 'text' as const, canonical_unit: null }
	];
	const values = [
		{ product_id: 'p', attribute_id: 'cap', number_value: '0.0000001', number_max: null, text_value: null, boolean_value: null },
		{ product_id: 'p', attribute_id: 'volt', number_value: '50', number_max: null, text_value: null, boolean_value: null },
		{ product_id: 'p', attribute_id: 'pkg', number_value: null, number_max: null, text_value: '0805', boolean_value: null },
		{ product_id: 'other', attribute_id: 'cap', number_value: '1', number_max: null, text_value: null, boolean_value: null }
	];
	expect(existingProducts([product], values, definitions)).toEqual([{ id: 'p', code: 'CAP-00001', name_nb: 'a', name_en: 'b', category_id: capacitors, bin_id: null, is_active: true, numbers: { capacitance: '0.0000001', voltage: '50' } }]);
});
