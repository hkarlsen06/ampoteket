import { defineParams } from '@sveltejs/kit/params';
// The build imports this file in plain Node, so it needs the real `.ts` path.
import { isPrefixedLocale } from './lib/i18n/locales.ts';

export const params = defineParams({
	// Matches the optional locale segment in `src/routes/[[locale=locale]]`.
	// Only prefixed locales match, so `/p` stays Norwegian and `/en/p` is English.
	locale: (param) => (isPrefixedLocale(param) ? param : undefined)
});
