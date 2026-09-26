import { lookupCatalogProduct, readCompleteCatalog, type CatalogConfig, type CatalogProduct } from './catalog';
import type { CartLine } from './cart';

export type CartProductFact =
	| { kind: 'ready'; product: CatalogProduct }
	| { kind: 'missing' }
	| { kind: 'unavailable'; product?: CatalogProduct };

/** Hints are lookup aids only: a code must resolve to the saved identity.
 * Old lines without codes use a complete traversal, never a first-page guess. */
export async function readCartProducts(
	config: CatalogConfig | null,
	lines: CartLine[],
	signal?: AbortSignal
): Promise<Record<string, CartProductFact>> {
	const facts: Record<string, CartProductFact> = {};
	if (!config) return Object.fromEntries(lines.map((line) => [line.product_id, { kind: 'unavailable' }]));
	if (lines.some((line) => !line.code)) {
		try {
			const products = new Map((await readCompleteCatalog(config, { signal })).map((product) => [product.product_id, product]));
			for (const line of lines) {
				const product = products.get(line.product_id);
				facts[line.product_id] = product ? { kind: 'ready', product } : { kind: 'missing' };
			}
		} catch {
			for (const line of lines) facts[line.product_id] = { kind: 'unavailable' };
		}
		return facts;
	}
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(4, lines.length) }, async () => {
		while (next < lines.length && !signal?.aborted) {
			const line = lines[next++];
			try {
				const product = await lookupCatalogProduct(config, line.code!, { signal });
				facts[line.product_id] = !product ? { kind: 'missing' }
					: product.product_id === line.product_id ? { kind: 'ready', product } : { kind: 'unavailable' };
			} catch { facts[line.product_id] = { kind: 'unavailable' }; }
		}
	}));
	return facts;
}
