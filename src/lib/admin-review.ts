import { api, type StaffSession } from './convex';
import { parseAdminProduct, type AdminProduct } from './admin-products';
import type { AuditEntry } from './admin-audit';
import { readDraft, writeDraft } from './drafts';

/**
 * Products other staff added since the viewer last reviewed them (page-admin-stock.md).
 * The review point is per staff user and per browser: there is no column for it,
 * so it lives beside the drafts in `localStorage`.
 */
export type NewProduct = AdminProduct & { created_at: string };
export type ReviewItem = { product: NewProduct; creation: AuditEntry | null };
type ReviewStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Without a stored review point the list starts this far back. */
export const firstReviewDays = 14;
const timestampPattern = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)$/;

/**
 * Microseconds since the epoch. Stored timestamps keep microseconds that `Date` drops,
 * and the review point is a product's exact `created_at`, so compare at full precision.
 */
export function timestampMicros(value: string): bigint {
	const match = timestampPattern.exec(value);
	const millis = match ? Date.parse(`${match[1]}${match[3].length === 3 ? `${match[3]}:00` : match[3]}`) : NaN;
	if (!match || !Number.isFinite(millis)) throw new Error('Invalid timestamp');
	return BigInt(millis) * 1000n + BigInt((match[2] ?? '').padEnd(6, '0').slice(0, 6));
}

export function readReviewPoint(userId: string | null | undefined, storage?: ReviewStorage): string | null {
	const saved = readDraft(userId ?? undefined, 'product-review', storage) as { since?: unknown } | null;
	const since = saved?.since;
	if (typeof since !== 'string') return null;
	try { timestampMicros(since); return since; } catch { return null; }
}

export function writeReviewPoint(userId: string | null | undefined, since: string, storage?: ReviewStorage) {
	timestampMicros(since);
	writeDraft(userId ?? undefined, 'product-review', { since }, storage);
}

/** The stored point, or `firstReviewDays` before `now` on a first visit. */
export function reviewSince(stored: string | null, now = Date.now()): string {
	return stored ?? new Date(now - firstReviewDays * 86_400_000).toISOString();
}

/** Every product, published or not, created after `since`. */
export async function readNewProducts(session: StaffSession, since: string): Promise<NewProduct[]> {
	timestampMicros(since);
	return (await session.client.query(api.products.createdSince, { since })).map((row) => {
		if (typeof row.created_at !== 'string') throw new Error('Invalid product creation time');
		timestampMicros(row.created_at);
		return { ...parseAdminProduct(row), created_at: row.created_at };
	});
}

/**
 * Newest first, after `since`, without the viewer's own products. `creations` null
 * means the audit could not be read: the list is still shown, with creators unknown
 * and the viewer's own products included, rather than hidden.
 */
export function reviewList(products: NewProduct[], creations: AuditEntry[] | null, since: string, viewerStaffId: string | null): ReviewItem[] {
	const point = timestampMicros(since);
	const byProduct = new Map<string, AuditEntry>();
	for (const entry of creations ?? []) {
		const id = entry.key.id;
		if (entry.table === 'products' && entry.action === 'INSERT' && typeof id === 'string') byProduct.set(id, entry);
	}
	return products
		.map(product => ({ product, creation: byProduct.get(product.id) ?? null, at: timestampMicros(product.created_at) }))
		.filter(item => item.at > point && !(viewerStaffId && item.creation?.actorId === viewerStaffId))
		.sort((a, b) => a.at === b.at ? a.product.code.localeCompare(b.product.code) : a.at > b.at ? -1 : 1)
		.map(({ product, creation }) => ({ product, creation }));
}

/**
 * The point that marks `items` reviewed: the newest listed creation time, not the
 * clock, so a product saved after the list was read stays new.
 */
export function reviewedThrough(items: ReviewItem[]): string | null {
	let newest: NewProduct | null = null;
	for (const { product } of items) if (!newest || timestampMicros(product.created_at) > timestampMicros(newest.created_at)) newest = product;
	return newest?.created_at ?? null;
}
