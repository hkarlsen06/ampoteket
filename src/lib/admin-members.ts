import { ApiError, identifier, isRecord, object, requestApiJson, text, type Fetcher } from './api';
import { staffRequest, type StaffSession } from './admin-api';
import type { Locale } from './i18n';

export type AdminMember = {
	id: string; authUserId: string | null; displayName: string; email: string | null;
	isActive: boolean; emailConfirmed: boolean;
};
export type MemberCommand = { userId: string; requestId: string } & (
	{ kind: 'invite'; displayName: string; email: string; locale: Locale; targetId: string | null; targetActive: boolean | null }
	| { kind: 'deactivate'; staffId: string }
);
export const memberStorageKey = 'ampoteket:admin-member-command:v1';

export async function readAdminMembers(session: StaffSession, fetcher: Fetcher = fetch): Promise<AdminMember[]> {
	const value = await staffRequest(session, 'rpc/amp_list_staff', {}, {}, 'POST', fetcher);
	if (!Array.isArray(value)) throw new Error('Invalid admin list');
	const seen = new Set<string>();
	return value.map(value => {
		const row = object(value), id = identifier(row.id);
		if (seen.has(id) || typeof row.is_active !== 'boolean' || typeof row.email_confirmed !== 'boolean') throw new Error('Invalid admin member');
		seen.add(id);
		return { id, authUserId: row.auth_user_id === null ? null : identifier(row.auth_user_id),
			displayName: text(row.display_name, 120), email: row.email === null ? null : text(row.email, 254),
			isActive: row.is_active, emailConfirmed: row.email_confirmed };
	});
}

function parseCommand(value: unknown): MemberCommand {
	const row = object(value), identity = { userId: identifier(row.userId), requestId: identifier(row.requestId) };
	if (row.kind === 'deactivate') return { ...identity, kind: 'deactivate', staffId: identifier(row.staffId) };
	if (row.kind !== 'invite' || !['nb', 'en'].includes(String(row.locale))
		|| (row.targetId === null ? row.targetActive !== null : typeof row.targetActive !== 'boolean')) throw new Error('Invalid admin invitation');
	const email = text(row.email, 254).trim().toLowerCase();
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid admin email');
	return { ...identity, kind: 'invite', displayName: text(row.displayName, 120).trim(), email,
		locale: row.locale as Locale, targetId: row.targetId === null ? null : identifier(row.targetId), targetActive: row.targetActive as boolean | null };
}
export function readMemberCommand(storage: Pick<Storage, 'getItem'>): MemberCommand | null {
	const raw = storage.getItem(memberStorageKey);
	return raw === null ? null : parseCommand(JSON.parse(raw));
}
export function saveMemberCommand(storage: Pick<Storage, 'getItem' | 'setItem'>, command: MemberCommand): MemberCommand {
	const candidate = parseCommand(command), existing = readMemberCommand(storage), serialized = JSON.stringify(candidate);
	if (existing && JSON.stringify(existing) !== serialized) throw new Error('Unresolved admin command');
	storage.setItem(memberStorageKey, serialized);
	if (storage.getItem(memberStorageKey) !== serialized) throw new Error('Admin storage unavailable');
	return candidate;
}
export function clearMemberCommand(storage: Pick<Storage, 'getItem' | 'removeItem'>, command: MemberCommand) {
	const saved = readMemberCommand(storage);
	if (saved && JSON.stringify(saved) !== JSON.stringify(parseCommand(command))) throw new Error('Admin command changed');
	storage.removeItem(memberStorageKey);
	if (storage.getItem(memberStorageKey) !== null) throw new Error('Admin storage unavailable');
}

export async function runMemberCommand(session: StaffSession, command: MemberCommand, fetcher: Fetcher = fetch): Promise<'invited' | 'existing_account' | 'deactivated'> {
	command = parseCommand(command);
	if (session.userId !== command.userId) throw new Error('Admin command identity changed');
	if (command.kind === 'deactivate') {
		const result = await staffRequest(session, 'rpc/amp_deactivate_staff', {}, { p_request_id: command.requestId, p_staff_id: command.staffId }, 'POST', fetcher);
		if (identifier(result) !== command.staffId) throw new Error('Invalid admin deactivation');
		return 'deactivated';
	}
	const result = object(await requestApiJson('/api/admin/invitations', {
		method: 'POST', credentials: 'same-origin', cache: 'no-store',
		headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
		body: JSON.stringify({ requestId: command.requestId, email: command.email, displayName: command.displayName, locale: command.locale, targetId: command.targetId, targetActive: command.targetActive })
	}, fetcher, 60_000));
	identifier(result.staffId);
	if (result.status !== 'invited' && result.status !== 'existing_account') throw new Error('Invalid invitation response');
	return result.status;
}

export function memberErrorCode(error: unknown): string | null {
	if (!(error instanceof ApiError) || !isRecord(error.body)) return null;
	const value = error.body.error ?? error.body.message;
	return typeof value === 'string' ? value.split(':')[0] : null;
}

/** What staff are told. The server and database codes differ, but a person needs only the consequence. */
export type MemberFailure = 'emailFailed' | 'rateLimited' | 'invalidInput' | 'notFound' | 'conflict' | 'superseded' | 'self';
const failures: Record<string, MemberFailure> = {
	INVITATION_EMAIL_FAILED: 'emailFailed', RATE_LIMITED: 'rateLimited',
	INVALID_ADMIN_INVITATION: 'invalidInput', STAFF_EMAIL_REQUIRED: 'invalidInput', STAFF_DISPLAY_NAME_REQUIRED: 'invalidInput',
	STAFF_NOT_FOUND: 'notFound', STAFF_USER_NOT_FOUND: 'notFound',
	IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT: 'conflict',
	INVITATION_SUPERSEDED: 'superseded', STAFF_SELF_DEACTIVATION: 'self'
};
/** Null means the outcome is unknown (transport failure or an unlisted code), so the saved command stays for retry. */
export function memberFailure(error: unknown): MemberFailure | null {
	return failures[memberErrorCode(error) ?? ''] ?? null;
}
/** The server definitively refused these: retrying the same command cannot succeed. */
export const retryableMemberFailures: readonly MemberFailure[] = ['emailFailed', 'rateLimited'];
