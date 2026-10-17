/**
 * Timestamps are UTC ISO strings with six fractional digits, so the imported
 * PostgreSQL values (microseconds) and new ones compare correctly as strings.
 * Inside a Convex mutation `Date.now()` is fixed for the whole transaction.
 */
export function isoAt(ms: number): string {
	return new Date(ms).toISOString().replace(/Z$/, '000Z');
}
export function isoNow(): string {
	return isoAt(Date.now());
}

const osloDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit' });
/** The workshop's calendar day (Europe/Oslo) of an instant, as YYYY-MM-DD. */
export function osloDate(ms: number): string {
	return osloDay.format(new Date(ms));
}
/** The UTC instant of 00:00 Europe/Oslo on `date` (YYYY-MM-DD). */
export function osloMidnight(date: string): number {
	const [y, m, d] = date.split('-').map(Number);
	// Oslo is UTC+1 or UTC+2: try both offsets and keep the one that is local midnight.
	for (const offsetHours of [2, 1]) {
		const candidate = Date.UTC(y, m - 1, d) - offsetHours * 3_600_000;
		if (osloDate(candidate) === date && osloDate(candidate - 1) !== date) return candidate;
	}
	throw new Error('OSLO_MIDNIGHT_NOT_FOUND');
}
/** `date` plus `days` calendar days, as YYYY-MM-DD. */
export function addDays(date: string, days: number): string {
	const [y, m, d] = date.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
