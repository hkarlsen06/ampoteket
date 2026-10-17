import { expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { rejection, type ConvexCaller, type StaffSession } from './convex';
import { memory } from './test-storage';
import { clearMemberCommand, memberFailure, readAdminMembers, readMemberCommand, runMemberCommand, saveMemberCommand, type MemberCommand } from './admin-members';

const userId = '11111111-1111-4111-8111-111111111111', requestId = '22222222-2222-4222-8222-222222222222', staffId = '33333333-3333-4333-8333-333333333333';
type Call = { name: string; args: Record<string, unknown> };
/** A ConvexCaller that records calls and answers by function name. */
function stub(handlers: Record<string, (args: Record<string, unknown>) => unknown>, calls: Call[] = []): ConvexCaller {
	const call = async (fn: never, args: Record<string, unknown>) => {
		const name = getFunctionName(fn); calls.push({ name, args });
		if (!handlers[name]) throw new Error(`Unexpected ${name}`);
		return handlers[name](args);
	};
	return { query: call, mutation: call, action: call } as unknown as ConvexCaller;
}
const staff = (client: ConvexCaller): StaffSession => ({ client, userId });
const invitation: MemberCommand = { kind: 'invite', userId, requestId, email: 'person@example.no', displayName: 'New admin', locale: 'en', targetId: null, targetActive: null };

test('invitation retries preserve identity, locale and exact arguments after a lost response', async () => {
	const storage = memory(), calls: Call[] = [];
	const pending = saveMemberCommand(storage, invitation);
	const client = stub({ 'members:invite': () => {
		if (calls.length === 1) throw new Error('Lost response');
		return { staffId, status: 'invited' };
	} }, calls);
	await expect(runMemberCommand(staff(client), pending)).rejects.toThrow('Lost response');
	expect(() => saveMemberCommand(storage, { ...invitation, requestId: staffId })).toThrow('Unresolved');
	await expect(runMemberCommand({ client, userId: staffId }, pending)).rejects.toThrow('identity');
	expect(await runMemberCommand(staff(client), readMemberCommand(storage)!)).toBe('invited');
	expect(calls).toHaveLength(2); expect(calls[0]).toEqual(calls[1]);
	expect(calls[0].args).toEqual({ requestId, email: invitation.email, displayName: invitation.displayName, locale: 'en', targetId: null, targetActive: null });
	clearMemberCommand(storage, pending); expect(readMemberCommand(storage)).toBeNull();
	const resend = stub({ 'members:invite': (args) => {
		expect(args.targetId).toBe(staffId); expect(args.targetActive).toBe(true);
		return { staffId, status: 'existing_account' };
	} });
	expect(await runMemberCommand(staff(resend), { ...invitation, targetId: staffId, targetActive: true })).toBe('existing_account');
	await expect(runMemberCommand(staff(stub({ 'members:invite': () => ({ staffId, status: 'sent' }) })), invitation)).rejects.toThrow('Invalid invitation');
});

test('member reads and deactivation validate replies', async () => {
	const member = { id: staffId, authUserId: null, displayName: 'Former admin', email: null, isActive: false, emailConfirmed: false };
	const rows = await readAdminMembers(staff(stub({ 'members:list': () => [member] })));
	expect(rows[0]).toEqual(member);
	for (const invalid of [[member, member], [{ ...member, emailConfirmed: 'false' }], [{ ...member, authUserId: 'bad' }]]) {
		await expect(readAdminMembers(staff(stub({ 'members:list': () => invalid })))).rejects.toThrow();
	}
	const command: MemberCommand = { kind: 'deactivate', userId, requestId, staffId };
	const calls: Call[] = [];
	expect(await runMemberCommand(staff(stub({ 'members:deactivate': () => staffId }, calls)), command)).toBe('deactivated');
	expect(calls).toEqual([{ name: 'members:deactivate', args: { requestId, staffId } }]);
	await expect(runMemberCommand(staff(stub({ 'members:deactivate': () => userId })), command)).rejects.toThrow('Invalid admin deactivation');
});

test('partial invitation failures and definite rejections remain distinguishable from unknown outcomes', async () => {
	const emailFailed = rejection('INVITATION_EMAIL_FAILED');
	await expect(runMemberCommand(staff(stub({ 'members:invite': () => { throw emailFailed; } })), invitation)).rejects.toBe(emailFailed);
	expect(memberFailure(emailFailed)).toBe('emailFailed');
	expect(memberFailure(rejection('INVITATION_SUPERSEDED'))).toBe('superseded');
	expect(memberFailure(rejection('STAFF_SELF_DEACTIVATION', 'STAFF_SELF_DEACTIVATION: cannot remove own access'))).toBe('self');
	expect(memberFailure(rejection('STAFF_USER_NOT_FOUND'))).toBe('notFound');
	expect(memberFailure(rejection('STAFF_EMAIL_REQUIRED'))).toBe('invalidInput');
	expect(memberFailure(rejection('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT'))).toBe('conflict');
	expect(memberFailure(rejection('RATE_LIMITED'))).toBe('rateLimited');
	expect(memberFailure(rejection('SOMETHING_NEW'))).toBeNull();
	expect(memberFailure(rejection('toString'))).toBeNull();
	expect(memberFailure(new Error('INVITATION_EMAIL_FAILED'))).toBeNull();
	expect(memberFailure(new Error('Network unavailable'))).toBeNull();
});
