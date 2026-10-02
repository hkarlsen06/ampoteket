import { defaultLocale, isLocale, type Locale } from '#lib/i18n/index.js';
import type { LayoutLoad } from './$types';

// `locale` is undefined on the unprefixed (Norwegian) routes.
export const load: LayoutLoad = ({ params, data }) => {
	const locale: Locale = isLocale(params.locale) ? params.locale : defaultLocale;
	return { ...data, locale };
};
