import { object, identifier, text } from './api';
import { api, type StaffSession } from './convex';
import { categoryLabel, messagesFor, specificationLabel, type Locale } from './i18n';
import { formatCountedAt, formatDecimal, formatMeasurement, formatMoney, gridCell, gridRange, unitLabel } from './format';
import { productName } from './catalog';

export type AuditEntry = {
	id: string; table: string; key: Record<string, unknown>; action: 'INSERT' | 'UPDATE' | 'DELETE' | 'CONTACT_CLEARED';
	before: Record<string, unknown> | null; after: Record<string, unknown> | null;
	actorId: string | null; role: string; recordedAt: string;
};
/** A page of entries, newest first, with the names they refer to; `more` when older entries exist. */
export type AuditPage = { entries: AuditEntry[]; references: AuditReferences; more: boolean };

const pageSize = 200;
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
/** Entries strictly newest first, each older than `before` when given. */
function parseEntries(value: unknown, before: string | null = null): AuditEntry[] {
	if (!Array.isArray(value)) throw new Error('Invalid audit page');
	let cursor = before;
	return value.map((row) => {
		const entry = parseEntry(row);
		if (cursor !== null && BigInt(entry.id) >= BigInt(cursor)) throw new Error('Invalid audit cursor');
		cursor = entry.id;
		return entry;
	});
}
/** Names by table and UUID, resolved by the backend (archived drawers carry where they used to be). */
function parseReferences(value: unknown): AuditReferences {
	return Object.fromEntries(Object.entries(object(value)).map(([table, rows]) =>
		[table, Object.fromEntries(Object.entries(object(rows)).map(([id, row]) => [identifier(id), object(row)]))]));
}

/** One page of the log, newest first, older than `before` (an entry ID) when given. */
export async function readAuditPage(session: StaffSession, before: string | null = null): Promise<AuditPage> {
	if (before !== null) auditId(before);
	return parseAuditPage(await session.client.query(api.auditLog.page, before === null ? {} : { before }), before);
}
/** Validate a page as the backend returns it, from a one-off read or a live subscription. */
export function parseAuditPage(value: unknown, before: string | null = null): AuditPage {
	const row = object(value);
	const entries = parseEntries(row.entries, before);
	if (entries.length > pageSize || typeof row.more !== 'boolean') throw new Error('Invalid audit page');
	return { entries, references: parseReferences(row.references), more: row.more };
}

/**
 * The entries between a live page and the newest one already shown, when more
 * than a page arrived between two updates: older pages from `oldest` down to
 * `newestKnown`, so the list never has a hole.
 */
export async function readAuditGap(session: StaffSession, oldest: string, newestKnown: string): Promise<AuditPage> {
	const known = BigInt(auditId(newestKnown));
	const gap: AuditPage = { entries: [], references: {}, more: false };
	let cursor = oldest;
	for (;;) {
		const page = await readAuditPage(session, cursor);
		gap.entries.push(...page.entries.filter((entry) => BigInt(entry.id) > known));
		gap.references = mergeAuditReferences(gap.references, page.references);
		if (!page.more || page.entries.some((entry) => BigInt(entry.id) <= known)) return gap;
		cursor = page.entries.at(-1)!.id;
	}
}

/** Both lists, newest first, each entry once. The log is append-only, so a known entry never changes. */
export function mergeAuditEntries(a: AuditEntry[], b: AuditEntry[]): AuditEntry[] {
	const byId = new Map([...a, ...b].map((entry) => [entry.id, entry]));
	return [...byId.values()].sort((x, y) => BigInt(x.id) > BigInt(y.id) ? -1 : BigInt(x.id) < BigInt(y.id) ? 1 : 0);
}
/** Later names win: a rename shows on every loaded entry. */
export function mergeAuditReferences(a: AuditReferences, b: AuditReferences): AuditReferences {
	const result: AuditReferences = { ...a };
	for (const [table, rows] of Object.entries(b)) result[table] = { ...result[table], ...rows };
	return result;
}

/** Every product creation recorded since `since`, newest first, with the names of who created them. */
export async function readProductCreations(session: StaffSession, since: string): Promise<{ entries: AuditEntry[]; references: AuditReferences }> {
	timestamp(since);
	const row = object(await session.client.query(api.auditLog.productCreations, { since }));
	const entries = parseEntries(row.entries);
	if (entries.some((entry) => entry.table !== 'products' || entry.action !== 'INSERT')) throw new Error('Invalid product creation');
	return { entries, references: parseReferences(row.references) };
}

/** The actor as the audit page names it. */
export function auditActor(entry: AuditEntry, locale: Locale, references: AuditReferences): string {
	return describeAudit({ ...entry, before: null, after: null }, locale, references).actor;
}

type AuditRow = Record<string, unknown>;
export type AuditReferences = Record<string, Record<string, AuditRow>>;
export type AuditDescription = { subject: string; actor: string; fields: { label: string; before: string | null; after: string | null }[] };

const referenceTables: Record<string, string> = { product_id: 'products', attribute_id: 'attribute_definitions', category_id: 'categories', bin_id: 'bins', cabinet_id: 'cabinets', order_id: 'purchase_orders', owner_id: 'staff_members', created_by: 'staff_members', finished_by: 'staff_members' };
const uuidInText = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const numericFields = new Set(['stock_step', 'sale_step', 'minimum_stock', 'ordered_quantity', 'number_value', 'number_max', 'display_order', 'outer_row', 'outer_col', 'inner_row', 'inner_col', 'inner_rows', 'inner_cols', 'row_span', 'col_span']);
const readable = (value: unknown): string | undefined => typeof value === 'string' && value.trim() && !uuidInText.test(value) ? value : undefined;
const coordinate = (value: unknown): number | undefined => typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;

/** The name staff know a row by, without its type, or undefined when it has none. */
export function auditName(table: string, data: AuditRow, locale: Locale, references: AuditReferences = {}): string | undefined {
	const subject = (table: string, data: AuditRow) => auditName(table, data, locale, references);
	function reference(table: string, id: unknown): AuditRow | undefined { return typeof id === 'string' ? references[table]?.[id] : undefined; }
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

/** Presentation whitelist: internal IDs, revisions and unrecognized columns never reach staff. */
export function describeAudit(entry: AuditEntry, locale: Locale, references: AuditReferences = {}): AuditDescription {
	const m = messagesFor(locale).adminAudit;
	const before = entry.before ?? {}; const after = entry.after ?? {};
	const row = { ...before, ...after };
	function reference(table: string, id: unknown): AuditRow | undefined { return typeof id === 'string' ? references[table]?.[id] : undefined; }
	const subject = (table: string, data: AuditRow) => auditName(table, data, locale, references);
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
		// Imported images hold every number as a string; newer ones hold integers as numbers and decimals as strings.
		const number = typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : raw;
		if ((numericFields.has(field) || field.endsWith('_nok')) && typeof number === 'string' && /^-?\d+(?:\.\d+)?$/.test(number)) {
			if (field.endsWith('_nok')) return formatMoney(number, locale);
			const product = entry.table === 'products' ? data : reference('products', data.product_id);
			const unit = product && typeof product.unit_code === 'string' ? unitLabel(product.unit_code, locale, number) : undefined;
			if (['stock_step', 'sale_step', 'minimum_stock', 'ordered_quantity'].includes(field)) return `${formatDecimal(number, locale)}${unit ? ` ${unit}` : ''}`;
			const definition = reference('attribute_definitions', data.attribute_id);
			if ((field === 'number_value' || field === 'number_max') && typeof definition?.canonical_unit === 'string') return formatMeasurement(number, definition.canonical_unit, locale);
			return formatDecimal(number, locale);
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

export type AuditField = AuditDescription['fields'][number];
/** One person's work on one thing: a product with its specifications and opening count, an order with its lines, or any other row. */
export type AuditEvent = { key: string; table: string; action: AuditEntry['action']; subject: string; name: string; first: string; last: string; fields: AuditField[] };
/** Events of one kind and action by one person on one day, such as every product Ada created on Monday. */
export type AuditBatch = { key: string; table: string; action: AuditEntry['action']; actor: string; first: string; last: string; title: string; summary: string; events: AuditEvent[] };
export type AuditDay = { key: string; at: string; batches: AuditBatch[] };

/** Entries this close together by the same person on the same thing read as one piece of work. */
const eventGap = 30 * 60 * 1000;
const osloDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit' });
/** The workshop's calendar day an entry falls on, as YYYY-MM-DD. */
export const auditDay = (recordedAt: string) => osloDay.format(new Date(recordedAt));

/** The row an entry belongs to: specifications and opening counts join their product, lines their order. */
function auditOwner(entry: AuditEntry): { table: string; id: string } {
	const row = { ...entry.before, ...entry.after };
	if ((entry.table === 'product_attributes' || entry.table === 'count_batches') && typeof row.product_id === 'string') return { table: 'products', id: row.product_id };
	if (entry.table === 'purchase_order_lines' && typeof row.order_id === 'string') return { table: 'purchase_orders', id: row.order_id };
	return { table: entry.table, id: typeof entry.key.id === 'string' ? entry.key.id : JSON.stringify(entry.key) };
}

/** Fold entries into days of batched events, newest first, so a day of catalogue entry reads as a few lines. */
export function groupAudit(entries: AuditEntry[], locale: Locale, references: AuditReferences = {}): AuditDay[] {
	const m = messagesFor(locale).adminAudit;
	type Draft = { event: AuditEvent; ownerId: string; actorKey: string; actor: string; newest: bigint; at: number; main: AuditRow | undefined; fields: Map<string, AuditField>; inserted: Set<string> };
	const open = new Map<string, Draft>(); const drafts: Draft[] = [];
	// Oldest first, so entries that arrive later only extend the newest events and keys stay stable.
	for (const entry of [...entries].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1)) {
		const owner = auditOwner(entry); const actorKey = entry.actorId ?? `role:${entry.role}`;
		const slot = `${actorKey}|${owner.table}|${owner.id}`; const at = Date.parse(entry.recordedAt);
		let draft = open.get(slot);
		if (!draft || at - draft.at > eventGap) {
			draft = { event: { key: entry.id, table: owner.table, action: 'UPDATE', subject: '', name: '', first: entry.recordedAt, last: entry.recordedAt, fields: [] },
				ownerId: owner.id, actorKey, actor: auditActor(entry, locale, references), newest: 0n, at, main: undefined, fields: new Map(), inserted: new Set() };
			open.set(slot, draft); drafts.push(draft);
		}
		draft.at = at; draft.event.last = entry.recordedAt; draft.newest = BigInt(entry.id);
		const row = { ...entry.before, ...entry.after }; const rowKey = `${entry.table}|${JSON.stringify(entry.key)}`;
		if (entry.action === 'INSERT') draft.inserted.add(rowKey);
		if (entry.table === owner.table) {
			draft.main = { ...draft.main, ...row };
			if (entry.action === 'INSERT' || (entry.action !== 'UPDATE' && draft.event.action === 'UPDATE')) draft.event.action = entry.action;
		}
		const add = (key: string, field: AuditField) => {
			const known = draft.fields.get(key);
			if (known) known.after = field.after;
			else draft.fields.set(key, { ...field, before: draft.inserted.has(rowKey) ? null : field.before });
		};
		if (entry.table === 'count_batches' && owner.table === 'products') {
			add(rowKey, { label: m.tables.count_batches, before: null, after: entry.after ? row.finished_at ? m.counted : m.fields.started_at : null });
			continue;
		}
		const identity = [m.fields.product_id, m.fields.attribute_id, m.fields.order_id];
		const specification = entry.table === 'product_attributes' && entry.table !== owner.table
			? auditName('attribute_definitions', references.attribute_definitions?.[String(row.attribute_id)] ?? {}, locale, references) ?? m.unresolved : undefined;
		const line = entry.table === 'purchase_order_lines' && entry.table !== owner.table
			? auditName('products', references.products?.[String(row.product_id)] ?? {}, locale, references) ?? m.unresolved : undefined;
		for (const field of describeAudit(entry, locale, references).fields) {
			if ((specification || line) && identity.includes(field.label)) continue;
			const label = specification ? field.label === m.fields.number_max ? `${specification} (${field.label})` : specification : line ? `${line}: ${field.label}` : field.label;
			add(`${rowKey}|${label}`, { ...field, label });
		}
	}
	const days = new Map<string, AuditDay>(); const batches = new Map<string, AuditBatch>();
	for (const draft of drafts.sort((a, b) => a.newest > b.newest ? -1 : 1)) {
		const { event } = draft;
		event.fields = [...draft.fields.values()].filter(field => field.before !== field.after && !(field.before === null && field.after === m.none));
		const type = (m.tables as Record<string, string>)[event.table] ?? m.unknownSubject;
		const name = auditName(event.table, draft.main ?? references[event.table]?.[draft.ownerId] ?? {}, locale, references);
		event.name = name ?? type; event.subject = name ? `${type}: ${name}` : type;
		const day = auditDay(event.last);
		const key = `${day}|${draft.actorKey}|${event.table}|${event.action}`;
		let batch = batches.get(key);
		if (!batch) {
			batch = { key, table: event.table, action: event.action, actor: draft.actor, first: event.first, last: event.last, title: '', summary: '', events: [] };
			batches.set(key, batch);
			let date = days.get(day);
			if (!date) days.set(day, date = { key: day, at: event.last, batches: [] });
			date.batches.push(batch);
		}
		batch.events.push(event);
		if (Date.parse(event.first) < Date.parse(batch.first)) batch.first = event.first;
	}
	for (const batch of batches.values()) {
		const [only] = batch.events;
		if (batch.events.length === 1) {
			batch.title = only.subject; batch.summary = only.fields.slice(0, 3).map(field => field.label).join(', ');
		} else {
			batch.title = m.batch(batch.events.length, (m.many as Record<string, string>)[batch.table] ?? m.many.entries);
			batch.summary = m.someOf(batch.events.slice(0, 3).map(event => event.name), batch.events.length - 3);
		}
	}
	return [...days.values()];
}
