// Localization. No library: two dictionaries, one URL prefix, one context.
// Full explanation and the recipe for adding a string or a language: docs/i18n.md.

import { getContext, setContext } from 'svelte';
import { en } from './en';
import { nb, type Messages } from './nb';
import { standardSpecifications } from '../product-specifications';

/** Every language the site is published in. The first one is the default. */
export const locales = ['nb', 'en'] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = locales[0];

/**
 * The production origin, used for `canonical` and `hreflang` links so preview
 * deployments (`*.workers.dev`) never emit their own origin and create
 * duplicate-content URLs.
 */
export const PROD_ORIGIN = 'https://ampoteket.no';

const dictionaries: Record<Locale, Messages> = { nb, en };

/** `<html lang>` and `hreflang` value for a locale. */
export const htmlLang: Record<Locale, string> = { nb: 'nb', en: 'en' };

/** `og:locale` value for a locale. Open Graph wants language_TERRITORY. */
export const ogLocale: Record<Locale, string> = { nb: 'nb_NO', en: 'en_US' };

/** The social card served as `og:image`, 1200 x 630 (docs/design-system.md §6). */
export const SOCIAL_CARD = '/photos/social-card.jpg';

/** Permanent invite to the Ampoteket Discord server (never expires, no use limit). */
export const DISCORD_INVITE = 'https://discord.gg/X7xp3vgfyH';

export const INSTAGRAM = 'https://www.instagram.com/ampoteket';

export function isLocale(value: string | undefined | null): value is Locale {
	return typeof value === 'string' && (locales as readonly string[]).includes(value);
}

/** True for the locales that live behind a URL prefix, i.e. everything but the default. */
export function isPrefixedLocale(value: string | undefined | null): value is Locale {
	return isLocale(value) && value !== defaultLocale;
}

export function messagesFor(locale: Locale): Messages {
	return dictionaries[locale];
}

/** Translate known categories for display without changing their stored/filter values. */
export function categoryLabel(name: string, locale: Locale): string {
	const labels = messagesFor(locale).categories;
	const key = name.trim().toLowerCase();
	return Object.hasOwn(labels, key) ? labels[key as keyof typeof labels] : name;
}

/** The category label shown beside a product name; null when the name already starts with it. */
export function categoryBesideName(category: string | null | undefined, name: string, locale: Locale): string | null {
	if (!category) return null;
	const label = categoryLabel(category, locale);
	return name.toLocaleLowerCase(locale).startsWith(label.toLocaleLowerCase(locale)) ? null : label;
}

/** Translate the fixed fields only when their saved type and unit agree. */
export function specificationLabel(code: string, definition: { label: string; value_type: string; unit?: string | null; canonical_unit?: string | null }, locale: Locale): string {
	const standard = standardSpecifications.find(field => field.code === code);
	const unit = definition.canonical_unit !== undefined ? definition.canonical_unit : definition.unit ?? null;
	return standard && standard.value_type === definition.value_type && standard.canonical_unit === unit
		? messagesFor(locale).specificationLabels[standard.code] : definition.label;
}

/**
 * The default locale is served without a prefix (`/p/AMP-00123`), every other
 * locale behind its code (`/en/p/AMP-00123`). Printed QR labels point at the
 * unprefixed URLs, so those must keep working forever.
 */
export function localizeHref(path: string, locale: Locale): string {
	const clean = path.startsWith('/') ? path : `/${path}`;
	if (locale === defaultLocale) return clean;
	return clean === '/' ? `/${locale}` : `/${locale}${clean}`;
}

/** The path without its locale prefix: `/en/p` → `/p`, `/en` → `/`. */
export function stripLocale(pathname: string): string {
	const [, first, ...rest] = pathname.split('/');
	if (!isPrefixedLocale(first)) return pathname;
	return `/${rest.join('/')}`.replace(/\/$/, '') || '/';
}

/**
 * Localizes a path for a given locale, preserving the query string. Used for
 * the language picker, so a no-JS lookup
 * like `/p?code=AMP-00123` survives a language switch. `search` is
 * `URL#search` (including its leading `?`, or `''`); the hash is deliberately
 * not handled here since it is not available server-side.
 */
export function localizeCurrentUrl(path: string, search: string, locale: Locale): string {
	return localizeHref(path, locale) + search;
}

/** Which locale a request path is in. Used by hooks.server.ts before routing. */
export function localeFromPathname(pathname: string): Locale {
	const first = pathname.split('/')[1];
	return isPrefixedLocale(first) ? first : defaultLocale;
}

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

export type { Messages };
