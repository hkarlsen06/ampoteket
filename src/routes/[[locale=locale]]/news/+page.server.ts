import { readEventCalendar, readNewsFeed, type FeedCursor } from '#lib/news.js';
import { uuidPattern } from '#lib/api.js';
import { getCatalogConfig } from '#lib/server/catalog-config.js';
import type { PageServerLoad } from './$types';

const DAY = 86_400_000;

export const load: PageServerLoad = async ({ request, fetch, url, setHeaders }) => {
	setHeaders({ 'Cache-Control': 'no-store' });
	// Older pages continue from the last article shown: ?before=<published_at>&id=<id>.
	const before = url.searchParams.get('before'), id = url.searchParams.get('id');
	const cursor: FeedCursor | null = before && id && uuidPattern.test(id) && Number.isFinite(Date.parse(before)) ? { published_at: before, id } : null;
	const config = getCatalogConfig(request);
	if (!config) return { feed: null, upcoming: null, older: Boolean(cursor) };
	const now = new Date();
	const [feed, upcoming] = await Promise.all([
		readNewsFeed(config, cursor, 12, fetch).catch(() => null),
		// The first page leads with what is coming; older pages are only the archive.
		cursor ? Promise.resolve([]) : readEventCalendar(config, now.toISOString(), new Date(now.valueOf() + 180 * DAY).toISOString(), fetch).then(events => events.slice(0, 3)).catch(() => null)
	]);
	return { feed, upcoming, older: Boolean(cursor) };
};
