import path from 'node:path';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';
import { plugin as shadcn } from '@shadcn/lint';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,
	ts.configs.recommended,
	svelte.configs.recommended,
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node } },
		rules: {
			'no-undef': 'off',
			// `const { id, ...rest } = row` is how fields are dropped; `_` marks deliberately unused slots.
			'@typescript-eslint/no-unused-vars': ['error', {
				ignoreRestSiblings: true, argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_'
			}]
		}
	},
	{
		// Internal links go through i18n.href(), which adds the locale prefix and is
		// this app's resolver (docs/i18n.md). SvelteKit's resolve() cannot see that, so
		// its rule is replaced by a ban on hard-coded internal paths.
		rules: {
			'svelte/no-navigation-without-resolve': 'off',
			'no-restricted-syntax': ['error', ...[
				"SvelteAttribute[key.name='href'] > SvelteLiteral[value=/^\\/(?!\\/)/]",
				"SvelteAttribute[key.name='href'] > SvelteMustacheTag > Literal[value=/^\\/(?!\\/)/]",
				"SvelteAttribute[key.name='href'] > SvelteMustacheTag > TemplateLiteral > TemplateElement:first-child[value.raw=/^\\/(?!\\/)/]",
				"CallExpression[callee.name=/^(goto|pushState|replaceState)$/] > Literal:first-child[value=/^\\//]",
				"CallExpression[callee.name=/^(goto|pushState|replaceState)$/] > TemplateLiteral:first-child > TemplateElement:first-child[value.raw=/^\\//]"
			].map((selector) => ({ selector, message: 'Wrap internal paths in i18n.href(path) (docs/i18n.md).' }))]
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser
			}
		}
	},
	{
		files: ['**/*.svelte'],
		plugins: { shadcn },
		settings: {
			shadcn: {
				ui: '#lib/components/ui',
				mergeFunctions: ['cn'],
				note: 'Use the shared UI primitives and semantic Tailwind tokens defined in src/app.css.'
			}
		},
		rules: {
			'shadcn/no-arbitrary-values': 'error',
			'shadcn/no-inline-styles': 'error',
			'shadcn/no-raw-colors': 'error',
			'shadcn/no-restyle': ['error', { allow: ['layout'] }],
			'shadcn/no-unknown-classes': 'error',
			'shadcn/require-static-classes': 'error'
		}
	},
	{
		files: ['src/lib/components/ui/**/*.svelte', 'src/lib/ui.ts'],
		rules: {
			'shadcn/no-arbitrary-values': 'off',
			'shadcn/no-inline-styles': 'off',
			'shadcn/no-raw-colors': 'off',
			'shadcn/no-restyle': 'off',
			'shadcn/no-unknown-classes': 'off',
			'shadcn/require-static-classes': 'off'
		}
	},
	{
		files: ['src/lib/Led.svelte', 'src/lib/ShelfDiagram.svelte'],
		rules: {
			'shadcn/no-arbitrary-values': 'off',
			'shadcn/no-unknown-classes': 'off'
		}
	}
);
