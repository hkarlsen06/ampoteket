/**
 * Import a Supabase export (scripts/convex-cutover/export.sh) into an EMPTY
 * Convex deployment, then prove nothing was lost (docs/runbook-cutover.md):
 * every table's row count and SHA-256 digest must equal the export's, the stock
 * projection must equal the ledger, and every product's stock and revision must
 * equal the Supabase `inventory` view.
 *
 *   CONVEX_URL=https://<deployment>.convex.cloud CONVEX_ADMIN_KEY=<deploy key> \
 *     bun scripts/convex-cutover/import.ts ~/ampoteket-exports/<stamp>/export.json
 *
 * Exits non-zero on any mismatch. Only `transform` and `verify` are exported
 * for tests; the module runs only when executed directly.
 */
import { readFileSync } from 'node:fs';
import { isLosslessNumber, parse } from 'lossless-json';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { canonicalJson, sha256Hex } from '../../convex/lib/commands';
import { compareDecimals } from '../../convex/lib/decimal';

type Row = Record<string, unknown>;
export type Export = { exported_at: string; tables: Record<string, Row[]>; users: Row[]; inventory: Row[] };

// Column types that are not plain text/boolean/uuid/null.
const integers = new Set(['outer_row', 'outer_col', 'inner_rows', 'inner_cols', 'inner_row', 'inner_col', 'row_span', 'col_span',
	'display_order', 'edit_revision', 'metadata_revision', 'line_number', 'expected_revision', 'movement_id', 'corrects_movement_id']);
const decimals = new Set(['stock_step', 'sale_step', 'sale_unit_price_nok', 'minimum_stock', 'number_value', 'number_max', 'additional_cost_nok',
	'ordered_quantity', 'unit_cost_nok', 'quantity', 'unit_price_nok', 'quantity_delta', 'expected_quantity', 'counted_quantity']);
const timestamps = new Set(['created_at', 'updated_at', 'placed_at', 'recorded_at', 'started_at', 'finished_at', 'occurred_at']);
const bytea = new Set(['request_digest', 'token_digest']);
const jsonb = new Set(['result', 'row_key', 'before_data', 'after_data']);
/** Tables whose `id` column is a bigint sequence, not a UUID. */
const sequenceIds = new Set(['inventory_movements', 'audit_log']);

/** PostgreSQL timestamptz text → UTC with exactly six fractional digits, so string order is time order. */
export function normalizeTimestamp(value: string): string {
	const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(value);
	if (!match) throw new Error(`Unexpected timestamp format: ${value}`);
	const [, date, time, fraction = '', zone] = match;
	const offset = zone === 'Z' ? '+00:00' : zone.length === 3 ? `${zone}:00` : zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
	const ms = Date.parse(`${date}T${time}${offset}`);
	if (!Number.isFinite(ms)) throw new Error(`Invalid timestamp: ${value}`);
	return `${new Date(ms).toISOString().slice(0, 19)}.${fraction.padEnd(6, '0')}Z`;
}
/** JSON images keep every number as its exact text, so no value is rounded. */
function exactJson(value: unknown): unknown {
	if (isLosslessNumber(value)) return value.toString();
	if (Array.isArray(value)) return value.map(exactJson);
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, exactJson(v)]));
	return value;
}
function integer(value: unknown, column: string): number {
	const number = Number(isLosslessNumber(value) ? value.toString() : value);
	if (!Number.isSafeInteger(number)) throw new Error(`Not a safe integer in ${column}: ${String(value)}`);
	return number;
}

export function transformRow(table: string, row: Row): Row {
	const out: Row = {};
	for (const [column, value] of Object.entries(row)) {
		if (value === null) out[column] = null;
		else if (column === 'id' && sequenceIds.has(table)) out[column] = integer(value, column);
		else if (integers.has(column)) out[column] = integer(value, column);
		else if (decimals.has(column)) out[column] = isLosslessNumber(value) ? value.toString() : String(value);
		else if (timestamps.has(column)) out[column] = normalizeTimestamp(String(value));
		else if (bytea.has(column)) out[column] = String(value).replace(/^\\x/, '');
		else if (jsonb.has(column)) out[column] = exactJson(value);
		else if (isLosslessNumber(value)) throw new Error(`Unmapped numeric column ${table}.${column}`);
		else out[column] = value;
	}
	if (table === 'audit_log') {
		const key = out.row_key as Row;
		out.row_id = typeof key?.id === 'string' ? key.id : null;
	}
	return out;
}

export function transform(data: Export) {
	const tables = Object.fromEntries(Object.entries(data.tables).map(([table, rows]) => [table, rows.map((row) => transformRow(table, row))]));
	const users = data.users.map((u) => ({ auth_user_id: String(u.id), email: String(u.email).trim().toLowerCase(),
		encrypted_password: (u.encrypted_password ?? null) as string | null,
		email_confirmed_ms: u.email_confirmed_at === null ? null : Date.parse(normalizeTimestamp(String(u.email_confirmed_at))) }));
	const inventory = data.inventory.map((i) => ({ code: String(i.code), quantity: (i.quantity as { toString(): string }).toString(), revision: integer(i.revision, 'revision') }));
	return { tables, users, inventory };
}

/** The digest convex/migration.ts `tableDigest` computes over stored rows. */
export async function digest(rows: Row[]): Promise<string> {
	return await sha256Hex(rows.map((row) => canonicalJson(row)).sort().join('\n'));
}

const fn = (name: string) => makeFunctionReference<'mutation' | 'query'>(name) as never;
async function main() {
	const file = process.argv[2], url = process.env.CONVEX_URL, adminKey = process.env.CONVEX_ADMIN_KEY;
	if (!file || !url || !adminKey) throw new Error('Usage: CONVEX_URL=… CONVEX_ADMIN_KEY=… bun scripts/convex-cutover/import.ts <export.json>');
	const data = parse(readFileSync(file, 'utf8')) as Export;
	const { tables, users, inventory } = transform(data);
	const client = new ConvexHttpClient(url, { logger: false });
	(client as unknown as { setAdminAuth(key: string): void }).setAdminAuth(adminKey);
	const call = (kind: 'mutation' | 'query', name: string, args: Record<string, unknown>) =>
		(client[kind] as (f: never, a: Record<string, unknown>) => Promise<unknown>)(fn(name), args);

	console.log(`Export taken ${data.exported_at}`);
	for (const [table, rows] of Object.entries(tables)) {
		for (let start = 0; start < rows.length || start === 0; start += 200) {
			await call('mutation', 'migration:insertRows', { table, rows: rows.slice(start, start + 200), first: start === 0 });
			if (!rows.length) break;
		}
		console.log(`  ${table}: ${rows.length}`);
	}
	await call('mutation', 'migration:insertUsers', { users });
	console.log(`  users: ${users.length} (${users.filter((u) => u.encrypted_password).length} with password)`);
	await call('mutation', 'migration:setSequences', {});
	const productIds = tables.products.map((p) => p.id as string);
	for (let start = 0; start < productIds.length; start += 50) {
		await call('mutation', 'migration:rebuildStockLevels', { productIds: productIds.slice(start, start + 50) });
	}
	const failures = await verify(tables, inventory, (name, args) => call('query', name, args));
	if (failures.length) { console.error(`VERIFICATION FAILED:\n${failures.join('\n')}`); process.exit(1); }
	console.log('Verified: every table, the stock projection and every product balance match the export.');
}

export async function verify(tables: Record<string, Row[]>, inventory: { code: string; quantity: string; revision: number }[],
	query: (name: string, args: Record<string, unknown>) => Promise<unknown>): Promise<string[]> {
	const failures: string[] = [];
	for (const [table, rows] of Object.entries(tables)) {
		const stored = await query('migration:tableDigest', { table }) as { count: number; digest: string };
		const expected = await digest(rows);
		if (stored.count !== rows.length || stored.digest !== expected) failures.push(`${table}: ${stored.count} rows stored, ${rows.length} exported; digest ${stored.digest === expected ? 'matches' : 'differs'}`);
	}
	const drift = await query('migration:verifyStockLevels', {}) as string[];
	if (drift.length) failures.push(`stock projection differs from ledger for ${drift.join(', ')}`);
	const stock = await query('migration:stockByCode', {}) as Record<string, { quantity: string; revision: number }>;
	for (const item of inventory) {
		const level = stock[item.code];
		if (!level || compareDecimals(level.quantity, item.quantity) !== 0 || level.revision !== item.revision) {
			failures.push(`${item.code}: Supabase ${item.quantity} @ ${item.revision}, Convex ${level?.quantity} @ ${level?.revision}`);
		}
	}
	if (Object.keys(stock).length !== inventory.length) failures.push(`${Object.keys(stock).length} products in Convex, ${inventory.length} in the export`);
	return failures;
}

if (import.meta.main) await main();
