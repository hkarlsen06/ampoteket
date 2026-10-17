/**
 * Base data for a fresh development or test deployment (production gets its
 * data from the Supabase import instead). Internal: run with
 * `bunx convex run seed:base` and `bunx convex run seed:staff '{...}'`.
 */
import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { hashPassword } from './auth';
import { insertAudited, SYSTEM } from './lib/audit';
import { byUuid, newUuid } from './lib/ids';
import { insertEvent, insertMovement, markCounted, stockLevel } from './lib/inventory';
import { isoNow } from './lib/time';

const hex = (value: number, width = 12) => value.toString(16).padStart(width, '0');

/**
 * Units and the workshop wall from the initial migration (`Bok.xlsx`): 12
 * cabinets in two rows of six, 492 drawers, the same deterministic IDs. C2 has
 * a full-width drawer at A1–D1 and a two-column drawer at C2–D2. No products,
 * staff or stock. Refuses a deployment that already has cabinets.
 */
export const base = internalMutation({
	args: {},
	handler: async (ctx) => {
		if (await ctx.db.query('cabinets').first()) throw new Error('SEED_TARGET_NOT_EMPTY');
		for (const unit of [{ code: 'pcs', name: 'Piece', symbol: 'stk', is_discrete: true }, { code: 'm', name: 'Metre', symbol: 'm', is_discrete: false },
			{ code: 'g', name: 'Gram', symbol: 'g', is_discrete: false }]) {
			if (!await ctx.db.query('units').withIndex('code', (q) => q.eq('code', unit.code)).unique()) await ctx.db.insert('units', unit);
		}
		const layout = [[1, 1, 12, 4], [1, 2, 12, 4], [1, 3, 12, 4], [1, 4, 12, 4], [1, 5, 8, 3], [1, 6, 8, 3],
			[2, 1, 8, 3], [2, 2, 12, 4], [2, 3, 10, 4], [2, 4, 12, 4], [2, 5, 12, 4], [2, 6, 12, 4]];
		let drawers = 0;
		for (const [outer_row, outer_col, inner_rows, inner_cols] of layout) {
			const index = outer_col + 6 * (outer_row - 1);
			const id = `a0000001-0000-4000-8000-${hex(index)}`;
			await ctx.db.insert('cabinets', { id, code: `C-${id}`, outer_row, outer_col, inner_rows, inner_cols, label: null, is_archived: false });
			const c2 = outer_row === 2 && outer_col === 3;
			for (let r = 1; r <= inner_rows; r++) for (let c = 1; c <= inner_cols; c++) {
				if (c2 && ((r === 1 && c > 1) || (r === 2 && c === 4))) continue;
				const binId = `a0000002-0000-4000-8000-${hex((index - 1) * 1000 + (r - 1) * 10 + c)}`;
				const col_span = c2 && r === 1 && c === 1 ? 4 : c2 && r === 2 && c === 3 ? 2 : 1;
				await ctx.db.insert('bins', { id: binId, code: `B-${binId}`, cabinet_id: id, inner_row: r, inner_col: c, row_span: 1, col_span, label: null, is_archived: false });
				drawers++;
			}
		}
		return { cabinets: layout.length, drawers };
	}
});

/** A staff member who can sign in with this password (development and tests only). */
export const staff = internalMutation({
	args: { email: v.string(), password: v.string(), displayName: v.string(), active: v.optional(v.boolean()) },
	handler: async (ctx, args) => {
		const email = args.email.trim().toLowerCase();
		const authUserId = newUuid();
		const userId = await ctx.db.insert('users', { email, auth_user_id: authUserId, emailVerificationTime: Date.now() });
		await ctx.db.insert('authAccounts', { userId, provider: 'password', providerAccountId: email, secret: hashPassword(args.password) });
		const member = await insertAudited(ctx, SYSTEM, 'staff_members', { id: newUuid(), auth_user_id: authUserId, display_name: args.displayName,
			is_active: args.active ?? true, created_at: isoNow() });
		return { staffId: member.id, authUserId };
	}
});

const demoAttribute = v.object({ definitionId: v.string(), code: v.string(), label: v.string(),
	valueType: v.union(v.literal('number'), v.literal('text'), v.literal('boolean')), unit: v.union(v.string(), v.null()), value: v.union(v.string(), v.boolean()) });
const demoProduct = v.object({
	id: v.string(), code: v.string(), name_nb: v.string(), name_en: v.string(), description: v.string(), categoryId: v.string(), categoryName: v.string(),
	binId: v.string(), unit: v.string(), stockStep: v.string(), saleStep: v.string(), price: v.string(), stock: v.union(v.string(), v.null()),
	openingRequestId: v.string(), attributes: v.array(demoAttribute)
});

/**
 * Synthetic demo products for development and browser proofs
 * (scripts/seed-test-data.ts). Idempotent by ID: existing products, their
 * specifications and later stock are never overwritten. Opening stock goes
 * through the ledger as the seed fixture member. Refused unless
 * ALLOW_TEST_FIXTURES=true, so it can never run in production.
 */
export const demo = internalMutation({
	args: { staff: v.object({ id: v.string(), authUserId: v.string() }), products: v.array(demoProduct) },
	handler: async (ctx, { staff, products }) => {
		if (process.env.ALLOW_TEST_FIXTURES !== 'true') throw new Error('TEST_FIXTURES_FORBIDDEN');
		if (!await byUuid(ctx, 'staff_members', staff.id)) {
			await insertAudited(ctx, SYSTEM, 'staff_members', { id: staff.id, auth_user_id: staff.authUserId, display_name: 'Synthetic seed fixture (no login)', is_active: true, created_at: isoNow() });
		}
		const actor = { staffId: staff.id, role: 'authenticated' as const };
		if (products.some((p) => p.unit === 'g') && !await ctx.db.query('units').withIndex('code', (q) => q.eq('code', 'g')).unique()) {
			await ctx.db.insert('units', { code: 'g', name: 'Gram', symbol: 'g', is_discrete: false });
		}
		let added = 0;
		for (const p of products) {
			if (!await byUuid(ctx, 'categories', p.categoryId)) await insertAudited(ctx, actor, 'categories', { id: p.categoryId, name: p.categoryName });
			for (const a of p.attributes) {
				if (!await byUuid(ctx, 'attribute_definitions', a.definitionId)) {
					await insertAudited(ctx, actor, 'attribute_definitions', { id: a.definitionId, code: a.code, label: a.label, value_type: a.valueType, canonical_unit: a.unit });
				}
			}
			if (await byUuid(ctx, 'products', p.id)) continue;
			const now = isoNow();
			const product = await insertAudited(ctx, actor, 'products', { id: p.id, code: p.code, name_nb: p.name_nb, name_en: p.name_en, description: p.description,
				category_id: p.categoryId, bin_id: p.binId, location_note: null, unit_code: p.unit, stock_step: p.stockStep, sale_step: p.saleStep,
				sale_unit_price_nok: p.price, minimum_stock: '0', datasheet_url: null, purchase_url: null, is_active: true, metadata_revision: 1, created_at: now, updated_at: now });
			for (const a of p.attributes) {
				await insertAudited(ctx, actor, 'product_attributes', { product_id: p.id, attribute_id: a.definitionId, number_max: null,
					number_value: a.valueType === 'number' ? String(a.value) : null, text_value: a.valueType === 'text' ? String(a.value) : null,
					boolean_value: a.valueType === 'boolean' ? Boolean(a.value) : null });
			}
			if (p.stock === '0') {
				// An empty drawer is a count, so the product shows as counted rather than never seen.
				const batch = await insertAudited(ctx, actor, 'count_batches', { id: newUuid(), request_id: p.openingRequestId, owner_id: staff.id, title: p.code,
					started_at: now, finished_at: now, finished_by: staff.id, finish_reason: null, product_id: p.id });
				const event = await insertEvent(ctx, { request_id: p.openingRequestId, kind: 'count', actor_id: staff.id, note: 'Synthetic opening count: empty drawer' });
				const level = await stockLevel(ctx, p.id);
				await ctx.db.insert('stock_counts', { event_id: event.id, batch_id: batch.id, product_id: p.id, expected_quantity: level.quantity, counted_quantity: '0', expected_revision: level.revision });
				await markCounted(ctx, p.id, event.recorded_at);
			} else if (p.stock !== null) {
				const event = await insertEvent(ctx, { request_id: p.openingRequestId, kind: 'adjustment', actor_id: staff.id, note: 'Synthetic opening balance for disposable tests' });
				await insertMovement(ctx, event, product, p.stock);
			}
			added++;
		}
		return added;
	}
});
