import { env } from '$env/dynamic/private';

/** Buying (catalog, cart, checkout and its API) opens only when SALES_OPEN is exactly "true". */
export function salesOpen(platform?: App.Platform): boolean {
	const bindings = platform?.env as unknown as Record<string, unknown> | undefined;
	return (bindings?.SALES_OPEN ?? env.SALES_OPEN) === 'true';
}
