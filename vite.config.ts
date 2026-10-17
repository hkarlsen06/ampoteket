import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export const PORT = 5174;
// Set by `bun run development`: the local Convex backend is served at /convex on the
// site's own origin, so any device that can open the dev server also reaches it.
const convexProxy = process.env.CONVEX_DEV_PROXY;

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			// Cloudflare Workers deployment (docs/prosjektoversikt.md §3). Config in wrangler.jsonc.
			adapter: adapter(),
			preprocess: vitePreprocess(),
			csp: { directives: { 'frame-ancestors': ['none'] } },
			compilerOptions: {
				// Runes mode for our own code; libraries in node_modules decide for themselves.
				runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
			}
		})
	],
	// Imported only from the lazily started scanner worker, so the dev server would otherwise
	// discover it late, re-optimize, and answer the worker's import with a 504.
	// Icons are deep-imported one file each; pre-bundling them makes every first visit to a
	// route with a new icon re-optimize and 504 ("Outdated Optimize Dep"). Serve them as source.
	optimizeDeps: { include: ['barcode-detector/ponyfill'], exclude: ['phosphor-svelte'] },
	server: {
		port: PORT,
		strictPort: true,
		host: true,
		allowedHosts: ['dev.ampoteket.no'],
		proxy: convexProxy ? { '/convex': { target: convexProxy, ws: true, rewrite: (path) => path.replace(/^\/convex/, '') } } : undefined
	},
	preview: {
		port: PORT,
		strictPort: true,
		host: true
	}
});
