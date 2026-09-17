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
