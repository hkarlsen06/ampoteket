import { compareDecimals, normalizeDecimal, shiftDecimal } from './decimal';
import { formatDecimal, formatMeasurement } from './format';
import type { Locale } from './i18n';
import type { AdminProduct, AttributeDefinition, AttributeValue } from './admin-products';

// Advice for product entry that never blocks saving: values that are probably a
// slip, and products that probably exist already. All values are exact decimal strings.

// Mantissas of the E24 and E96 series; E3–E12 and E48 are subsets.
const e24 = '10 11 12 13 15 16 18 20 22 24 27 30 33 36 39 43 47 51 56 62 68 75 82 91'.split(' ');
const e96 = ('100 102 105 107 110 113 115 118 121 124 127 130 133 137 140 143 147 150 154 158 162 165 169 174 178 182 187 191 196 '
	+ '200 205 210 215 221 226 232 237 243 249 255 261 267 274 280 287 294 301 309 316 324 332 340 348 357 365 374 383 392 '
	+ '402 412 422 432 442 453 464 475 487 499 511 523 536 549 562 576 590 604 619 634 649 665 681 698 715 732 750 768 787 '
	+ '806 825 845 866 887 909 931 953 976').split(' ');

/** Significant digits without the point or surrounding zeros: 0.0047 → "47", 3900 → "39". */
function significand(value: string): string {
	return normalizeDecimal(value).replace(/^-/, '').replace('.', '').replace(/^0+/, '').replace(/0+$/, '');
}

/** On the E24 or E96 series in any decade. */
export function onStandardSeries(value: string): boolean {
	const digits = significand(value);
	return (digits.length > 0 && digits.length <= 2 && e24.includes(digits.padEnd(2, '0')))
		|| (digits.length > 0 && digits.length <= 3 && e96.includes(digits.padEnd(3, '0')));
}

type Unit = { exponent: number; symbol: string };
// Plausible stock for a workshop shelf: below `min` is small, above `max` (or at it
// when `atMaxIsLarge`) is large. The restated units are the ones a part is usually marked in.
const plausible = {
	resistance: { unit: 'ohm', min: '0.1', max: '10000000', atMaxIsLarge: false, small: { exponent: 0, symbol: 'Ω' }, large: { exponent: 6, symbol: 'MΩ' } },
	capacitance: { unit: 'F', min: '0.0000000000001', max: '0.001', atMaxIsLarge: true, small: { exponent: -12, symbol: 'pF' }, large: { exponent: -6, symbol: 'µF' } }
} satisfies Record<string, { unit: string; min: string; max: string; atMaxIsLarge: boolean; small: Unit; large: Unit }>;
export type ValueCode = keyof typeof plausible;
export const valueCodes = Object.keys(plausible) as ValueCode[];

/** `shown` is the value as the field shows it; `restated`, when it differs, the same value in the usual unit. */
export type ValueWarning = { code: ValueCode; reason: 'small' | 'large' | 'series'; shown: string; restated: string | null };

/** Why a resistance (ohm) or capacitance (F) is unlikely, or null. A 0 Ω link is a real part. */
export function unlikelyValue(code: string, value: string, locale: Locale): ValueWarning | null {
	if (!Object.hasOwn(plausible, code)) return null;
	const check = plausible[code as ValueCode];
	const exact = normalizeDecimal(value);
	if (code === 'resistance' && exact === '0') return null;
	const shown = formatMeasurement(exact, check.unit, locale);
	const above = compareDecimals(exact, check.max);
	const reason = compareDecimals(exact, check.min) < 0 ? 'small' : above > 0 || (above === 0 && check.atMaxIsLarge) ? 'large' : onStandardSeries(exact) ? null : 'series';
	if (!reason) return null;
	const target = reason === 'series' ? null : check[reason];
	const restated = target && `${formatDecimal(shiftDecimal(exact, -target.exponent), locale)} ${target.symbol}`;
	return { code: code as ValueCode, reason, shown, restated: restated && restated !== shown ? restated : null };
}

export type ExistingProduct = Pick<AdminProduct, 'id' | 'code' | 'name_nb' | 'name_en' | 'category_id' | 'bin_id' | 'is_active'> & { numbers: Partial<Record<ValueCode | 'voltage', string>> };

/** Products with the numbers duplicate checks read: resistance, capacitance and voltage. */
export function existingProducts(products: AdminProduct[], values: AttributeValue[], definitions: AttributeDefinition[]): ExistingProduct[] {
	const codes = new Map(definitions.filter(definition => definition.value_type === 'number' && ['resistance', 'capacitance', 'voltage'].includes(definition.code)).map(definition => [definition.id, definition.code as ValueCode | 'voltage']));
	const numbers = new Map<string, ExistingProduct['numbers']>();
	for (const value of values) {
		const code = codes.get(value.attribute_id);
		if (code && value.number_value !== null) numbers.set(value.product_id, { ...numbers.get(value.product_id), [code]: value.number_value });
	}
	return products.map(({ id, code, name_nb, name_en, category_id, bin_id, is_active }) => ({ id, code, name_nb, name_en, category_id, bin_id, is_active, numbers: numbers.get(id) ?? {} }));
}

/** Case, surrounding and repeated whitespace do not make a name different. */
export function normalizeName(name: string): string {
	return name.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('nb');
}

export type DuplicateCandidate = { id: string | null; category_id: string | null; name_nb: string; name_en: string; valueCode: ValueCode | null; value: string | null };

/** Existing products that a new one probably repeats: the same category and value
 * (resistors, capacitors), or the same name in either language. Unpublished ones count. */
export function likelyDuplicates(candidate: DuplicateCandidate, existing: ExistingProduct[]): ExistingProduct[] {
	const names = [candidate.name_nb, candidate.name_en].map(normalizeName).filter(Boolean);
	return existing.filter(product => {
		if (product.id === candidate.id) return false;
		const number = candidate.valueCode ? product.numbers[candidate.valueCode] : undefined;
		const sameValue = candidate.value !== null && number !== undefined && product.category_id === candidate.category_id && compareDecimals(number, candidate.value) === 0;
		return sameValue || [product.name_nb, product.name_en].some(name => names.includes(normalizeName(name)));
	}).sort((a, b) => Number(b.is_active) - Number(a.is_active) || a.code.localeCompare(b.code));
}
