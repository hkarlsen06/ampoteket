import { identifier, object, text } from './api';
import { api, errorCode, type StaffSession } from './convex';
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

export async function readAdminMembers(session: StaffSession): Promise<AdminMember[]> {
	const seen = new Set<string>();
	return (await session.client.query(api.members.list, {})).map((value) => {
		const row = object(value), id = identifier(row.id);
		if (seen.has(id) || typeof row.isActive !== 'boolean' || typeof row.emailConfirmed !== 'boolean') throw new Error('Invalid admin member');
		seen.add(id);
		return { id, authUserId: row.authUserId === null ? null : identifier(row.authUserId),
			displayName: text(row.displayName, 120), email: row.email === null ? null : text(row.email, 254),
			isActive: row.isActive, emailConfirmed: row.emailConfirmed };
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

/**
 * Deactivation and invitation both carry the request ID, so repeating a saved
 * command after a lost reply returns the first result. An invitation grants
 * access before emailing: INVITATION_EMAIL_FAILED leaves access in place and the
 * same command sends again.
 */
export async function runMemberCommand(session: StaffSession, command: MemberCommand): Promise<'invited' | 'existing_account' | 'deactivated'> {
	command = parseCommand(command);
	if (session.userId !== command.userId) throw new Error('Admin command identity changed');
	if (command.kind === 'deactivate') {
		const result = await session.client.mutation(api.members.deactivate, { requestId: command.requestId, staffId: command.staffId });
		if (result !== command.staffId) throw new Error('Invalid admin deactivation');
		return 'deactivated';
	}
	const result = await session.client.action(api.members.invite, { requestId: command.requestId, email: command.email, displayName: command.displayName,
		locale: command.locale, targetId: command.targetId, targetActive: command.targetActive });
	identifier(result.staffId);
	if (result.status !== 'invited' && result.status !== 'existing_account') throw new Error('Invalid invitation response');
	return result.status;
}

/** What staff are told: a person needs only the consequence, not the code. */
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
	const code = errorCode(error);
	return code !== null && Object.hasOwn(failures, code) ? failures[code] : null;
}
/** The server definitively refused these: retrying the same command cannot succeed. */
export const retryableMemberFailures: readonly MemberFailure[] = ['emailFailed', 'rateLimited'];
