import { addMonths, monthGrid, monthOf, osloMidnight, parseMonth, readEventCalendar } from '#lib/news.js';
import { getCatalogConfig } from '#lib/server/catalog-config.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ request, fetch, url, setHeaders }) => {
	setHeaders({ 'Cache-Control': 'no-store' });
	const current = monthOf(new Date());
	const month = parseMonth(url.searchParams.get('month')) ?? current;
	// The grid shows whole weeks, so read every day it shows.
	const weeks = monthGrid(month);
	const first = weeks[0][0].day;
	const last = weeks.at(-1)!.at(-1)!.day;
	const config = getCatalogConfig(request);
	if (!config) return { month, current, events: null };
	const end = new Date(`${last}T12:00:00Z`); end.setUTCDate(end.getUTCDate() + 1);
	const events = await readEventCalendar(config, osloMidnight(first), osloMidnight(end.toISOString().slice(0, 10)), fetch).catch(() => null);
	return { month, current, previous: addMonths(month, -1), next: addMonths(month, 1), events };
};
