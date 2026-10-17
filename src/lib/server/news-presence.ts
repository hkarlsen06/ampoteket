import { readNewsFeed } from '#lib/news.js';
import type { ConvexCaller } from '#lib/convex.js';

// The homepage links to /news only while an article is published (docs/page-home.md §1).
// It is the page's one backend read: an isolate asks at most once a minute, and a slow or
// failed answer never holds the page for longer than TIMEOUT; until one arrives the link
// stays hidden. Only the answer is shared between requests, never a pending promise, which
// a Worker cannot await from another request.
const TTL = 60_000, TIMEOUT = 300;
let cached: { value: boolean; at: number } | null = null;

export async function hasPublishedNews(client: ConvexCaller | null, now = Date.now()): Promise<boolean> {
	if (cached && now - cached.at < TTL) return cached.value;
	if (!client) return false;
	const read = readNewsFeed(client, null, 1).then(feed => {
		cached = { value: feed.entries.length > 0, at: now };
		return cached.value;
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(cached?.value ?? false), TIMEOUT); });
	try { return await Promise.race([read, late]); }
	catch { return cached?.value ?? false; }
	finally { clearTimeout(timer); }
}
