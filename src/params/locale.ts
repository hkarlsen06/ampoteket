// Matches the optional locale segment in `src/routes/[[locale=locale]]`.
// Only prefixed locales match, so `/p` stays Norwegian and `/en/p` is English.
import type { ParamMatcher } from '@sveltejs/kit';
import { isPrefixedLocale } from '$lib/i18n';

export const match = ((param: string) => isPrefixedLocale(param)) satisfies ParamMatcher;
