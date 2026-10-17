// Localization. No library: two dictionaries, one URL prefix, one context.
// Full explanation and the recipe for adding a string or a language: docs/i18n.md.

import { getContext, setContext } from 'svelte';
import type { Locale, Messages } from './core';

export * from './core';

export type I18n = {
	/** Current locale. Reactive: reading it inside a component tracks navigation. */
	readonly locale: Locale;
	/** Messages for the current locale. */
	readonly m: Messages;
	/** Rewrites an app path into the current locale. Use for every internal link. */
	href(path: string): string;
};

const I18N_KEY = Symbol('ampoteket:i18n');

/** Called once, by the locale layout. */
export function setI18n(i18n: I18n): I18n {
	return setContext(I18N_KEY, i18n);
}

/** Called by any component below that layout. */
export function getI18n(): I18n {
	const i18n = getContext<I18n | undefined>(I18N_KEY);
	if (!i18n) throw new Error('getI18n() was called outside the locale layout');
	return i18n;
}

