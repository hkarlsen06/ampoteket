/**
 * Guest checkout (docs/checkout-recovery.md, datamodell.md §7).
 *
 * `prepare`, `get` and `confirm` are called only by the Worker gateway, which
 * proves itself with CHECKOUT_SERVER_KEY (a Convex environment variable and a
 * Worker secret). Buyers never call Convex directly. The database stores only
 * the SHA-256 of the per-attempt checkout token.
 *
 * Registration is never payment verification: confirming writes the sale and
 * its movements without checking stock, price changes or payment.
 */
import { v } from 'convex/values';
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import { recordAudit } from './lib/audit';
import { beginCommand, sha256Hex } from './lib/commands';
import { compareDecimals, multiplyDecimals, roundDecimal, sumDecimals } from './lib/decimal';
import { fail } from './lib/errors';
import { byUuid, isUuid, newUuid } from './lib/ids';
import { insertEvent, insertMovement, requireProduct, validateQuantity } from './lib/inventory';
import { requireStaff } from './lib/staff';
import { isoNow } from './lib/time';

function requireServer(serverKey: string) {
	const expected = process.env.CHECKOUT_SERVER_KEY;
	if (!expected || expected.length < 32 || serverKey.length !== expected.length) fail('CHECKOUT_SERVER_REQUIRED');
	let difference = 0;
	for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ serverKey.charCodeAt(i);
	if (difference !== 0) fail('CHECKOUT_SERVER_REQUIRED');
}
const tokenPattern = /^[0-9a-f]{64}$/;

async function authorisedCheckout(ctx: QueryCtx, checkoutId: string, token: string) {
	const checkout = tokenPattern.test(token) ? await byUuid(ctx, 'checkouts', checkoutId) : null;
	if (!checkout || checkout.token_digest !== await sha256Hex(token)) fail('CHECKOUT_NOT_FOUND_OR_NOT_AUTHORISED');
	return checkout;
}

const lineTotal = (quantity: string, price: string) => roundDecimal(multiplyDecimals(quantity, price), 2);

/** The buyer-facing snapshot (amp_get_checkout). Names and prices are the frozen ones. */
async function snapshot(ctx: QueryCtx, checkoutId: string) {
	const checkout = (await byUuid(ctx, 'checkouts', checkoutId))!;
	const lines = await ctx.db.query('checkout_lines').withIndex('checkout_product', (q) => q.eq('checkout_id', checkout.id)).collect();
	const sale = await ctx.db.query('sales').withIndex('checkout_id', (q) => q.eq('checkout_id', checkout.id)).unique();
	const event = sale ? await byUuid(ctx, 'inventory_events', sale.event_id) : null;
	const contact = await ctx.db.query('checkout_contacts').withIndex('checkout_id', (q) => q.eq('checkout_id', checkout.id)).unique();
	const items = [];
	for (const line of lines) {
		const product = (await byUuid(ctx, 'products', line.product_id))!;
		items.push({ product_id: line.product_id, code: product.code, name_nb: line.product_name_nb_snapshot, name_en: line.product_name_en_snapshot,
			unit: product.unit_code, quantity: line.quantity, unit_price_nok: line.unit_price_nok, line_total_nok: lineTotal(line.quantity, line.unit_price_nok) });
	}
	items.sort((a, b) => a.code.localeCompare(b.code));
	const total = roundDecimal(sumDecimals(items.map((i) => i.line_total_nok)), 2);
	return {
		checkout_id: checkout.id, created_at: checkout.created_at, status: sale ? 'confirmed' as const : 'unconfirmed' as const,
		confirmed_at: event?.recorded_at ?? null, total_nok: total, payment_required: compareDecimals(total, '0') > 0,
		registration_method: !sale ? null : sale.recovered_by === null ? 'buyer' as const : 'staff_recovery' as const,
		contact_text: contact?.contact_text ?? null, items
	};
}

export const prepare = mutation({
	args: { serverKey: v.string(), requestId: v.string(), token: v.string(), contact: v.union(v.string(), v.null()),
		items: v.array(v.object({ productId: v.string(), quantity: v.string() })) },
	handler: async (ctx, args) => {
		requireServer(args.serverKey);
		if (!tokenPattern.test(args.token)) fail('INVALID_CHECKOUT_TOKEN');
		const digest = await sha256Hex(args.token);
		const command = await beginCommand<{ checkout_id: string }>(ctx, args.requestId, 'prepare_checkout', null,
			{ token_digest: digest, items: args.items, contact: args.contact });
		if (command.done) return command.result;
		if (args.items.length < 1 || args.items.length > 200) fail('INVALID_ITEM_COUNT');
		if (new Set(args.items.map((i) => i.productId)).size !== args.items.length) fail('DUPLICATE_OR_MISSING_CART_PRODUCT');
		const checkout = { id: newUuid(), request_id: args.requestId, token_digest: digest, created_at: isoNow() };
		await ctx.db.insert('checkouts', checkout);
		for (const item of args.items) {
			const product = await requireProduct(ctx, item.productId);
			if (!product.is_active || product.sale_unit_price_nok === null) fail('PRODUCT_NOT_FOR_SALE');
			const quantity = validateQuantity(product, item.quantity, { sale: true });
			if (compareDecimals(quantity, '0') <= 0) fail('POSITIVE_CART_QUANTITY_REQUIRED');
			await ctx.db.insert('checkout_lines', { checkout_id: checkout.id, product_id: product.id, product_name_nb_snapshot: product.name_nb,
				product_name_en_snapshot: product.name_en, quantity, unit_price_nok: product.sale_unit_price_nok });
		}
		const contact = args.contact?.trim();
		if (contact) {
			if ([...contact].length > 300) fail('CONTACT_TOO_LONG');
			await ctx.db.insert('checkout_contacts', { checkout_id: checkout.id, contact_text: contact });
		}
		return await command.finish({ checkout_id: checkout.id });
	}
});

export const get = query({
	args: { serverKey: v.string(), checkoutId: v.string(), token: v.string() },
	handler: async (ctx, args) => {
		requireServer(args.serverKey);
		const checkout = await authorisedCheckout(ctx, args.checkoutId, args.token);
		return await snapshot(ctx, checkout.id);
	}
});

/** Write the sale once; a repeat returns the existing registration (app.post_checkout). */
async function postCheckout(ctx: MutationCtx, checkoutId: string, recoveredBy: string | null, reason: string | null): Promise<string> {
	const checkout = (await byUuid(ctx, 'checkouts', checkoutId)) ?? fail('CHECKOUT_NOT_FOUND_OR_NOT_AUTHORISED');
	const existing = await ctx.db.query('sales').withIndex('checkout_id', (q) => q.eq('checkout_id', checkout.id)).unique();
	if (existing) return existing.event_id;
	const event = await insertEvent(ctx, { request_id: null, kind: 'sale', actor_id: null });
	const lines = (await ctx.db.query('checkout_lines').withIndex('checkout_product', (q) => q.eq('checkout_id', checkout.id)).collect())
		.sort((a, b) => a.product_id.localeCompare(b.product_id));
	for (const line of lines) await insertMovement(ctx, event, (await byUuid(ctx, 'products', line.product_id))!, `-${line.quantity}`);
	await ctx.db.insert('sales', { checkout_id: checkout.id, event_id: event.id, recovered_by: recoveredBy, recovery_reason: reason });
	return event.id;
}

export const confirm = mutation({
	args: { serverKey: v.string(), checkoutId: v.string(), token: v.string() },
	handler: async (ctx, args) => {
		requireServer(args.serverKey);
		const checkout = await authorisedCheckout(ctx, args.checkoutId, args.token);
		await postCheckout(ctx, checkout.id, null, null);
		return await snapshot(ctx, checkout.id);
	}
});

// ---------- Staff ----------

/** Register the original frozen checkout on the buyer's behalf; converges with a guest retry. */
export const recover = mutation({
	args: { requestId: v.string(), checkoutId: v.string(), reason: v.string() },
	handler: async (ctx, args) => {
		const { actor } = await requireStaff(ctx);
		const command = await beginCommand<{ checkout_id: string; event_id: string; status: 'confirmed' }>(ctx, args.requestId, 'recover_checkout', actor.staffId,
			{ checkout: args.checkoutId, reason: args.reason });
		if (command.done) return command.result;
		const reason = args.reason.trim();
		if (!reason || [...reason].length > 2000) fail('RECOVERY_REASON_REQUIRED');
		const eventId = await postCheckout(ctx, args.checkoutId, actor.staffId, reason);
		return await command.finish({ checkout_id: args.checkoutId, event_id: eventId, status: 'confirmed' });
	}
});

/** Remove the optional contact; repeat-safe. The value never enters the audit. */
export const clearContact = mutation({
	args: { checkoutId: v.string() },
	handler: async (ctx, args) => {
		const { actor } = await requireStaff(ctx);
		const contact = isUuid(args.checkoutId)
			? await ctx.db.query('checkout_contacts').withIndex('checkout_id', (q) => q.eq('checkout_id', args.checkoutId)).unique() : null;
		if (contact) {
			await ctx.db.delete(contact._id);
			await recordAudit(ctx, actor, { table: 'checkout_contacts', key: { checkout_id: args.checkoutId }, action: 'CONTACT_CLEARED', before: null, after: null });
		}
		return { checkout_id: args.checkoutId, contact_removed: contact !== null };
	}
});

/** A checkout by its ID or its prepare request ID (staff find attempts whose response was lost). */
export const staffLookup = query({
	args: { reference: v.string() },
	handler: async (ctx, args) => {
		await requireStaff(ctx);
		if (!isUuid(args.reference)) fail('INVALID_CHECKOUT_REFERENCE');
		const checkout = (await byUuid(ctx, 'checkouts', args.reference))
			?? await ctx.db.query('checkouts').withIndex('request_id', (q) => q.eq('request_id', args.reference)).unique();
		if (!checkout) return null;
		const view = await snapshot(ctx, checkout.id);
		const sale = await ctx.db.query('sales').withIndex('checkout_id', (q) => q.eq('checkout_id', checkout.id)).unique();
		return { id: checkout.id, requestId: checkout.request_id, createdAt: checkout.created_at, total: view.total_nok, registered: sale !== null,
			eventId: sale?.event_id ?? null, registeredAt: view.confirmed_at,
			items: view.items.map((i) => ({ productId: i.product_id, name_nb: i.name_nb, name_en: i.name_en, code: i.code, unit: i.unit, quantity: i.quantity, unitPrice: i.unit_price_nok })) };
	}
});

/** The optional, unverified contact, read only when staff choose to show it. */
export const staffContact = query({
	args: { checkoutId: v.string() },
	handler: async (ctx, args) => {
		await requireStaff(ctx);
		const contact = isUuid(args.checkoutId)
			? await ctx.db.query('checkout_contacts').withIndex('checkout_id', (q) => q.eq('checkout_id', args.checkoutId)).unique() : null;
		return contact?.contact_text ?? null;
	}
});
