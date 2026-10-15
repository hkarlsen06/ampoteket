import { readEventCalendar, readNewsFeed, type FeedCursor } from '#lib/news.js';
import { uuidPattern } from '#lib/api.js';
import { serverConvex } from '#lib/server/convex.js';
import type { PageServerLoad } from './$types';

const DAY = 86_400_000;

export const load: PageServerLoad = async ({ url, setHeaders }) => {
	setHeaders({ 'Cache-Control': 'no-store' });
	// Older pages continue from the last article shown: ?before=<published_at>&id=<id>.
	const before = url.searchParams.get('before'), id = url.searchParams.get('id');
	const cursor: FeedCursor | null = before && id && uuidPattern.test(id) && Number.isFinite(Date.parse(before)) ? { published_at: before, id } : null;
	const client = serverConvex();
	if (!client) return { feed: null, upcoming: null, older: Boolean(cursor) };
	const now = new Date();
	const [feed, upcoming] = await Promise.all([
		readNewsFeed(client, cursor, 12).catch(() => null),
		// The first page leads with what is coming; older pages are only the archive.
		cursor ? Promise.resolve([]) : readEventCalendar(client, now.toISOString(), new Date(now.valueOf() + 180 * DAY).toISOString()).then(events => events.slice(0, 3)).catch(() => null)
	]);
	return { feed, upcoming, older: Boolean(cursor) };
};
