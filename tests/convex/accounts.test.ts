// Invitations, password links, sign-in and membership changes (datamodell.md §9).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { api } from '../../convex/_generated/api';
import { emailPort, enabled, freshDeployment, guest, rejected, signedIn, staff, uuid } from './harness';

/** A stand-in for Resend that keeps every message, so tests can follow the link. */
let outbox: { to: string[]; subject: string; html: string }[] = [];
let fail = false;
let server: ReturnType<typeof Bun.serve> | null = null;
const linkIn = (html: string) => new URL(/href="([^"]*token_hash[^"]*)"/.exec(html)![1].replaceAll('&amp;', '&').replaceAll('&#38;', '&'));

describe.skipIf(!enabled)('accounts', () => {
	beforeAll(() => {
		server = Bun.serve({ port: emailPort, hostname: '127.0.0.1', async fetch(request) {
			if (fail) return new Response('down', { status: 503 });
			outbox.push(await request.json());
			return Response.json({ id: 'test' });
		} });
	});
	afterAll(() => server?.stop());
	beforeEach(async () => { await freshDeployment(); outbox = []; fail = false; });

	test('an invitation creates the account, mails a single-use link, and the chosen password signs in', async () => {
		const inviter = await staff('Inviter');
		const email = `new-${Date.now()}@example.no`;
		const result = await inviter.client.action(api.members.invite, { requestId: uuid(), email: email.toUpperCase(), displayName: 'Ny frivillig', locale: 'en', targetId: null, targetActive: null });
		expect(result.status).toBe('invited');
		expect(outbox).toHaveLength(1);
		expect(outbox[0].to).toEqual([email]);
		const link = linkIn(outbox[0].html);
		expect(link.pathname).toBe('/en/admin/password');
		expect(link.searchParams.get('type')).toBe('invite');
		const token = link.searchParams.get('token_hash')!;
		const list = await inviter.client.query(api.members.list, {});
		expect(list.find((m) => m.email === email)).toMatchObject({ isActive: true, emailConfirmed: false });
		// Opening the link consumes nothing; setting the password does.
		expect(await guest().query(api.passwords.checkLink, { token })).toEqual({ valid: true });
		expect(await rejected(guest().mutation(api.passwords.complete, { token, password: 'short' }))).toBe('PASSWORD_TOO_SHORT');
		expect(await guest().mutation(api.passwords.complete, { token, password: 'a long new password' })).toEqual({ email });
		expect(await rejected(guest().mutation(api.passwords.complete, { token, password: 'another password' }))).toBe('INVALID_PASSWORD_LINK');
		const member = await signedIn(email, 'a long new password');
		expect((await member.query(api.members.me, {}))?.membership?.displayName).toBe('Ny frivillig');
		expect((await inviter.client.query(api.members.list, {})).find((m) => m.email === email)?.emailConfirmed).toBe(true);
		// A confirmed account keeps its password: no new invitation.
		expect((await inviter.client.action(api.members.invite, { requestId: uuid(), email, displayName: 'Ny frivillig', locale: 'nb', targetId: null, targetActive: null })).status)
			.toBe('existing_account');
		expect(outbox).toHaveLength(1);
	});

	test('a failed email keeps the membership, and retrying the same request sends again', async () => {
		const inviter = await staff();
		const args = { requestId: uuid(), email: `retry-${Date.now()}@example.no`, displayName: 'Retry', locale: 'nb' as const, targetId: null, targetActive: null };
		fail = true;
		expect(await rejected(inviter.client.action(api.members.invite, args))).toBe('INVITATION_EMAIL_FAILED');
		expect((await inviter.client.query(api.members.list, {})).some((m) => m.email === args.email)).toBe(true);
		fail = false;
		expect((await inviter.client.action(api.members.invite, args)).status).toBe('invited');
		expect(outbox).toHaveLength(1);
	});

	test('wrong passwords and unknown addresses answer alike; reset requests reveal nothing', async () => {
		const member = await staff();
		expect(await rejected(guest().action(api.session.signIn, { email: member.email, password: 'wrong password!' }))).toBe('INVALID_CREDENTIALS');
		expect(await rejected(guest().action(api.session.signIn, { email: 'nobody@example.no', password: 'wrong password!' }))).toBe('INVALID_CREDENTIALS');
		expect(await guest().action(api.passwords.requestReset, { email: 'nobody@example.no', locale: 'nb' })).toBeNull();
		expect(outbox).toHaveLength(0);
		expect(await guest().action(api.passwords.requestReset, { email: member.email, locale: 'nb' })).toBeNull();
		expect(outbox).toHaveLength(1);
		const token = linkIn(outbox[0].html).searchParams.get('token_hash')!;
		await guest().mutation(api.passwords.complete, { token, password: 'my reset password' });
		await signedIn(member.email, 'my reset password');
		expect(await rejected(guest().action(api.session.signIn, { email: member.email, password: member.password }))).toBe('INVALID_CREDENTIALS');
	});

	test('nobody deactivates themselves; a resend cannot revive a revoked member', async () => {
		const a = await staff('A'), b = await staff('B');
		expect(await rejected(a.client.mutation(api.members.deactivate, { requestId: uuid(), staffId: a.staffId }))).toBe('STAFF_SELF_DEACTIVATION');
		await a.client.mutation(api.members.deactivate, { requestId: uuid(), staffId: b.staffId });
		expect(await rejected(b.client.query(api.stock.inventory, {}))).toBe('STAFF_REQUIRED');
		expect((await b.client.query(api.members.me, {}))?.membership).toBeNull();
		expect(await rejected(a.client.action(api.members.invite, { requestId: uuid(), email: b.email, displayName: 'B', locale: 'nb', targetId: b.staffId, targetActive: true })))
			.toBe('INVITATION_SUPERSEDED');
		expect((await a.client.action(api.members.invite, { requestId: uuid(), email: b.email, displayName: 'B again', locale: 'nb', targetId: b.staffId, targetActive: false })).status)
			.toBe('existing_account');
		expect((await b.client.query(api.members.me, {}))?.membership?.displayName).toBe('B again');
	});
});
