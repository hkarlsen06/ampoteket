/**
 * The app's one way to reach the backend: the native Convex clients with the
 * generated, typed `api`. Browser code uses the shared `ConvexClient`
 * (convex-svelte, src/routes/[[locale=locale]]/+layout.svelte); server code
 * (SSR loads, the checkout gateway) uses `ConvexHttpClient` from
 * src/lib/server/convex.ts. Modules take a `ConvexCaller`, which both clients
 * satisfy and tests replace with a stub.
 *
 * Quantities, money, revisions and movement IDs are exact decimal strings in
 * both directions; only structural integers (coordinates, line numbers) are numbers.
 */
import { ConvexError } from 'convex/values';
import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server';
export { api } from '#convex/_generated/api.js';

export interface ConvexCaller {
	query<Q extends FunctionReference<'query'>>(query: Q, args: FunctionArgs<Q>): Promise<FunctionReturnType<Q>>;
	mutation<M extends FunctionReference<'mutation'>>(mutation: M, args: FunctionArgs<M>): Promise<FunctionReturnType<M>>;
	action<A extends FunctionReference<'action'>>(action: A, args: FunctionArgs<A>): Promise<FunctionReturnType<A>>;
}

/** Signed-in staff: the client carrying their Convex Auth token, and their stable Auth UUID. */
export type StaffSession = { client: ConvexCaller; userId: string };

/** Public configuration only: the deployment URL. */
export type ConvexConfig = { url: string };

/**
 * The stable code of a rejected command (`STALE_STOCK_COUNT`), or null when the
 * failure is not a domain rejection (network, timeout, server bug). Only a code
 * proves the transaction rolled back; null means the outcome is unknown.
 */
export function errorCode(error: unknown): string | null {
	if (!(error instanceof ConvexError)) return null;
	const data: unknown = error.data;
	if (data && typeof data === 'object' && 'code' in data && typeof data.code === 'string') return data.code;
	return null;
}

/** The rejection's message, which may carry a detail after the code (`PRODUCT_NOT_FOUND: <id>`). */
export function errorMessage(error: unknown): string | null {
	if (!(error instanceof ConvexError)) return null;
	const data: unknown = error.data;
	return data && typeof data === 'object' && 'message' in data && typeof data.message === 'string' ? data.message : errorCode(error);
}

/** A domain rejection with a test-friendly constructor; the same class Convex functions throw. */
export function rejection(code: string, message = code): ConvexError<{ code: string; message: string }> {
	return new ConvexError({ code, message });
}
