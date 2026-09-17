/** Resolve operator-entered wall time without silently choosing a DST occurrence. */
export function osloLocal(date: Date): string {
	const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
	const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
	return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

export function possibleOsloOffsets(local: string): string[] {
	if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(local)) return [];
	return ['+01:00', '+02:00'].filter((offset) => {
		const date = new Date(`${local}:00${offset}`);
		return Number.isFinite(date.valueOf()) && osloLocal(date) === local;
	});
}

export function osloInstant(local: string, chosenOffset = ''): string {
	const offsets = possibleOsloOffsets(local);
	if (!offsets.length || (chosenOffset && !offsets.includes(chosenOffset))) throw new Error('INVALID_OSLO_TIME');
	if (offsets.length === 2 && !chosenOffset) throw new Error('AMBIGUOUS_OSLO_TIME');
	return new Date(`${local}:00${chosenOffset || offsets[0]}`).toISOString();
}
