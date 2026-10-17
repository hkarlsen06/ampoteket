/**
 * Catalog and specification types shared by the app and the Convex backend
 * (convex/catalog.ts). Types only: no Svelte, no I/O.
 */
export type AttributeDefinition = { id: string; code: string; label: string; value_type: 'number' | 'text' | 'boolean'; canonical_unit: string | null };

/** A number may be a range: `value` is then its lower bound and `max` the upper one. */
export type CatalogAttribute =
	| { label: string; unit: string | null; value_type: 'number'; value: string; max: string | null }
	| { label: string; unit: null; value_type: 'text'; value: string }
	| { label: string; unit: null; value_type: 'boolean'; value: boolean };

export type CatalogProduct = {
	product_id: string;
	code: string;
	/** Product names are published in both UI languages; pick with productName(). */
	name_nb: string;
	name_en: string;
	description: string | null;
	category_name: string | null;
	unit_code: string;
	unit_symbol: string;
	sale_step: string;
	/** Null: borrow-only, never sold. */
	sale_unit_price_nok: string | null;
	quantity: string;
	last_counted_at: string | null;
	datasheet_url: string | null;
	attributes: Record<string, CatalogAttribute>;
	/** Attribute codes that tell this product from look-alikes (same category and
	 * primary value), in display order; empty when nothing looks like it. */
	distinguishing: string[];
} & (CatalogPlacement | CatalogOffShelf);
/** A live drawer on the wall. Narrow with `product.bin_code !== null`. */
export type CatalogPlacement = {
	cabinet_code: string;
	outer_row: number;
	outer_col: number;
	inner_rows: number;
	inner_cols: number;
	bin_code: string;
	bin_label: string | null;
	inner_row: number;
	inner_col: number;
	row_span: number;
	col_span: number;
	location_note: null;
};
/** Stock kept outside the drawer wall, with an optional staff-written hint. */
export type CatalogOffShelf = { [K in Exclude<keyof CatalogPlacement, 'location_note'>]: null } & { location_note: string | null };
