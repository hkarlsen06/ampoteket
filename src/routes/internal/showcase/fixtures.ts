// Sample data for the meeting showcase, shaped exactly like the API's so the real
// components render it. Values follow the workshop seed (scripts/seed-workshop-data.ts).
import type { CatalogProduct } from '$lib/catalog';
import type { CartLine } from '$lib/cart';
import type { ShelfBin, ShelfCabinet } from '$lib/shelf-map';

const placed = (cabinet_code: string, outer_row: number, outer_col: number, inner_row: number, inner_col: number) => ({
	cabinet_code, outer_row, outer_col, inner_rows: 12, inner_cols: 4, bin_code: `${cabinet_code}-${inner_row}-${inner_col}`,
	bin_label: null, inner_row, inner_col, row_span: 1, col_span: 1, location_note: null
});
let ids = 0;
function product(code: string, name: string, category: string, price: string, quantity: string, place: ReturnType<typeof placed>): CatalogProduct {
	return { product_id: `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`, code, name_nb: name, name_en: name,
		description: null, category_name: category, unit_code: 'pcs', unit_symbol: 'stk', sale_step: '1', sale_unit_price_nok: price,
		quantity, last_counted_at: '2026-09-30T16:00:00Z', datasheet_url: null, attributes: {}, ...place };
}

export const resistor = product('RES-00005', '1 kΩ motstand', 'Motstander', '0.50', '84', placed('A1', 1, 1, 2, 1));
export const capacitor = product('CAP-00045', '100 nF kondensator', 'Kondensatorer', '1.00', '85', placed('C1', 1, 3, 2, 4));
export const led = product('LED-00007', 'Rød LED', 'Lysdioder', '1.50', '61', placed('D1', 1, 4, 4, 1));
export const search = [
	product('RES-00001', '1 Ω motstand', 'Motstander', '0.50', '305', placed('A1', 1, 1, 1, 1)),
	product('RES-00003', '100 Ω motstand', 'Motstander', '0.50', '120', placed('A1', 1, 1, 1, 3)),
	resistor,
	product('RES-00007', '10 kΩ motstand', 'Motstander', '0.50', '96', placed('A1', 1, 1, 2, 3))
];

export const cartLines: CartLine[] = [
	{ product_id: resistor.product_id, quantity: '10', code: resistor.code, name_nb: resistor.name_nb, unit_symbol: 'stk' },
	{ product_id: capacitor.product_id, quantity: '2', code: capacitor.code, name_nb: capacitor.name_nb, unit_symbol: 'stk' },
	{ product_id: led.product_id, quantity: '5', code: led.code, name_nb: led.name_nb, unit_symbol: 'stk' }
];
export const cartProducts = [resistor, capacitor, led];
export const cartTotal = '14.50';

// September 2026, one bar per day.
const counts = [2, 0, 3, 5, 1, 0, 0, 4, 2, 6, 3, 1, 0, 0, 5, 3, 2, 4, 6, 0, 0, 3, 2, 5, 1, 4, 0, 0, 6, 3];
export const salesDays = counts.map((count, index) => ({
	date: `2026-09-${String(index + 1).padStart(2, '0')}`, sale_count: String(count), total_nok: (count * 6.5).toFixed(2), quantity: null
}));
export const salesCount = counts.reduce((sum, count) => sum + count, 0);
export const salesValue = (salesCount * 6.5).toFixed(2);

export const stockHistory = [
	{ kind: 'Registrert kjøp', change: '−10', balance: '74', when: '1. okt. 2026, 10:14', by: 'Kjøper', tone: 'neutral' },
	{ kind: 'Registrert kjøp', change: '−2', balance: '84', when: '29. sep. 2026, 14:02', by: 'Kjøper', tone: 'neutral' },
	{ kind: 'Telling', change: '±0', balance: '86', when: '27. sep. 2026, 18:40', by: 'Ingrid', tone: 'success' },
	{ kind: 'Mottak', change: '+50', balance: '86', when: '20. sep. 2026, 12:05', by: 'Jonas', tone: 'success' },
	{ kind: 'Korrigering', change: '−4', balance: '36', when: '18. sep. 2026, 09:31', by: 'Sara', tone: 'warning' }
] as const;

// One A4 sheet of cabinet A1's drawer labels.
export const sheet = ['1 Ω', '2,2 Ω', '10 Ω', '22 Ω', '47 Ω', '100 Ω', '220 Ω', '330 Ω', '470 Ω', '1 kΩ', '2,2 kΩ', '4,7 kΩ',
	'10 kΩ', '22 kΩ', '47 kΩ', '100 kΩ', '220 kΩ', '470 kΩ', '1 MΩ', '10 MΩ'].map((value, index) => ({
	id: `sheet-${index}`, code: `RES-${(index + 1).toString(16).toUpperCase().padStart(5, '0')}`, lines: [`${value} motstand`]
}));

// The wall from the initial migration (docs/datamodell.md): rows count from the bottom.
const sizes: Record<string, [number, number]> = { A2: [8, 3], E1: [8, 3], F1: [8, 3], C2: [10, 4] };
export const cabinets: ShelfCabinet[] = ['A', 'B', 'C', 'D', 'E', 'F'].flatMap((letter, index) => [1, 2].map((row) => {
	const code = `${letter}${row}`, [inner_rows, inner_cols] = sizes[code] ?? [12, 4];
	return { id: code, code, outer_row: row, outer_col: index + 1, inner_rows, inner_cols, label: null };
}));
export const bins: (ShelfBin & { has_products: boolean })[] = cabinets.flatMap((cabinet) => {
	const list: (ShelfBin & { has_products: boolean })[] = [];
	for (let row = 1; row <= cabinet.inner_rows; row++) for (let col = 1; col <= cabinet.inner_cols; col++) {
		// C2: a full-width drawer at A1–D1 and a two-column drawer at C2–D2.
		if (cabinet.code === 'C2' && ((row === 1 && col > 1) || (row === 2 && col === 4))) continue;
		const col_span = cabinet.code === 'C2' && row === 1 ? 4 : cabinet.code === 'C2' && row === 2 && col === 3 ? 2 : 1;
		list.push({ id: `${cabinet.code}:${row}:${col}`, code: `${cabinet.code}:${row}:${col}`, cabinet_id: cabinet.id, inner_row: row, inner_col: col,
			row_span: 1, col_span, label: null, has_products: (row * 7 + col * 3) % 11 !== 0 });
	}
	return list;
});
