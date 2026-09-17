import { expect, test } from 'bun:test';
import { addDecimals, compareDecimals, lineTotal, multiplyDecimals, normalizeDecimal, shiftDecimal, validQuantity } from './decimal';

test('normalizes deliberate decimal input without accepting grouping or exponent notation', () => {
	expect(normalizeDecimal(' +0001,2300 ', 'nb')).toBe('1.23');
	expect(normalizeDecimal('-.000')).toBe('0');
	expect(normalizeDecimal('.50')).toBe('0.5');
	for (const value of ['', '1,000', '1e3', 'Infinity', '1 000', '1.2.3']) expect(() => normalizeDecimal(value)).toThrow();
	expect(() => normalizeDecimal('1.000,50', 'nb')).toThrow();
});

test('compares tiny measurements and values beyond the float range exactly', () => {
	expect(compareDecimals('0.000000000005', '0.000000000006')).toBe(-1);
	expect(compareDecimals('9007199254740993', '9007199254740992')).toBe(1);
	expect(compareDecimals('-999999999999999999999999', '-999999999999999999999998')).toBe(-1);
	expect(compareDecimals('0001.2300', '1.23')).toBe(0);
	expect(compareDecimals('-1.00', '-1')).toBe(0);
});

test('adds and shifts without rounding and handles cancellation/negative values', () => {
	expect(addDecimals('999999999998.999999', '0.000001')).toBe('999999999999');
	expect(addDecimals('0.1', '0.2')).toBe('0.3');
	expect(addDecimals('-0.05', '0.01')).toBe('-0.04');
	expect(addDecimals('9007199254740993', '-9007199254740993')).toBe('0');
	expect(shiftDecimal('5', -12)).toBe('0.000000000005');
	expect(shiftDecimal('0.000000000005', 12)).toBe('5');
	expect(shiftDecimal('-12.34', 3)).toBe('-12340');
	expect(multiplyDecimals('0.000001', '0.000001')).toBe('0.000000000001');
	expect(multiplyDecimals('-1.5', '9007199254740993')).toBe('-13510798882111489.5');
	expect(multiplyDecimals('0.25', '4')).toBe('1');
});

test('rounds quantity times unit price once to two decimals with ties away from zero', () => {
	expect(lineTotal('3', '1.5')).toBe('4.5');
	expect(lineTotal('0.4', '12.345')).toBe('4.94');
	expect(lineTotal('1', '0.005')).toBe('0.01');
	expect(lineTotal('3', '0.005')).toBe('0.02');
	expect(lineTotal('1', '0.0049')).toBe('0');
	expect(lineTotal('-1', '0.005')).toBe('-0.01');
	expect(lineTotal('2', '3')).toBe('6');
	expect(lineTotal('999999999999', '999999999999')).toBe('999999999998000000000001');
});

test('validates exact sale steps, effective precision and combined command limits', () => {
	expect(validQuantity('0,30', '0.1', 'nb')).toBe('0.3');
	expect(validQuantity('1.0000000', '1')).toBe('1');
	expect(validQuantity('999999999999', '0.000001')).toBe('999999999999');
	for (const [value, step] of [['0', '1'], ['-1', '1'], ['0.3', '0.2'], ['1.0000001', '0.000001'],
		['999999999999.000001', '0.000001'], ['1', '0']]) expect(() => validQuantity(value, step)).toThrow();
});
