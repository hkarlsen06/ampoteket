import { SALES_OPEN } from '$app/env/private';

/** Buying (catalog, cart, checkout and its API) opens only when SALES_OPEN is exactly "true". */
export function salesOpen(): boolean {
	return SALES_OPEN === 'true';
}
