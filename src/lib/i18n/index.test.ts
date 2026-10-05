// Unit tests for the pure URL helpers in ./index.ts. Svelte-context helpers
// (setI18n/getI18n) need a component tree and are exercised by the app itself;
// this file covers only what can be tested as plain functions. See docs/i18n.md.

import { describe, expect, test } from 'bun:test';
import { categoryBesideName, localizeCurrentUrl, localizeHref, stripLocale } from './index';

describe('stripLocale', () => {
	test('root path is unchanged', () => {
		expect(stripLocale('/')).toBe('/');
	});

	test('an unprefixed path is unchanged', () => {
		expect(stripLocale('/p/AMP-00123')).toBe('/p/AMP-00123');
	});

	test('strips the /en prefix', () => {
		expect(stripLocale('/en/p')).toBe('/p');
	});

	test('/en alone strips to root', () => {
		expect(stripLocale('/en')).toBe('/');
	});

	test('an unknown locale-looking segment (e.g. /de) is left untouched', () => {
		// /de is not a real locale prefix (see docs/i18n.md §5), so it must be
		// read as an app path, not stripped as if it were a language.
		expect(stripLocale('/de')).toBe('/de');
		expect(stripLocale('/de/p')).toBe('/de/p');
	});

	test('a trailing slash on a prefixed path is dropped', () => {
		expect(stripLocale('/en/p/')).toBe('/p');
	});

	test('a trailing slash on an unprefixed path is left as-is', () => {
		// stripLocale only normalizes trailing slashes on prefixed paths; an
		// unprefixed path is returned unchanged (SvelteKit does not hand this
		// function slash-normalization duties for the default locale).
		expect(stripLocale('/p/')).toBe('/p/');
	});
});

describe('localizeHref', () => {
	test('nb (default locale) gets no prefix', () => {
		expect(localizeHref('/p', 'nb')).toBe('/p');
		expect(localizeHref('/', 'nb')).toBe('/');
		expect(localizeHref('/p/AMP-00123', 'nb')).toBe('/p/AMP-00123');
	});

	test('en gets the /en prefix', () => {
		expect(localizeHref('/p', 'en')).toBe('/en/p');
		expect(localizeHref('/p/AMP-00123', 'en')).toBe('/en/p/AMP-00123');
	});

	test('root path with en becomes /en, not /en/', () => {
		expect(localizeHref('/', 'en')).toBe('/en');
	});

	test('a path without a leading slash is normalized', () => {
		expect(localizeHref('p', 'nb')).toBe('/p');
		expect(localizeHref('p', 'en')).toBe('/en/p');
	});
});

describe('localizeCurrentUrl', () => {
	test('preserves the query string across a language switch', () => {
		// The no-JS code lookup (`GET /p?code=AMP-00123`, docs/page-home.md §2.7)
		// must survive switching languages via the header picker. The path
		// passed in is already the bare (unprefixed) path, exactly like the
		// `bare` derived value the layout computes with stripLocale().
		expect(localizeCurrentUrl('/p', '?code=AMP-00123', 'en')).toBe('/en/p?code=AMP-00123');
		expect(localizeCurrentUrl('/p', '?code=AMP-00123', 'nb')).toBe('/p?code=AMP-00123');
	});

	test('no query string produces the same result as localizeHref', () => {
		expect(localizeCurrentUrl('/p', '', 'en')).toBe(localizeHref('/p', 'en'));
		expect(localizeCurrentUrl('/', '', 'nb')).toBe(localizeHref('/', 'nb'));
	});

	test('root path keeps its query string for both locales', () => {
		expect(localizeCurrentUrl('/', '?ref=qr', 'nb')).toBe('/?ref=qr');
		expect(localizeCurrentUrl('/', '?ref=qr', 'en')).toBe('/en?ref=qr');
	});
});

test('the category label is dropped beside a name that already starts with it', () => {
	expect(categoryBesideName('Capacitors', 'Kondensator · keramisk 4,7 pF', 'nb')).toBeNull();
	expect(categoryBesideName('Capacitors', 'Capacitor · ceramic 4.7 pF', 'en')).toBeNull();
	expect(categoryBesideName('Capacitors', 'Keramisk kondensator 4,7 pF', 'nb')).toBe('Kondensator');
	expect(categoryBesideName('Controllers', 'Arduino Nano', 'en')).toBe('Controller');
	expect(categoryBesideName(null, 'Arduino Nano', 'en')).toBeNull();
});
