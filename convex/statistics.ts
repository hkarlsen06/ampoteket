/**
 * Staff sales statistics (api-contract.md "Staff statistics"). Registrations,
 * never verified payment or net revenue: dated by the sale event, valued from
 * the frozen checkout lines with per-line rounding. One query, one snapshot.
 */
import { v } from 'convex/values';
import { query } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { addDecimals, compareDecimals, compareRatios, multiplyDecimals, roundDecimal } from './lib/decimal';
import { fail } from './lib/errors';
import { byUuid } from './lib/ids';
import { stockLevel } from './lib/inventory';
import { requireStaff } from './lib/staff';
import { addDays, isoAt, osloDate, osloMidnight } from './lib/time';

type Part = { product_id: string; code: string; name_nb: string; name_en: string; unit_code: string };
const part = (p: Doc<'products'>): Part => ({ product_id: p.id, code: p.code, name_nb: p.name_nb, name_en: p.name_en, unit_code: p.unit_code });

export const read = query({
	args: { productId: v.union(v.string(), v.null()) },
	handler: async (ctx, { productId }) => {
		await requireStaff(ctx);
		if (productId !== null && !await byUuid(ctx, 'products', productId)) fail('PRODUCT_NOT_FOUND');
		const end = osloDate(Date.now()), start = addDays(end, -29);
		const from = isoAt(osloMidnight(start)), until = isoAt(osloMidnight(addDays(end, 1)));
		const events = await ctx.db.query('inventory_events').withIndex('recorded_at', (q) => q.gte('recorded_at', from).lt('recorded_at', until)).collect();
		const lines: { checkout: string; product: string; quantity: string; total: string; day: string }[] = [];
		for (const event of events) {
			if (event.kind !== 'sale') continue;
			const sale = await ctx.db.query('sales').withIndex('event_id', (q) => q.eq('event_id', event.id)).unique();
			if (!sale) continue;
			const day = osloDate(Date.parse(event.recorded_at));
			for (const line of await ctx.db.query('checkout_lines').withIndex('checkout_product', (q) => q.eq('checkout_id', sale.checkout_id)).collect()) {
				if (productId !== null && line.product_id !== productId) continue;
				lines.push({ checkout: sale.checkout_id, product: line.product_id, quantity: line.quantity, day,
					total: roundDecimal(multiplyDecimals(line.quantity, line.unit_price_nok), 2) });
			}
		}
		const summarize = (rows: typeof lines) => ({
			sale_count: String(new Set(rows.map((r) => r.checkout)).size),
			total_nok: roundDecimal(rows.reduce((sum, r) => addDecimals(sum, r.total), '0'), 2),
			quantity: productId === null ? null : rows.reduce((sum, r) => addDecimals(sum, r.quantity), '0')
		});
		const days = Array.from({ length: 30 }, (_, n) => {
			const date = addDays(start, n);
			return { date, ...summarize(lines.filter((r) => r.day === date)) };
		});
		if (productId !== null) return { product_id: productId, start_date: start, end_date: end, summary: summarize(lines), days, products: [], overview: null };

		const byProduct = new Map<string, typeof lines>();
		for (const line of lines) byProduct.set(line.product, [...(byProduct.get(line.product) ?? []), line]);
		const products = [];
		for (const [id, rows] of byProduct) {
			const product = (await byUuid(ctx, 'products', id))!;
			products.push({ ...part(product), sale_count: String(rows.length), quantity: rows.reduce((s, r) => addDecimals(s, r.quantity), '0'),
				total_nok: roundDecimal(rows.reduce((s, r) => addDecimals(s, r.total), '0'), 2) });
		}
		products.sort((a, b) => compareDecimals(b.total_nok, a.total_nok) || a.code.localeCompare(b.code));

		// Active products sold out (negative first), then below minimum by lowest share of it. Units never compare directly.
		const attention = [];
		for (const product of await ctx.db.query('products').withIndex('is_active_code', (q) => q.eq('is_active', true)).collect()) {
			const { quantity } = await stockLevel(ctx, product.id);
			if (compareDecimals(quantity, '0') <= 0 || compareDecimals(quantity, product.minimum_stock) < 0) attention.push({ product, quantity });
		}
		attention.sort((a, b) => {
			const rank = (q: string) => compareDecimals(q, '0') < 0 ? 0 : compareDecimals(q, '0') === 0 ? 1 : 2;
			return rank(a.quantity) - rank(b.quantity)
				|| (rank(a.quantity) === 2 ? compareRatios(a.quantity, a.product.minimum_stock, b.quantity, b.product.minimum_stock) : 0)
				|| a.product.code.localeCompare(b.product.code);
		});
		const open = (await ctx.db.query('count_batches').withIndex('finished_at', (q) => q.eq('finished_at', null)).collect())
			.sort((a, b) => a.started_at.localeCompare(b.started_at) || a.id.localeCompare(b.id));
		return {
			product_id: null, start_date: start, end_date: end, summary: summarize(lines), days, products: products.slice(0, 10),
			overview: {
				attention_count: String(attention.length), open_count_count: String(open.length),
				attention: attention.slice(0, 8).map(({ product, quantity }) => ({ ...part(product), quantity, minimum_stock: product.minimum_stock })),
				open_counts: open.slice(0, 5).map((b) => ({ id: b.id, title: b.title, started_at: b.started_at }))
			}
		};
	}
});
