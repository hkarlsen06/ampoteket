// No imports: src/params.ts loads this file in plain Node during the build.

/** Every language the site is published in. The first one is the default. */
export const locales = ['nb', 'en'] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = locales[0];

export function isLocale(value: string | undefined | null): value is Locale {
	return typeof value === 'string' && (locales as readonly string[]).includes(value);
}

/** True for the locales that live behind a URL prefix, i.e. everything but the default. */
export function isPrefixedLocale(value: string | undefined | null): value is Locale {
	return isLocale(value) && value !== defaultLocale;
}
