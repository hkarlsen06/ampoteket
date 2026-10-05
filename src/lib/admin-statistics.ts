import { identifier, object, text, type Fetcher } from './api';
import { staffRequest, type StaffSession } from './admin-api';
import { normalizeDecimal, shiftDecimal } from './decimal';

export type SalesSummary = { sale_count: string; total_nok: string; quantity: string | null };
export type SalesDay = SalesSummary & { date: string };
type Part = { product_id: string; code: string; name_nb: string; name_en: string; unit_code: string };
export type AdminStatistics = {
	product_id: string | null; start_date: string; end_date: string;
	summary: SalesSummary; days: SalesDay[];
	products: (Part & SalesSummary)[];
	overview: null | {
		attention_count: string; open_count_count: string;
		attention: (Part & { quantity: string; minimum_stock: string })[];
		open_counts: { id: string; title: string; started_at: string }[];
	};
};

/** Exact axis values; only the bounded SVG coordinates become numbers. */
export function salesAxis(values: string[], wholeUnits = true): { points: number[]; maximum: string; ticks: { point: number; value: string }[] } {
	const normalized = values.map(value => normalizeDecimal(value));
	const scale = wholeUnits ? 0 : Math.max(0, ...normalized.map(value => value.split('.')[1]?.length ?? 0));
	const integers = normalized.map(value => BigInt(shiftDecimal(value, scale)));
	if (integers.some(value => value < 0n)) throw new RangeError('NEGATIVE_SALES');
	const peak = integers.reduce((max, value) => value > max ? value : max, 0n);
	const target = (peak + 3n) / 4n || 1n;
	const magnitude = 10n ** BigInt(target.toString().length - 1);
	const step = [1n, 2n, 5n, 10n].map(multiplier => multiplier * magnitude).find(value => value >= target)!;
	const count = Number((peak + step - 1n) / step > 2n ? (peak + step - 1n) / step : 2n);
	const ceiling = BigInt(count) * step;
	return {
		points: integers.map(value => Number(value * 1000n / ceiling)),
		maximum: shiftDecimal(String(peak), -scale),
		ticks: Array.from({ length: count + 1 }, (_, index) => ({ point: Number(BigInt(index) * step * 1000n / ceiling), value: shiftDecimal(String(BigInt(index) * step), -scale) }))
	};
}

function decimal(value: unknown, scale: number, signed = false): string {
	if (typeof value !== 'string' || value.length > 1000
		|| !new RegExp(`^${signed ? '-?' : ''}\\d+${scale ? `(?:\\.\\d{1,${scale}})?` : ''}$`).test(value)) throw new Error('Invalid statistics number');
	return value;
}
function date(value: unknown): string {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
		|| !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error('Invalid statistics date');
	return value;
}
function list(value: unknown, max: number): Record<string, unknown>[] {
	if (!Array.isArray(value) || value.length > max) throw new Error('Invalid statistics list');
	return value.map(object);
}
function summary(value: unknown, scoped: boolean): SalesSummary {
	const row = object(value);
	if (!scoped && row.quantity !== null) throw new Error('Mixed stock units');
	return { sale_count: decimal(row.sale_count, 0), total_nok: decimal(row.total_nok, 2), quantity: scoped ? decimal(row.quantity, 6) : null };
}
function part(row: Record<string, unknown>): Part {
	return { product_id: identifier(row.product_id), code: text(row.code, 40), name_nb: text(row.name_nb, 1000), name_en: text(row.name_en, 1000), unit_code: text(row.unit_code, 24) };
}
export async function readAdminStatistics(session: StaffSession, productId: string | null = null, fetcher: Fetcher = fetch): Promise<AdminStatistics> {
	if (productId !== null) identifier(productId);
	const row = object(await staffRequest(session, 'rpc/amp_admin_statistics', {}, { p_product_id: productId }, 'POST', fetcher));
	if (row.product_id !== productId) throw new Error('Invalid statistics product');
	const start_date = date(row.start_date); const end_date = date(row.end_date);
	const days = list(row.days, 30).map(day => ({ date: date(day.date), ...summary(day, productId !== null) }));
	if (days.length !== 30 || days.at(-1)?.date !== end_date || days.some((day, index) => day.date !== new Date(Date.parse(start_date) + index * 86_400_000).toISOString().slice(0, 10))) throw new Error('Incomplete statistics period');
	const products = list(row.products, 10).map(p => ({ ...part(p), ...summary(p, true) }));
	let overview: AdminStatistics['overview'] = null;
	if (productId === null) {
		const item = object(row.overview);
		overview = {
			attention_count: decimal(item.attention_count, 0), open_count_count: decimal(item.open_count_count, 0),
			attention: list(item.attention, 8).map(p => ({ ...part(p), quantity: decimal(p.quantity, 6, true), minimum_stock: decimal(p.minimum_stock, 6) })),
			open_counts: list(item.open_counts, 5).map(batch => {
				const started_at = text(batch.started_at, 64);
				if (!Number.isFinite(Date.parse(started_at))) throw new Error('Invalid count timestamp');
				return { id: identifier(batch.id), title: text(batch.title, 200), started_at };
			})
		};
	} else if (row.overview !== null || products.length) throw new Error('Invalid product statistics scope');
	return { product_id: productId, start_date, end_date, summary: summary(row.summary, productId !== null), days, products, overview };
}
