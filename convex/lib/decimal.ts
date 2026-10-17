/**
 * Exact decimal arithmetic for quantities, money and specification values.
 *
 * Values are stored and transported as decimal strings ("12.5", "-0.000001").
 * Arithmetic uses BigInt with an explicit scale, never JavaScript floats.
 * This replaces PostgreSQL `numeric`; the domain rules from the original
 * schema (at most 6 decimals for quantities, 2 for NOK amounts) live in the
 * `checked*` helpers below.
 */
import { fail } from './errors';

export type Decimal = { units: bigint; scale: number };

const pattern = /^(-?)(\d+)(?:\.(\d+))?$/;
/** The largest command quantity or price (`999999999999`). */
export const MAX_COMMAND = '999999999999';

export function parseDecimal(value: string): Decimal {
	const match = typeof value === 'string' && value.length <= 2000 ? pattern.exec(value) : null;
	if (!match) fail('INVALID_DECIMAL');
	const fraction = match[3] ?? '';
	const units = BigInt(match[2] + fraction);
	return { units: match[1] ? -units : units, scale: fraction.length };
}

export function isDecimal(value: unknown): value is string {
	return typeof value === 'string' && value.length <= 2000 && pattern.test(value);
}

function align(a: Decimal, b: Decimal): [bigint, bigint, number] {
	const scale = Math.max(a.scale, b.scale);
	return [a.units * 10n ** BigInt(scale - a.scale), b.units * 10n ** BigInt(scale - b.scale), scale];
}

/** Plain text without exponent; keeps `scale` decimals (like numeric::text). */
export function formatDecimal(value: Decimal): string {
	const negative = value.units < 0n;
	const digits = (negative ? -value.units : value.units).toString().padStart(value.scale + 1, '0');
	const whole = value.scale ? digits.slice(0, -value.scale) : digits;
	const fraction = value.scale ? digits.slice(-value.scale) : '';
	const text = fraction ? `${whole}.${fraction}` : whole;
	return negative && value.units !== 0n ? `-${text}` : text;
}

/** Remove trailing fractional zeros (PostgreSQL `trim_scale`). */
export function trimScale(value: string): string {
	const d = parseDecimal(value);
	let { units, scale } = d;
	while (scale > 0 && units % 10n === 0n) { units /= 10n; scale--; }
	return formatDecimal({ units, scale });
}

export function compareDecimals(a: string, b: string): number {
	const [x, y] = align(parseDecimal(a), parseDecimal(b));
	return x < y ? -1 : x > y ? 1 : 0;
}

export function addDecimals(a: string, b: string): string {
	const [x, y, scale] = align(parseDecimal(a), parseDecimal(b));
	return formatDecimal({ units: x + y, scale });
}

export function subtractDecimals(a: string, b: string): string {
	const [x, y, scale] = align(parseDecimal(a), parseDecimal(b));
	return formatDecimal({ units: x - y, scale });
}

export function negateDecimal(a: string): string {
	const d = parseDecimal(a);
	return formatDecimal({ units: -d.units, scale: d.scale });
}

export function multiplyDecimals(a: string, b: string): string {
	const x = parseDecimal(a), y = parseDecimal(b);
	return formatDecimal({ units: x.units * y.units, scale: x.scale + y.scale });
}

/** Round half away from zero to `scale` decimals (PostgreSQL `round(numeric, int)`). */
export function roundDecimal(value: string, scale: number): string {
	const d = parseDecimal(value);
	if (d.scale <= scale) return formatDecimal({ units: d.units * 10n ** BigInt(scale - d.scale), scale });
	const divisor = 10n ** BigInt(d.scale - scale);
	const negative = d.units < 0n;
	const magnitude = negative ? -d.units : d.units;
	let quotient = magnitude / divisor;
	if ((magnitude % divisor) * 2n >= divisor) quotient += 1n;
	return formatDecimal({ units: negative ? -quotient : quotient, scale });
}

/** True when `value` is a whole multiple of `step` (PostgreSQL `mod(value, step) = 0`). */
export function isMultipleOf(value: string, step: string): boolean {
	const [x, y] = align(parseDecimal(value), parseDecimal(step));
	if (y === 0n) throw new Error('DIVISION_BY_ZERO');
	return x % y === 0n;
}

/** Exact ratio comparison a/b versus c/d for positive denominators. */
export function compareRatios(a: string, b: string, c: string, d: string): number {
	return compareDecimals(multiplyDecimals(a, d), multiplyDecimals(c, b));
}

export function sumDecimals(values: Iterable<string>): string {
	let total = '0';
	for (const value of values) total = addDecimals(total, value);
	return total;
}

export function decimalScale(value: string): number {
	return parseDecimal(value).scale;
}

/**
 * Domain checks from the original migration. They reject excess precision
 * instead of rounding it. `code` is the error raised for malformed input.
 */
export function checkedQuantity(value: unknown, code = 'INVALID_QUANTITY'): string {
	if (!isDecimal(value) || decimalScale(value) > 6
		|| compareDecimals(value, `-${MAX_COMMAND}`) < 0 || compareDecimals(value, MAX_COMMAND) > 0) fail(code);
	return value;
}
export function checkedStockQuantity(value: unknown, code = 'INVALID_QUANTITY'): string {
	if (!isDecimal(value) || decimalScale(value) > 6) fail(code);
	return value;
}
export function checkedUnitPrice(value: unknown, code = 'INVALID_PRICE'): string {
	if (!isDecimal(value) || decimalScale(value) > 6
		|| compareDecimals(value, '0') < 0 || compareDecimals(value, MAX_COMMAND) > 0) fail(code);
	return value;
}
export function checkedNokAmount(value: unknown, code = 'INVALID_AMOUNT'): string {
	if (!isDecimal(value) || decimalScale(value) > 2
		|| compareDecimals(value, '0') < 0 || compareDecimals(value, MAX_COMMAND) > 0) fail(code);
	return value;
}
