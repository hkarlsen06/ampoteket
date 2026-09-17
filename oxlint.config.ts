import { defineConfig } from 'oxlint';

export default defineConfig({
	ignorePatterns: ['**/node_modules/**', '.svelte-kit/**', 'build/**', 'dist/**', 'test-results/**', 'scripts/**', 'supabase/**'],
	plugins: [],
	categories: { correctness: 'off' },
	jsPlugins: [{ name: 'shadcn', specifier: '@shadcn/lint' }],
	rules: {
		'shadcn/no-arbitrary-values': 'error',
		'shadcn/no-raw-colors': 'error',
		'shadcn/no-restyle': ['error', { allow: ['layout'] }],
		'shadcn/no-unknown-classes': 'error',
		'shadcn/require-static-classes': 'error'
	},
	overrides: [
		{
			files: ['src/lib/components/ui/**/*.svelte', 'src/lib/ui.ts', 'src/lib/Led.svelte', 'src/lib/ShelfDiagram.svelte'],
			rules: {
				'shadcn/no-arbitrary-values': 'off',
				'shadcn/no-raw-colors': 'off',
				'shadcn/no-restyle': 'off',
				'shadcn/no-unknown-classes': 'off',
				'shadcn/require-static-classes': 'off'
			}
		}
	]
});
