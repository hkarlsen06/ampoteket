import { compareDecimals, normalizeDecimal, shiftDecimal } from './decimal';
import type { Locale } from './i18n';

/** Exact display, including all significant fraction digits; never a money total. */
export function formatDecimal(value: string, locale: Locale): string {
	const [whole, fraction] = normalizeDecimal(value).split('.');
	const integer = whole.replace(/\B(?=(\d{3})+(?!\d))/g, locale === 'nb' ? '\u202f' : ',');
	return integer + (fraction ? (locale === 'nb' ? ',' : '.') + fraction : '');
}

/** Keep stored unit codes separate from English piece grammar. */
export function unitLabel(unit: string, locale: Locale, quantity?: string): string;
export function unitLabel(unit: string | null | undefined, locale: Locale, quantity?: string): string | undefined;
export function unitLabel(unit: string | null | undefined, locale: Locale, quantity?: string): string | undefined {
	if (unit == null) return undefined;
	return unit === 'pcs' || unit === 'stk'
		? (locale === 'nb' ? 'stk' : quantity === undefined ? 'pcs' : compareDecimals(quantity.replace(/^-/, ''), '1') === 0 ? 'piece' : 'pieces')
		: unit;
}

/** The one currency label for prices and totals: «kr» in Norwegian, “NOK” in English. */
export function currency(amount: string, locale: Locale): string {
	return `${amount} ${locale === 'nb' ? 'kr' : 'NOK'}`;
}

/** Two-decimal NOK amount for an already rounded money value. */
export function formatMoney(value: string, locale: Locale): string {
	const [whole, fraction = ''] = normalizeDecimal(value).split('.');
	return currency(`${formatDecimal(whole, locale)}${locale === 'nb' ? ',' : '.'}${fraction.padEnd(2, '0')}`, locale);
}

export function engineeringUnits(unit: string | null): { symbol: string; exponent: number }[] {
	if (unit === 'ohm') unit = 'Ω';
	const table: Record<string, { symbol: string; exponent: number }[]> = {
		F: [{ symbol: 'pF', exponent: -12 }, { symbol: 'nF', exponent: -9 }, { symbol: 'µF', exponent: -6 }, { symbol: 'mF', exponent: -3 }],
		H: [{ symbol: 'µH', exponent: -6 }, { symbol: 'mH', exponent: -3 }],
		Ω: [{ symbol: 'mΩ', exponent: -3 }, { symbol: 'kΩ', exponent: 3 }, { symbol: 'MΩ', exponent: 6 }, { symbol: 'GΩ', exponent: 9 }],
		V: [{ symbol: 'mV', exponent: -3 }, { symbol: 'kV', exponent: 3 }], A: [{ symbol: 'µA', exponent: -6 }, { symbol: 'mA', exponent: -3 }],
		W: [{ symbol: 'mW', exponent: -3 }, { symbol: 'kW', exponent: 3 }, { symbol: 'MW', exponent: 6 }], Hz: [{ symbol: 'kHz', exponent: 3 }, { symbol: 'MHz', exponent: 6 }, { symbol: 'GHz', exponent: 9 }],
		m: [{ symbol: 'mm', exponent: -3 }, { symbol: 'cm', exponent: -2 }]
	};
	return [{ symbol: unit ?? '', exponent: 0 }, ...(unit && Object.hasOwn(table, unit) ? table[unit] : [])];
}

/** Choose a readable supported SI prefix without rounding or JS-float conversion. */
export function formatMeasurement(value: string, unit: string | null, locale: Locale): string {
	const chosen = readableUnit(value, unit);
	return formatDecimal(shiftDecimal(normalizeDecimal(value), -chosen.exponent), locale) + (chosen.symbol ? ` ${chosen.symbol}` : '');
}

function readableUnit(value: string, unit: string | null) {
	const magnitude = normalizeDecimal(value).replace(/^-/, '');
	const units = engineeringUnits(unit).sort((a, b) => b.exponent - a.exponent);
	return magnitude === '0' ? units.find((choice) => choice.exponent === 0)!
		: units.find((choice) => compareDecimals(magnitude, shiftDecimal('1', choice.exponent)) >= 0) ?? units[units.length - 1];
}

/** Editable form of a stored measurement: "27 pF", but a bare number in the base unit the field already shows. */
export function measurementInput(value: string, unit: string | null, locale: Locale): string {
	const chosen = readableUnit(value, unit);
	const number = shiftDecimal(value, -chosen.exponent).replace('.', locale === 'nb' ? ',' : '.');
	return chosen.exponent ? `${number} ${chosen.symbol}` : number;
}

/** Staff input for a measurement field as a plain number of `unit`: "27p", "27 pF",
 * "4,7 kΩ", "4k7" and "1000 ohm" are all accepted. Prefixes are case-sensitive (m ≠ M). */
export function parseMeasurement(input: string, unit: string | null, locale: Locale): string {
	const [base] = engineeringUnits(unit);
	let text = input.trim();
	const names = [...(unit === 'ohm' ? ['ohms'] : []), unit ?? '', base.symbol].filter(Boolean);
	const name = names.find((candidate) => text.toLowerCase().endsWith(candidate.toLowerCase()));
	if (name) text = text.slice(0, -name.length).trimEnd();
	const prefixes = measurementPrefixes(unit);
	// "4k7" is 4.7 k: the prefix stands in for the decimal point.
	const match = /^(.*?\d)\s*(\D)(\d*)$/u.exec(text);
	if (!match || !prefixes.has(match[2])) return normalizeDecimal(text, locale);
	const number = normalizeDecimal(match[1], locale) + (match[3] ? `.${match[3]}` : '');
	return shiftDecimal(number, prefixes.get(match[2])!);
}

function measurementPrefixes(unit: string | null): Map<string, number> {
	const [base, ...prefixed] = engineeringUnits(unit);
	const prefixes = new Map(prefixed.map((choice) => [choice.symbol.slice(0, -base.symbol.length), choice.exponent]));
	for (const [alias, prefix] of [['u', 'µ'], ['μ', 'µ'], ['K', 'k']]) if (prefixes.has(prefix)) prefixes.set(alias, prefixes.get(prefix)!);
	if (base.symbol === 'Ω') prefixes.set('R', 0);
	return prefixes;
}

/** Tidies values typed into a product name: "100 uF" → "100 µF", and with the
 * category's `unit`, bare shorthand such as "4p7" or "10k" → "4,7 pF", "10 kΩ". */
export function tidyNameMeasurements(text: string, unit: string | null, locale: Locale): string {
	const prefixes = [...measurementPrefixes(unit).keys()].join('');
	const shorthand = prefixes && new RegExp(String.raw`(?<![\p{L}\p{N}_./+,−–—-])\d+(?:[.,]\d+)?[${prefixes}]\d*(?![\p{L}\p{N}_−–—-])`, 'gu');
	const expanded = shorthand ? text.replace(shorthand, (token) => {
		try { return formatMeasurement(parseMeasurement(token, unit, locale), unit, locale); }
		catch { return token; }
	}) : text;
	return formatMeasurementText(expanded, locale);
}

/** The first value in `unit` written in a (tidied) product name, as a plain number. */
export function nameMeasurement(text: string, unit: string, locale: Locale): string | null {
	const [base] = engineeringUnits(unit);
	for (const [, number, symbol] of text.matchAll(measurementInName)) {
		const { unit: found, exponent } = nameUnits.get(symbol)!;
		if (found !== base.symbol) continue;
		try { return shiftDecimal(normalizeDecimal(number, locale), exponent); }
		catch { /* grouped or ranged numbers stay text */ }
	}
	return null;
}

// Only explicit electrical measurements in names are reformatted. Part numbers,
// ranges and ambiguous grouped/exponential numbers must remain verbatim.
const nameUnits = new Map<string, { unit: string; exponent: number }>();
for (const unit of ['Ω', 'F', 'H', 'V', 'A', 'W', 'Hz']) {
	for (const choice of engineeringUnits(unit)) {
		const aliases = [choice.symbol, choice.symbol.replace('µ', 'u'), choice.symbol.replace('µ', 'μ')];
		if (unit === 'Ω') aliases.push(...['ohm', 'ohms', 'Ohm', 'Ohms'].map((word) => choice.symbol.replace('Ω', word)));
		for (const alias of aliases) nameUnits.set(alias, { unit, exponent: choice.exponent });
	}
}
const measurementInName = new RegExp(
	String.raw`(?<![\p{L}\p{N}_./+,−–—-])([+-]?(?:\d(?:[\d.,/ −–—\u00a0\u202f-]*\d)?|[.,]\d+))\s*(${[...nameUnits.keys()].sort((a, b) => b.length - a.length).join('|')})(?![\p{L}\p{N}_−–—-])`, 'gu'
);

/** `from` reads the numbers in another language, e.g. when a Norwegian name is translated. */
export function formatMeasurementText(text: string, locale: Locale, from: Locale = locale): string {
	return text.replace(measurementInName, (original, number: string, symbol: string, offset: number) => {
		// A shared unit applies to both values: never turn "1000 to 2000 ohm"
		// into "1000 to 2 kΩ" or change just the last item in a numeric list.
		if (/\d\s+(?:to|til|and|og|or|eller)\s*$/i.test(text.slice(0, offset))) return original;
		const { unit, exponent } = nameUnits.get(symbol)!;
		try { return formatMeasurement(shiftDecimal(normalizeDecimal(number, from), exponent), unit, locale); }
		catch { return original; }
	});
}

/** Column letter + row number (col 1, row 2 → A2); cabinet and drawer rows count upward from bottom-left. */
export function gridCell(row: number, col: number): string {
	let letters = '';
	for (let c = col; c > 0; c = Math.floor((c - 1) / 26)) {
		letters = String.fromCharCode(65 + ((c - 1) % 26)) + letters;
	}
	return letters + row;
}

/** A spanning drawer extends up/right from its bottom-left cell: C3, or C3–D4 for spans. */
export function gridRange(row: number, col: number, rowSpan: number, colSpan: number): string {
	const start = gridCell(row, col);
	if (rowSpan <= 1 && colSpan <= 1) return start;
	return `${start}–${gridCell(row + rowSpan - 1, col + colSpan - 1)}`;
}

export function formatCountedAt(value: string, locale: Locale): string {
	return new Intl.DateTimeFormat(locale === 'nb' ? 'nb-NO' : 'en-GB', {
		timeZone: 'Europe/Oslo', dateStyle: 'medium', timeStyle: 'short'
	}).format(new Date(value));
}
