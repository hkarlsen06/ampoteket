/**
 * One-time import from Supabase (scripts/convex-import.ts) and the checks that
 * prove nothing was lost. Internal functions: callable only with the
 * deployment's admin key (`convex run`, or the import script). Never part of
 * ordinary operation; see docs/runbook-cutover.md.
 */
import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import type { TableNames } from './_generated/dataModel';
import { addDecimals, compareDecimals } from './lib/decimal';
import { canonicalJson, sha256Hex } from './lib/commands';
import { image } from './lib/audit';

/** Application tables in import order; the order only matters for readability, not references. */
export const APP_TABLES = ['units', 'staff_members', 'help_contacts', 'categories', 'cabinets', 'bins', 'products', 'attribute_definitions',
	'product_attributes', 'command_requests', 'purchase_orders', 'purchase_order_lines', 'purchase_order_cancellations', 'checkouts',
	'checkout_lines', 'checkout_contacts', 'count_batches', 'inventory_events', 'inventory_movements', 'movement_corrections',
	'receipt_allocations', 'sales', 'stock_counts', 'audit_log'] as const;
type AppTable = (typeof APP_TABLES)[number];
const appTable = v.union(...APP_TABLES.map((table) => v.literal(table)));

/** Insert one batch. A table may be filled only while its import is running (`first` refuses a non-empty table). */
export const insertRows = internalMutation({
	args: { table: appTable, rows: v.array(v.any()), first: v.boolean() },
	handler: async (ctx, { table, rows, first }) => {
		if (first && await ctx.db.query(table).first()) throw new Error(`IMPORT_TARGET_NOT_EMPTY: ${table}`);
		for (const row of rows) await ctx.db.insert(table as TableNames, row);
		return rows.length;
	}
});

/**
 * Auth identities with their Supabase bcrypt hashes. `auth_user_id` keeps the
 * Supabase UUID that staff_members.auth_user_id refers to.
 */
export const insertUsers = internalMutation({
	args: { users: v.array(v.object({ auth_user_id: v.string(), email: v.string(), encrypted_password: v.union(v.string(), v.null()), email_confirmed_ms: v.union(v.number(), v.null()) })) },
	handler: async (ctx, { users }) => {
		for (const user of users) {
			const email = user.email.trim().toLowerCase();
			if (await ctx.db.query('users').withIndex('email', (q) => q.eq('email', email)).first()) throw new Error('IMPORT_USER_EXISTS');
			if (user.encrypted_password && !/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(user.encrypted_password)) throw new Error('IMPORT_UNSUPPORTED_PASSWORD_HASH');
			const userId = await ctx.db.insert('users', { email, auth_user_id: user.auth_user_id,
				...(user.email_confirmed_ms === null ? {} : { emailVerificationTime: user.email_confirmed_ms }) });
			await ctx.db.insert('authAccounts', { userId, provider: 'password', providerAccountId: email,
				...(user.encrypted_password ? { secret: user.encrypted_password } : {}) });
		}
		return users.length;
	}
});

/** Continue the movement and audit sequences after the imported IDs. */
export const setSequences = internalMutation({
	args: {},
	handler: async (ctx) => {
		for (const name of ['inventory_movements', 'audit_log'] as const) {
			const last = await ctx.db.query(name).withIndex('seq').order('desc').first();
			const counter = await ctx.db.query('counters').withIndex('name', (q) => q.eq('name', name)).unique();
			const value = last?.id ?? 0;
			if (counter) await ctx.db.patch(counter._id, { value: Math.max(counter.value, value) });
			else await ctx.db.insert('counters', { name, value });
		}
	}
});

/** Recompute the stock projection for these products from the ledger. Safe to rerun. */
export const rebuildStockLevels = internalMutation({
	args: { productIds: v.array(v.string()) },
	handler: async (ctx, { productIds }) => {
		for (const productId of productIds) {
			let quantity = '0', revision = 0, lastCounted: string | null = null;
			for (const m of await ctx.db.query('inventory_movements').withIndex('product', (q) => q.eq('product_id', productId)).collect()) {
				quantity = addDecimals(quantity, m.quantity_delta); revision = Math.max(revision, m.id);
			}
			for (const count of await ctx.db.query('stock_counts').withIndex('product_id', (q) => q.eq('product_id', productId)).collect()) {
				const event = await ctx.db.query('inventory_events').withIndex('uuid', (q) => q.eq('id', count.event_id)).unique();
				if (event && (lastCounted === null || event.recorded_at > lastCounted)) lastCounted = event.recorded_at;
			}
			const level = await ctx.db.query('stock_levels').withIndex('product_id', (q) => q.eq('product_id', productId)).unique();
			const row = { product_id: productId, quantity, revision, last_counted_at: lastCounted };
			if (level) await ctx.db.replace(level._id, row);
			else await ctx.db.insert('stock_levels', row);
		}
	}
});

/** Row count and SHA-256 of one table's rows (canonical JSON, sorted), for comparison with the export. */
export const tableDigest = internalQuery({
	args: { table: appTable },
	handler: async (ctx, { table }) => {
		const rows = (await ctx.db.query(table).collect()).map((doc) => canonicalJson(image(doc))).sort();
		return { table, count: rows.length, digest: await sha256Hex(rows.join('\n')) };
	}
});

/** Products whose projection disagrees with the ledger (must be empty). */
export const verifyStockLevels = internalQuery({
	args: {},
	handler: async (ctx) => {
		const problems: string[] = [];
		for (const product of await ctx.db.query('products').collect()) {
			let quantity = '0', revision = 0;
			for (const m of await ctx.db.query('inventory_movements').withIndex('product', (q) => q.eq('product_id', product.id)).collect()) {
				quantity = addDecimals(quantity, m.quantity_delta); revision = Math.max(revision, m.id);
			}
			const level = await ctx.db.query('stock_levels').withIndex('product_id', (q) => q.eq('product_id', product.id)).unique();
			if ((level ? compareDecimals(level.quantity, quantity) !== 0 || level.revision !== revision : quantity !== '0' || revision !== 0)) problems.push(product.code);
		}
		return problems;
	}
});

/** Stock per product code from the projection, for comparison with the Supabase `inventory` view. */
export const stockByCode = internalQuery({
	args: {},
	handler: async (ctx) => {
		const result: Record<string, { quantity: string; revision: number }> = {};
		for (const product of await ctx.db.query('products').collect()) {
			const level = await ctx.db.query('stock_levels').withIndex('product_id', (q) => q.eq('product_id', product.id)).unique();
			result[product.code] = { quantity: level?.quantity ?? '0', revision: level?.revision ?? 0 };
		}
		return result;
	}
});

/**
 * Rehearsal only: empty every application and Auth table. Refuses unless the
 * deployment has ALLOW_MIGRATION_RESET=true, which production never sets.
 */
export const resetForRehearsal = internalMutation({
	args: { table: v.string() },
	handler: async (ctx, { table }) => {
		if (process.env.ALLOW_MIGRATION_RESET !== 'true') throw new Error('MIGRATION_RESET_FORBIDDEN');
		const rows = await ctx.db.query(table as AppTable).take(4000);
		for (const row of rows) await ctx.db.delete(row._id);
		return rows.length;
	}
});
