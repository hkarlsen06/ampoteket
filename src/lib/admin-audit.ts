import { object, identifier, text, uuidPattern, type Fetcher } from './api';
import { allStaffRows, staffRequest, type StaffSession } from './admin-api';
import { categoryLabel, messagesFor, specificationLabel, type Locale } from './i18n';
import { formatCountedAt, formatDecimal, formatMeasurement, formatMoney, gridCell, gridRange, unitLabel } from './format';
import { productName } from './catalog';

export type AuditEntry = {
	id: string; table: string; key: Record<string, unknown>; action: 'INSERT' | 'UPDATE' | 'DELETE' | 'CONTACT_CLEARED';
	before: Record<string, unknown> | null; after: Record<string, unknown> | null;
	actorId: string | null; role: string; recordedAt: string;
};

const pageSize = 30;
function auditId(value: unknown): string {
	if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || BigInt(value) > 9223372036854775807n) throw new Error('Invalid audit ID');
	return value;
}
function timestamp(value: unknown): string {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Invalid audit timestamp');
	return value;
}
function parseEntry(value: unknown): AuditEntry {
	const row = object(value);
	if (!['INSERT', 'UPDATE', 'DELETE', 'CONTACT_CLEARED'].includes(String(row.action))) throw new Error('Invalid audit action');
	return { id: auditId(row.id), table: text(row.table_name, 100), key: object(row.row_key),
		action: row.action as AuditEntry['action'], before: row.before_data === null ? null : object(row.before_data),
		after: row.after_data === null ? null : object(row.after_data), actorId: row.actor_id === null ? null : identifier(row.actor_id),
		role: text(row.database_role, 100), recordedAt: timestamp(row.recorded_at) };
}

/** Fill a page even when PostgREST or a proxy caps individual responses. */
export async function readAuditPage(session: StaffSession, after: string | null = null, fetcher: Fetcher = fetch): Promise<{ entries: AuditEntry[]; more: boolean }> {
	if (after !== null) auditId(after);
	const entries: AuditEntry[] = [];
	let cursor = after;
	for (;;) {
		const rows = await staffRequest(session, 'amp_audit_log', {
			select: 'id,table_name,row_key,action,before_data,after_data,actor_id,database_role,recorded_at',
			order: 'id.desc', limit: String(pageSize + 1 - entries.length), ...(cursor ? { id: `lt.${cursor}` } : {})
		}, undefined, 'POST', fetcher);
		if (!Array.isArray(rows) || rows.length > pageSize + 1 - entries.length) throw new Error('Invalid audit page');
		if (!rows.length) return { entries, more: false };
		for (const value of rows) {
			const entry = parseEntry(value);
			if (cursor !== null && BigInt(entry.id) >= BigInt(cursor)) throw new Error('Invalid audit cursor');
			entries.push(entry); cursor = entry.id;
		}
		if (entries.length === pageSize + 1) return { entries: entries.slice(0, pageSize), more: true };
	}
}

/** Read all entries added since the visible head without replacing older loaded pages. */
export async function readAuditUpdates(session: StaffSession, newestId: string, fetcher: Fetcher = fetch): Promise<AuditEntry[]> {
	const newest = BigInt(auditId(newestId));
	const updates: AuditEntry[] = [];
	let cursor: string | null = null;
	for (;;) {
		const page = await readAuditPage(session, cursor, fetcher);
		updates.push(...page.entries.filter(entry => BigInt(entry.id) > newest));
		if (!page.more || page.entries.some(entry => BigInt(entry.id) <= newest)) return updates;
		cursor = page.entries.at(-1)!.id;
	}
}

type AuditRow = Record<string, unknown>;
export type AuditReferences = Record<string, Record<string, AuditRow>>;
export type AuditDescription = { subject: string; actor: string; fields: { label: string; before: string | null; after: string | null }[] };

const referenceTables: Record<string, string> = { product_id: 'products', attribute_id: 'attribute_definitions', category_id: 'categories', bin_id: 'bins', cabinet_id: 'cabinets', order_id: 'purchase_orders', owner_id: 'staff_members', created_by: 'staff_members', finished_by: 'staff_members' };
const referenceColumns: Record<string, string> = {
	products: 'id,code,name_nb,name_en,unit_code', attribute_definitions: 'id,code,label,value_type,canonical_unit', categories: 'id,name',
	bins: 'id,label,inner_row,inner_col,row_span,col_span,cabinet_id', cabinets: 'id,label,outer_row,outer_col',
	purchase_orders: 'id,supplier_name,supplier_reference', staff_members: 'id,display_name'
};

/** Fetch only the names needed by this page, never exposing unresolved foreign keys. */
export async function readAuditReferences(session: StaffSession, entries: AuditEntry[], fetcher: Fetcher = fetch): Promise<AuditReferences> {
	const wanted: Record<string, Set<string>> = {};
	function want(table: string, id: unknown) {
		if (typeof id === 'string' && uuidPattern.test(id)) (wanted[table] ??= new Set()).add(id);
	}
	for (const entry of entries) {
		want('staff_members', entry.actorId);
		for (const row of [entry.before, entry.after]) if (row) {
			for (const [field, table] of Object.entries(referenceTables)) want(table, row[field]);
		}
	}
	const references: AuditReferences = {};
	await Promise.all(Object.entries(wanted).map(async ([table, ids]) => {
		const rows = await allStaffRows(session, `amp_${table}`, referenceColumns[table], 'id', { id: `in.(${[...ids].join(',')})` }, fetcher);
		references[table] = Object.fromEntries(rows.map(row => [identifier(row.id), row]));
	}));
	// An archived drawer has lost its coordinates; its former place comes from the archive projection.
	const archivedBins = Object.entries(references.bins ?? {}).filter(([, row]) => coordinate(row.inner_row) === undefined).map(([id]) => id);
	if (archivedBins.length) {
		const rows = await allStaffRows(session, 'amp_archived_bin_locations', 'bin_id,cabinet_id,cabinet_label,cabinet_outer_row,cabinet_outer_col,inner_row,inner_col,row_span,col_span', 'bin_id', { bin_id: `in.(${archivedBins.join(',')})` }, fetcher);
		for (const row of rows) {
			const id = identifier(row.bin_id); const cabinet = identifier(row.cabinet_id);
			// The cabinet's position at archive time stays with the drawer; `references.cabinets` holds current rows only.
			references.bins![id] = { ...references.bins![id], cabinet_id: cabinet, inner_row: row.inner_row, inner_col: row.inner_col, row_span: row.row_span, col_span: row.col_span,
				archived_cabinet: { label: row.cabinet_label, outer_row: row.cabinet_outer_row, outer_col: row.cabinet_outer_col } };
		}
	}
	const cabinetIds = [...new Set(Object.values(references.bins ?? {}).map(row => row.cabinet_id).filter((id): id is string => typeof id === 'string' && uuidPattern.test(id) && !references.cabinets?.[id]))];
	if (cabinetIds.length) {
		const rows = await allStaffRows(session, 'amp_cabinets', referenceColumns.cabinets, 'id', { id: `in.(${cabinetIds.join(',')})` }, fetcher);
		references.cabinets = { ...references.cabinets, ...Object.fromEntries(rows.map(row => [identifier(row.id), row])) };
	}
	return references;
}

const uuidInText = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const numericFields = new Set(['stock_step', 'sale_step', 'minimum_stock', 'ordered_quantity', 'number_value', 'display_order', 'outer_row', 'outer_col', 'inner_row', 'inner_col', 'inner_rows', 'inner_cols', 'row_span', 'col_span']);
const readable = (value: unknown): string | undefined => typeof value === 'string' && value.trim() && !uuidInText.test(value) ? value : undefined;
const coordinate = (value: unknown): number | undefined => typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;

/** Presentation whitelist: internal IDs, revisions and unrecognized columns never reach staff. */
export function describeAudit(entry: AuditEntry, locale: Locale, references: AuditReferences = {}): AuditDescription {
	const m = messagesFor(locale).adminAudit;
	const before = entry.before ?? {}; const after = entry.after ?? {};
	const row = { ...before, ...after };
	function reference(table: string, id: unknown): AuditRow | undefined { return typeof id === 'string' ? references[table]?.[id] : undefined; }
	function subject(table: string, data: AuditRow): string | undefined {
		if (table === 'products') {
			const name = readable(data.name_nb) && readable(data.name_en) ? productName(data as { name_nb: string; name_en: string }, locale) : readable(data[`name_${locale}`]);
			return [readable(data.code), name].filter(Boolean).join(' · ') || undefined;
		}
		if (table === 'categories') { const name = readable(data.name); return name && categoryLabel(name, locale); }
		if (table === 'purchase_orders') return [readable(data.supplier_name), readable(data.supplier_reference)].filter(Boolean).join(' · ') || undefined;
		if (table === 'attribute_definitions') {
			const label = readable(data.label); const code = typeof data.code === 'string' ? data.code : '';
			return label && specificationLabel(code, { label, value_type: String(data.value_type), canonical_unit: typeof data.canonical_unit === 'string' ? data.canonical_unit : null }, locale);
		}
		if (table === 'cabinets') {
			const r = coordinate(data.outer_row); const c = coordinate(data.outer_col);
			return readable(data.label) ?? (r && c ? gridCell(r, c) : undefined);
		}
		if (table === 'bins') {
			const r = coordinate(data.inner_row); const c = coordinate(data.inner_col);
			const archived = data.archived_cabinet; const cabinet = archived && typeof archived === 'object' ? archived as AuditRow : reference('cabinets', data.cabinet_id);
			return readable(data.label) ?? ([cabinet && subject('cabinets', cabinet), r && c ? gridRange(r, c, coordinate(data.row_span) ?? 1, coordinate(data.col_span) ?? 1) : undefined].filter(Boolean).join(' / ') || undefined);
		}
		if (table === 'purchase_order_lines' || table === 'product_attributes') {
			const product = reference('products', data.product_id);
			const definition = reference('attribute_definitions', data.attribute_id);
			const order = reference('purchase_orders', data.order_id);
			return [product && subject('products', product), definition && subject('attribute_definitions', definition), order && subject('purchase_orders', order)].filter(Boolean).join(' · ') || undefined;
		}
		if (table === 'units') return typeof data.code === 'string' ? unitLabel(data.code, locale) : readable(data.name);
		return readable(data.display_name) ?? readable(data.title) ?? readable(data.name);
	}
	function value(field: string, data: AuditRow): string | undefined {
		const raw = data[field];
		if (raw == null) return m.none;
		if (referenceTables[field]) { const found = reference(referenceTables[field], raw); return (found && subject(referenceTables[field], found)) || m.unresolved; }
		if (typeof raw === 'boolean') {
			if (field === 'is_active') return entry.table === 'products' ? raw ? m.published : m.unpublished : raw ? m.active : m.inactive;
			if (field === 'is_published') return raw ? m.published : m.unpublished;
			if (field === 'is_archived') return raw ? m.archived : m.inUse;
			return raw ? m.yes : m.no;
		}
		if (field.endsWith('_at')) return typeof raw === 'string' && Number.isFinite(Date.parse(raw)) ? formatCountedAt(raw, locale) : undefined;
		if (field === 'value_type') return (m.valueTypes as Record<string, string>)[String(raw)];
		if (field === 'unit_code') return typeof raw === 'string' ? unitLabel(raw, locale) : undefined;
		if (field === 'name' && entry.table === 'categories') return readable(raw) && categoryLabel(String(raw), locale);
		if ((numericFields.has(field) || field.endsWith('_nok')) && typeof raw === 'string' && /^-?\d+(?:\.\d+)?$/.test(raw)) {
			if (field.endsWith('_nok')) return formatMoney(raw, locale);
			const product = entry.table === 'products' ? data : reference('products', data.product_id);
			const unit = product && typeof product.unit_code === 'string' ? unitLabel(product.unit_code, locale, raw) : undefined;
			if (['stock_step', 'sale_step', 'minimum_stock', 'ordered_quantity'].includes(field)) return `${formatDecimal(raw, locale)}${unit ? ` ${unit}` : ''}`;
			const definition = reference('attribute_definitions', data.attribute_id);
			if (field === 'number_value' && typeof definition?.canonical_unit === 'string') return formatMeasurement(raw, definition.canonical_unit, locale);
			return formatDecimal(raw, locale);
		}
		if (typeof raw === 'number' && Number.isSafeInteger(raw)) return formatDecimal(String(raw), locale);
		return readable(raw);
	}
	const fields: AuditDescription['fields'] = [];
	for (const [field, label] of Object.entries(m.fields)) {
		if (field === 'code' && entry.table !== 'products') continue;
		if (!(field in before || field in after) || JSON.stringify(before[field]) === JSON.stringify(after[field])) continue;
		// A created or deleted row lists only the fields it actually had.
		if ((!entry.before && after[field] == null) || (!entry.after && before[field] == null)) continue;
		const old = entry.before ? value(field, before) : null;
		const now = entry.after ? value(field, after) : null;
		if (old === undefined || now === undefined || old === now) continue;
		fields.push({ label: field === 'is_active' && entry.table === 'products' ? m.fields.is_published : label, before: old, after: now });
	}
	const type = (m.tables as Record<string, string>)[entry.table] ?? m.unknownSubject;
	const name = subject(entry.table, row) ?? subject(entry.table, before);
	const staffName = entry.actorId ? readable(reference('staff_members', entry.actorId)?.display_name) : undefined;
	return {
		subject: name ? `${type}: ${name}` : type,
		actor: staffName ?? (entry.actorId || entry.role === 'authenticated' ? m.unknownAdmin : entry.role === 'service_role' ? m.selfService : m.system),
		fields
	};
}
