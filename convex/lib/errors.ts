import { ConvexError } from 'convex/values';

/**
 * Raise a domain error. Every rejected command throws, so Convex rolls back the
 * whole mutation, exactly like `RAISE EXCEPTION` did in PostgreSQL. Clients
 * receive `{ code, message }`; `code` is the stable part they branch on and
 * `message` may add a detail after a colon (`PRODUCT_NOT_FOUND: <id>`).
 */
export function fail(code: string, detail?: string): never {
	throw new ConvexError({ code, message: detail === undefined ? code : `${code}: ${detail}` });
}
