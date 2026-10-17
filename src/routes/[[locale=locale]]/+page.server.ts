import { serverConvex } from '#lib/server/convex.js';
import { hasPublishedNews } from '#lib/server/news-presence.js';
import type { PageServerLoad } from './$types';

// The page stays cacheable; the only read is whether to link to /news (news-presence.ts).
export const load: PageServerLoad = async () => ({ hasNews: await hasPublishedNews(serverConvex()) });
