import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// Catch-all inside the locale layout: any path that is not a real page (or a
// more specific route such as a future `/p` page or a top-level `/api`
// endpoint, which both outrank this rest route) lands here and becomes a 404.
// Throwing keeps the locale layout — header, nav, language picker, footer —
// so the error page is the same site, not a bare fallback. Rendering happens
// in `../+error.svelte`. The root `src/routes/+error.svelte` only covers
// failures outside this layout.
export const load: PageLoad = () => {
	throw error(404);
};
