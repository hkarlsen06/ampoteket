import { expect, test } from 'bun:test';
import { ApiError, type Fetcher } from './api';
import { memory } from './test-storage';
import { clearMemberCommand, memberErrorCode, memberFailure, readAdminMembers, readMemberCommand, runMemberCommand, saveMemberCommand, type MemberCommand } from './admin-members';

const userId = '11111111-1111-4111-8111-111111111111', requestId = '22222222-2222-4222-8222-222222222222', staffId = '33333333-3333-4333-8333-333333333333';
const session = { userId, token: 'staff-jwt', config: { url: 'https://fixture.invalid', publishableKey: 'public-test' } };
const invitation: MemberCommand = { kind: 'invite', userId, requestId, email: 'person@example.no', displayName: 'New admin', locale: 'en', targetId: null, targetActive: null };

test('invitation retries preserve identity, locale and exact payload after a lost response', async () => {
	const storage = memory(), bodies: string[] = [];
	const pending = saveMemberCommand(storage, invitation);
	const fetcher: Fetcher = async (input, init) => {
		expect(String(input)).toBe('/api/admin/invitations');
		expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer staff-jwt');
		expect(new Headers(init?.headers).has('apikey')).toBe(false);
		expect(init?.redirect).toBe('manual'); expect(init?.cache).toBe('no-store');
		bodies.push(String(init?.body));
		if (bodies.length === 1) throw new Error('Lost response');
		return Response.json({ staffId, status: 'invited' });
	};
	await expect(runMemberCommand(session, pending, fetcher)).rejects.toThrow('Lost response');
	expect(() => saveMemberCommand(storage, { ...invitation, requestId: staffId })).toThrow('Unresolved');
	await expect(runMemberCommand({ ...session, userId: staffId }, pending, fetcher)).rejects.toThrow('identity');
	expect(await runMemberCommand(session, readMemberCommand(storage)!, fetcher)).toBe('invited');
	expect(bodies).toHaveLength(2); expect(bodies[0]).toBe(bodies[1]);
	expect(JSON.parse(bodies[0])).toEqual({ requestId, email: invitation.email, displayName: invitation.displayName, locale: 'en', targetId: null, targetActive: null });
	clearMemberCommand(storage, pending); expect(readMemberCommand(storage)).toBeNull();
	await runMemberCommand(session, { ...invitation, targetId: staffId, targetActive: true }, async (_input, init) => {
		expect(JSON.parse(String(init?.body)).targetId).toBe(staffId);
		return Response.json({ staffId, status: 'invited' });
	});
});

test('member reads and deactivation use the current staff JWT and validate replies', async () => {
	const member = { id: staffId, auth_user_id: null, display_name: 'Former admin', email: null, is_active: false, email_confirmed: false };
	const rows = await readAdminMembers(session, async (input, init) => {
		expect(new URL(String(input)).pathname).toBe('/rest/v1/rpc/amp_list_staff');
		expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer staff-jwt');
		return Response.json([member]);
	});
	expect(rows[0]).toEqual({ id: staffId, authUserId: null, displayName: 'Former admin', email: null, isActive: false, emailConfirmed: false });
	for (const invalid of [[member, member], [{ ...member, email_confirmed: 'false' }], [{ ...member, auth_user_id: 'bad' }]]) {
		await expect(readAdminMembers(session, async () => Response.json(invalid))).rejects.toThrow();
	}
	const command: MemberCommand = { kind: 'deactivate', userId, requestId, staffId };
	expect(await runMemberCommand(session, command, async (input, init) => {
		expect(new URL(String(input)).pathname).toBe('/rest/v1/rpc/amp_deactivate_staff');
		expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer staff-jwt');
		expect(JSON.parse(String(init?.body))).toEqual({ p_request_id: requestId, p_staff_id: staffId });
		return Response.json(staffId);
	})).toBe('deactivated');
	await expect(runMemberCommand(session, command, async () => Response.json(userId))).rejects.toThrow('Invalid admin deactivation');
});

test('partial invitation failures and database rejections remain distinguishable', async () => {
	const error = new ApiError(503, { error: 'INVITATION_EMAIL_FAILED' });
	await expect(runMemberCommand(session, invitation, async () => Response.json(error.body, { status: error.status }))).rejects.toBeInstanceOf(ApiError);
	expect(memberErrorCode(error)).toBe('INVITATION_EMAIL_FAILED');
	expect(memberErrorCode(new ApiError(409, { error: 'INVITATION_SUPERSEDED' }))).toBe('INVITATION_SUPERSEDED');
	expect(memberErrorCode(new ApiError(400, { message: 'STAFF_SELF_DEACTIVATION: cannot remove own access' }))).toBe('STAFF_SELF_DEACTIVATION');
	expect(memberErrorCode(new Error('Network unavailable'))).toBeNull();
	expect(memberFailure(new ApiError(409, { error: 'STAFF_USER_NOT_FOUND' }))).toBe('notFound');
	expect(memberFailure(new ApiError(400, { message: 'STAFF_EMAIL_REQUIRED' }))).toBe('invalidInput');
	expect(memberFailure(new ApiError(409, { error: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT' }))).toBe('conflict');
	expect(memberFailure(new ApiError(502, { error: 'INVITATION_EMAIL_FAILED' }))).toBe('emailFailed');
	expect(memberFailure(new ApiError(500, { error: 'SOMETHING_NEW' }))).toBeNull();
	expect(memberFailure(new Error('Network unavailable'))).toBeNull();
});
