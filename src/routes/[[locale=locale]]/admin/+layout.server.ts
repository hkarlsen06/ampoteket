import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ setHeaders }) => {
	setHeaders({ 'Cache-Control': 'no-store' });
};
