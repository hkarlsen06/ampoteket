import { normalizeDecimal, shiftDecimal } from './decimal';

/** Plot coordinates only: exact source quantities and money remain decimal strings. */
export function salesPlot(values: string[]): { points: number[]; maximum: string } {
	const normalized = values.map((value) => normalizeDecimal(value));
	const scale = Math.max(0, ...normalized.map((value) => value.split('.')[1]?.length ?? 0));
	const integers = normalized.map((value) => BigInt(shiftDecimal(value, scale)));
	if (integers.some((value) => value < 0n)) throw new RangeError('NEGATIVE_SALES');
	const peak = integers.reduce((maximum, value) => value > maximum ? value : maximum, 0n);
	return {
		points: integers.map((value) => peak === 0n ? 0 : Number(value * 1000n / peak)),
		maximum: normalized[integers.indexOf(peak)] ?? '0'
	};
}
