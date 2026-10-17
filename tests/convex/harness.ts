/**
 * Shared setup for the backend tests in tests/convex/, run by
 * scripts/test-convex.sh against a disposable local backend. Tests talk to the
 * real deployment through the native ConvexHttpClient, exactly as the app does.
 */
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { ConvexError } from 'convex/values';
import { api } from '../../convex/_generated/api';

export const url = process.env.TEST_CONVEX_URL ?? '';
const adminKey = process.env.TEST_CONVEX_ADMIN_KEY ?? '';
export const serverKey = process.env.TEST_CHECKOUT_SERVER_KEY ?? '';
export const emailPort = Number(process.env.TEST_EMAIL_PORT ?? 0);
/** Skip (rather than fail) when run outside scripts/test-convex.sh, e.g. by a plain `bun test`. */
export const enabled = Boolean(url && adminKey);

export function guest(): ConvexHttpClient {
	return new ConvexHttpClient(url, { logger: false });
}

const admin = () => {
	const client = new ConvexHttpClient(url, { logger: false });
	(client as unknown as { setAdminAuth(key: string): void }).setAdminAuth(adminKey);
	return client;
};
/** Call an internal function by name ("seed:base"), as `convex run` does. */
export async function internal<T = unknown>(kind: 'query' | 'mutation', name: string, args: Record<string, unknown> = {}): Promise<T> {
	const client = admin();
	const call = client[kind] as (fn: never, args: Record<string, unknown>) => Promise<T>;
	return await call.call(client, makeFunctionReference(name) as never, args);
}

const tables = ['units', 'staff_members', 'help_contacts', 'categories', 'cabinets', 'bins', 'products', 'attribute_definitions',
	'product_attributes', 'command_requests', 'purchase_orders', 'purchase_order_lines', 'purchase_order_cancellations', 'checkouts',
	'checkout_lines', 'checkout_contacts', 'count_batches', 'inventory_events', 'inventory_movements', 'movement_corrections',
	'receipt_allocations', 'sales', 'stock_counts', 'audit_log', 'stock_levels', 'counters', 'password_tokens', 'rate_limits',
	'users', 'authAccounts', 'authSessions', 'authRefreshTokens', 'authVerificationCodes', 'authVerifiers', 'authRateLimits'];

/** Empty every table, then add units and the workshop wall. */
export async function freshDeployment() {
	for (const table of tables) {
		while (await internal<number>('mutation', 'migration:resetForRehearsal', { table }) > 0) { /* until empty */ }
	}
	await internal('mutation', 'seed:base');
}

let staffNumber = 0;
/** A signed-in staff member (or a deactivated one with `active: false`). */
export async function staff(displayName = 'Test staff', active = true) {
	const email = `staff${++staffNumber}-${Date.now()}@example.no`, password = 'correct horse battery';
	const ids = await internal<{ staffId: string; authUserId: string }>('mutation', 'seed:staff', { email, password, displayName, active });
	const client = await signedIn(email, password);
	return { client, email, password, ...ids };
}
export async function signedIn(email: string, password: string): Promise<ConvexHttpClient> {
	const tokens = await guest().action(api.session.signIn, { email, password });
	const client = new ConvexHttpClient(url, { logger: false });
	client.setAuth(tokens.token);
	return client;
}

/** The domain code a call rejected with; fails the test if it resolved or failed otherwise. */
export async function rejected(promise: Promise<unknown>): Promise<string> {
	try { await promise; } catch (error) {
		if (error instanceof ConvexError && typeof error.data?.code === 'string') return error.data.code;
		throw error;
	}
	throw new Error('Expected a rejection');
}

export const uuid = () => crypto.randomUUID();

/** A product in the first drawer, with a sale price unless `borrowOnly`. */
export async function product(client: ConvexHttpClient, overrides: Record<string, unknown> = {}) {
	const id = uuid();
	const code = `TST-${id.slice(0, 5).toUpperCase()}`;
	return await client.mutation(api.products.save, { revision: null, payload: {
		id, code, name_nb: `Testdel ${code}`, name_en: `Test part ${code}`, description: null, category_id: null,
		bin_id: 'a0000002-0000-4000-8000-000000000001', location_note: null, unit_code: 'pcs', stock_step: '1', sale_step: '1',
		sale_unit_price_nok: '2.5', minimum_stock: '0', datasheet_url: null, purchase_url: null, is_active: true, ...overrides
	} });
}
