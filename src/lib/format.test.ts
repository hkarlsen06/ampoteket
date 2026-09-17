import { expect, test } from 'bun:test';
import { currency, formatDecimal, formatMeasurement, formatMeasurementText, formatMoney, measurementInput, nameMeasurement, parseMeasurement, tidyNameMeasurements, unitLabel } from './format';

test('uses SI prefixes at exact thresholds, preserving sign, zero and every digit', () => {
	for (const [value, unit, expected] of [
		['999', 'ohm', '999 Ω'], ['1000', 'ohm', '1 kΩ'], ['10000', 'Ω', '10 kΩ'],
		['1000000', 'ohm', '1 MΩ'], ['-1250000', 'Ω', '-1.25 MΩ'], ['0', 'ohm', '0 Ω'],
		['0.5', 'Ω', '500 mΩ'], ['0.000000000005', 'F', '5 pF'],
		['0.00001', 'F', '10 µF'], ['0.00047', 'F', '470 µF'],
		['9007199254740993.000001', 'Ω', '9,007,199.254740993000001 GΩ'],
		['2.54', 'mm', '2.54 mm'], ['12.34', 'custom', '12.34 custom']
	]) expect(formatMeasurement(value, unit, 'en')).toBe(expected);
	expect(formatMeasurement('1250', 'ohm', 'nb')).toBe('1,25 kΩ');
	expect(formatMeasurement('1000', null, 'en')).toBe('1,000');
	expect(formatDecimal('1000.123456', 'nb')).toBe('1\u202f000,123456');
});

test('reads SI prefixes typed into measurement fields and shows stored values back the same way', () => {
	for (const [input, unit, expected] of [
		['27p', 'F', '0.000000000027'], ['27 pF', 'F', '0.000000000027'], ['4.7uF', 'F', '0.0000047'], ['100 µF', 'F', '0.0001'],
		['4k7', 'ohm', '4700'], ['2M2', 'ohm', '2200000'], ['1 kΩ', 'ohm', '1000'], ['1K', 'ohm', '1000'], ['10 mohm', 'ohm', '0.01'],
		['0R47', 'ohm', '0.47'], ['1000 ohm', 'ohm', '1000'], ['500 mA', 'A', '0.5'], ['25', 'V', '25'], ['5 %', '%', '5'], ['2.54mm', 'mm', '2.54']
	]) expect(parseMeasurement(input, unit, 'en')).toBe(expected);
	expect(parseMeasurement('4,7 kΩ', 'ohm', 'nb')).toBe('4700');
	for (const [input, unit] of [['27 x', 'F'], ['5k', '%'], ['4.5k7', 'ohm'], ['1.2.3', 'V'], ['', 'V']]) expect(() => parseMeasurement(input, unit, 'en')).toThrow();
	expect(measurementInput('0.000000000027', 'F', 'nb')).toBe('27 pF');
	expect(measurementInput('4700', 'ohm', 'nb')).toBe('4,7 kΩ');
	expect(measurementInput('25', 'V', 'en')).toBe('25');
	expect(measurementInput('1000', 'mm', 'en')).toBe('1000');
});

test('renders two-decimal NOK amounts with locale separators', () => {
	expect(formatMoney('4.94', 'en')).toBe('4.94 NOK');
	expect(formatMoney('1234.5', 'en')).toBe('1,234.50 NOK');
	expect(formatMoney('12345', 'nb')).toBe('12 345,00 kr');
	expect(formatMoney('0.5', 'nb')).toBe('0,50 kr');
	expect(formatMoney('0', 'en')).toBe('0.00 NOK');
});

test('formats explicit electrical values in names without double-scaling prefixes', () => {
	expect(formatMeasurementText('1000 ohm motstand (syntetisk 181)', 'nb')).toBe('1 kΩ motstand (syntetisk 181)');
	expect(formatMeasurementText('1,5 MOhm motstand', 'nb')).toBe('1,5 MΩ motstand');
	expect(formatMeasurementText('10 uF capacitor, 1000V', 'en')).toBe('10 µF capacitor, 1 kV');
	expect(formatMeasurementText('470 µF, 100 nF, 5 pF, 5 mm', 'en')).toBe('470 µF, 100 nF, 5 pF, 5 mm');
	expect(formatMeasurementText('1 mΩ and 1 MΩ', 'en')).toBe('1 mΩ and 1 MΩ');
});

test('preserves identifiers, unknown units and ambiguous number tokens in names', () => {
	for (const name of ['1N4007', 'IRLZ44N', 'HC-SR04P', '28BYJ-48', '1000V2', '1000V-2',
		'1,000 ohm resistor', '1 000 ohm resistor', '1\u202f000 ohm resistor',
		'1e3 ohm resistor', '1.2.3 V', '10–1000 ohm', '10 - 1000 ohm', '1/1000 ohm', '1000 custom', '1000 MF']) {
		expect(formatMeasurementText(name, 'en')).toBe(name);
	}
	for (const locale of ['nb', 'en'] as const) {
		for (const name of ['1000 til 2000 ohm', '1000 to 2000 ohm', '1000 og 2000 ohm', '1000 and 2000 ohm']) {
			expect(formatMeasurementText(name, locale)).toBe(name);
		}
	}
});

test('labels pieces and currency the same way for buyers and admins', () => {
	expect(unitLabel('pcs', 'nb')).toBe('stk');
	expect(unitLabel('stk', 'en')).toBe('pcs');
	expect(unitLabel('pcs', 'en', '1')).toBe('piece');
	expect(unitLabel('pcs', 'en', '1.0')).toBe('piece');
	expect(unitLabel('pcs', 'en', '-1')).toBe('piece');
	expect(unitLabel('pcs', 'en', '2')).toBe('pieces');
	expect(unitLabel('pcs', 'en', '0.5')).toBe('pieces');
	expect(unitLabel('m', 'nb')).toBe('m');
	expect(unitLabel(undefined, 'nb')).toBeUndefined();
	expect(currency('2', 'nb')).toBe('2 kr');
	expect(currency('2', 'en')).toBe('2 NOK');
});

test('tidies shorthand values in product names using the category unit', () => {
	expect(tidyNameMeasurements('Keramisk kondensator 4p7', 'F', 'nb')).toBe('Keramisk kondensator 4,7 pF');
	expect(tidyNameMeasurements('Ceramic capacitor 4p7', 'F', 'en')).toBe('Ceramic capacitor 4.7 pF');
	expect(tidyNameMeasurements('Elektrolyttkondensator 100u 25 V', 'F', 'nb')).toBe('Elektrolyttkondensator 100 µF 25 V');
	expect(tidyNameMeasurements('Motstand 4k7 0,25 W', 'ohm', 'nb')).toBe('Motstand 4,7 kΩ 250 mW');
	expect(tidyNameMeasurements('Motstand 10K', 'ohm', 'en')).toBe('Motstand 10 kΩ');
	expect(tidyNameMeasurements('Motstand 1000 ohm', null, 'nb')).toBe('Motstand 1 kΩ');
	expect(tidyNameMeasurements('Kondensator 4p7 2.54mm 1N4007 5 mm', 'F', 'en')).toBe('Kondensator 4.7 pF 2.54mm 1N4007 5 mm');
	expect(tidyNameMeasurements('Diode 4p7', null, 'en')).toBe('Diode 4p7');
	expect(nameMeasurement('Keramisk kondensator 4,7 pF 50 V', 'F', 'nb')).toBe('0.0000000000047');
	expect(nameMeasurement('Motstand 4,7 kΩ', 'ohm', 'nb')).toBe('4700');
	expect(nameMeasurement('Motstand', 'ohm', 'nb')).toBeNull();
});
