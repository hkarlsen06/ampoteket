import { browserConvexConfig } from '#lib/server/convex.js';
import { salesOpen } from '#lib/server/sales.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ request }) => ({ convex: browserConvexConfig(request), salesOpen: salesOpen() });
