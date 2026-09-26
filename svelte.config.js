import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// Cloudflare Workers deployment (docs/prosjektoversikt.md §3). Config in wrangler.jsonc.
		adapter: adapter(),
		csp: { directives: { 'frame-ancestors': ['none'] } }
	},
	compilerOptions: {
		// Runes mode for our own code; libraries in node_modules decide for themselves.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	}
};

export default config;
