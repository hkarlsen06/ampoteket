import { error } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

// Every buyer route sits in this group, so one check closes deep links and printed QR labels too.
export const load: LayoutServerLoad = async ({ parent }) => {
	if (!(await parent()).salesOpen) error(503, 'SALES_CLOSED');
};
