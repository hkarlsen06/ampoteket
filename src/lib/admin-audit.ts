import { object, identifier, text, type Fetcher } from './api';
import { staffRequest, type StaffSession } from './admin-api';

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

export type AuditFieldDiff = { name: string; changed: boolean; prefix: string; deleted: string; inserted: string; suffix: string };

const wordChar = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}_]/u.test(char);

/** Every field of a before/after pair as JSON text, a changed value trimmed to its differing whole words so a shared letter never splits a word. */
export function auditFieldDiff(before: Record<string, unknown>, after: Record<string, unknown>): AuditFieldDiff[] {
	return [...new Set([...Object.keys(before), ...Object.keys(after)])].map(name => {
		const old = name in before ? JSON.stringify(before[name]) : '';
		const now = name in after ? JSON.stringify(after[name]) : '';
		const max = Math.min(old.length, now.length);
		let start = 0;
		while (start < max && old[start] === now[start]) start++;
		if (start && /[\uD800-\uDBFF]/.test(old[start - 1])) start--;
		while (start && wordChar(old[start - 1]) && (wordChar(old[start]) || wordChar(now[start]))) start--;
		let end = 0;
		while (end < max - start && old[old.length - 1 - end] === now[now.length - 1 - end]) end++;
		if (end && /[\uDC00-\uDFFF]/.test(old[old.length - end])) end--;
		while (end && wordChar(old[old.length - end]) && (wordChar(old[old.length - end - 1]) || wordChar(now[now.length - end - 1]))) end--;
		return { name, changed: old !== now, prefix: old.slice(0, start), deleted: old.slice(start, old.length - end), inserted: now.slice(start, now.length - end), suffix: old.slice(old.length - end) };
	});
}
