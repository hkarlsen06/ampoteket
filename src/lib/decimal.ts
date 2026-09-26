/** Exact decimal input/arithmetic; domain values never pass through JS Number. */
export function normalizeDecimal(input: string, locale: 'nb' | 'en' = 'en'): string {
	let text = input.trim();
	if (locale === 'nb') text = text.replace(',', '.');
	if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) throw new SyntaxError('INVALID_DECIMAL');
	const negative = text.startsWith('-');
	text = text.replace(/^[+-]/, '');
	const [whole, fraction = ''] = text.split('.');
	const integer = whole.replace(/^0+/, '') || '0';
	const tail = fraction.replace(/0+$/, '');
	return (negative && (integer !== '0' || tail) ? '-' : '') + integer + (tail ? `.${tail}` : '');
}

function parts(value: string) {
	const normalized = normalizeDecimal(value);
	const negative = normalized.startsWith('-');
	const [whole, fraction = ''] = normalized.replace(/^-/, '').split('.');
	return { negative, whole, fraction };
}

export function compareDecimals(a: string, b: string): -1 | 0 | 1 {
	const left = parts(a);
	const right = parts(b);
	if (left.negative !== right.negative) return left.negative ? -1 : 1;
	let result: number;
	if (left.whole.length !== right.whole.length) result = left.whole.length > right.whole.length ? 1 : -1;
	else if (left.whole !== right.whole) result = left.whole > right.whole ? 1 : -1;
	else {
		const scale = Math.max(left.fraction.length, right.fraction.length);
		const l = left.fraction.padEnd(scale, '0');
		const r = right.fraction.padEnd(scale, '0');
		result = l === r ? 0 : l > r ? 1 : -1;
	}
	return (result === 0 ? 0 : left.negative ? -result : result) as -1 | 0 | 1;
}

function scaled(value: ReturnType<typeof parts>, scale: number): bigint {
	const integer = BigInt(value.whole + value.fraction.padEnd(scale, '0'));
	return value.negative ? -integer : integer;
}

export function addDecimals(a: string, b: string): string {
	const left = parts(a);
	const right = parts(b);
	const scale = Math.max(left.fraction.length, right.fraction.length);
	const sum = scaled(left, scale) + scaled(right, scale);
	const digits = (sum < 0n ? -sum : sum).toString().padStart(scale + 1, '0');
	return normalizeDecimal((sum < 0n ? '-' : '') + (scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits));
}

/** Exact, unrounded product. */
export function multiplyDecimals(a: string, b: string): string {
	const left = parts(a);
	const right = parts(b);
	const scale = left.fraction.length + right.fraction.length;
	const product = scaled(left, left.fraction.length) * scaled(right, right.fraction.length);
	const digits = (product < 0n ? -product : product).toString().padStart(scale + 1, '0');
	return normalizeDecimal((product < 0n ? '-' : '') + (scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits));
}

/** Multiply by a power of ten for an explicit engineering-unit conversion. */
export function shiftDecimal(value: string, power: number): string {
	if (!Number.isInteger(power) || Math.abs(power) > 1000) throw new RangeError('INVALID_DECIMAL_SHIFT');
	const { negative, whole, fraction } = parts(value);
	const digits = whole + fraction;
	const point = whole.length + power;
	const shifted = point <= 0 ? `0.${'0'.repeat(-point)}${digits}`
		: point >= digits.length ? digits + '0'.repeat(point - digits.length)
			: `${digits.slice(0, point)}.${digits.slice(point)}`;
	return normalizeDecimal((negative ? '-' : '') + shifted);
}

/** quantity × unit price rounded once to two decimals, ties away from zero; the
 * database's per-line checkout rule. Indicative only; the database stays authoritative. */
export function lineTotal(quantity: string, unitPrice: string): string {
	const amount = parts(quantity);
	const price = parts(unitPrice);
	const scale = amount.fraction.length + price.fraction.length;
	let product = scaled(amount, amount.fraction.length) * scaled(price, price.fraction.length);
	const negative = product < 0n;
	if (negative) product = -product;
	if (scale > 2) {
		const divisor = 10n ** BigInt(scale - 2);
		product = product / divisor + (product % divisor * 2n >= divisor ? 1n : 0n);
	} else product *= 10n ** BigInt(2 - scale);
	const digits = product.toString().padStart(3, '0');
	return normalizeDecimal(`${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`);
}

/** Normalized positive quantity, on the current sale step and within DB bounds. */
export function validQuantity(input: string, step: string, locale: 'nb' | 'en' = 'en'): string {
	const value = normalizeDecimal(input, locale);
	const amount = parts(value);
	const increment = parts(step);
	if (amount.fraction.length > 6 || compareDecimals(value, '0') <= 0
		|| compareDecimals(value, '999999999999') > 0 || compareDecimals(step, '0') <= 0
		|| increment.fraction.length > 6) throw new RangeError('INVALID_QUANTITY');
	const scale = Math.max(amount.fraction.length, increment.fraction.length);
	if (scaled(amount, scale) % scaled(increment, scale) !== 0n) throw new RangeError('INVALID_QUANTITY');
	return value;
}
