import { expect, test } from 'bun:test';
import { adminInvitation, type AdminInvitationConfig } from './admin-invitations';

const origin = 'https://shop.example.test';
const userId = '11111111-1111-4111-8111-111111111111';
const staffId = '22222222-2222-4222-8222-222222222222';
const inviteeId = '33333333-3333-4333-8333-333333333333';
const command = { requestId: '44444444-4444-4444-8444-444444444444', email: 'new@example.test', displayName: 'New admin', locale: 'en', targetId: null, targetActive: null };
const headers = { Origin: origin, Authorization: 'Bearer signed-caller-jwt', 'Content-Type': 'application/json' };

test('invitations verify the caller, separate credentials and handle partial success safely', async () => {
	const config: AdminInvitationConfig = { origin, apiUrl: 'https://database.example.test', publishableKey: 'sb_publishable_test',
		secretKey: 'sb_secret_test', invitationLimit: { limit: async () => ({ success: true }) } };
	const calls: { url: URL; headers: Headers; body: Record<string, unknown> }[] = [];
	let expectedTarget: string | null = null;
	let hasAccess = true; let confirmed = false; let active = true; let emailFails = false; let existing = false; let grantFails = false;
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input)); const sent = new Headers(init?.headers);
		const body = init?.body ? JSON.parse(String(init.body)) : {};
		calls.push({ url, headers: sent, body });
		expect(init?.redirect).toBe('manual');
		if (url.pathname.startsWith('/rest/') || url.pathname === '/auth/v1/user') {
			expect(sent.get('apikey')).toBe(config.publishableKey);
			expect(sent.get('authorization')).toBe(headers.Authorization);
		} else {
			expect(sent.get('apikey')).toBe(config.secretKey);
			expect(sent.get('authorization')).toBeNull();
		}
		switch (url.pathname) {
			case '/auth/v1/user': return Response.json({ id: userId });
			case '/rest/v1/amp_staff_members': return Response.json(hasAccess ? [{ id: staffId, auth_user_id: userId, display_name: 'Inviter', is_active: true }] : []);
			case '/auth/v1/admin/users':
				expect(body).toEqual({ email: command.email, email_confirm: false });
				return existing ? Response.json({ code: 422, error_code: 'email_exists' }, { status: 422 }) : Response.json({ id: inviteeId });
			case '/rest/v1/rpc/amp_grant_staff_access':
				expect(body).toEqual({ p_request_id: command.requestId, p_email: command.email, p_display_name: command.displayName, p_expected_staff_id: expectedTarget, p_expected_active: expectedTarget === null ? null : true });
				return grantFails ? Response.json({ code: '42501', message: 'STAFF_REQUIRED' }, { status: 403 }) : Response.json(staffId);
			case '/rest/v1/rpc/amp_list_staff': return Response.json([{ id: staffId, auth_user_id: inviteeId, email: command.email, is_active: active, email_confirmed: confirmed }]);
			case '/auth/v1/invite':
				expect(url.searchParams.get('redirect_to')).toBe(`${origin}/en/admin/password?next=%2Fadmin`);
				return emailFails ? Response.json({ message: 'private SMTP diagnostic' }, { status: 500 }) : Response.json({ id: inviteeId });
			default: throw new Error('Unexpected endpoint');
		}
	};
	async function post(body: unknown = command, init: RequestInit = {}) {
		calls.length = 0;
		const result = await adminInvitation(new Request(`${origin}/api/admin/invitations`, { method: 'POST', headers, body: JSON.stringify(body), ...init }), '127.0.0.1', config, fetcher);
		expect(result.headers.get('cache-control')).toBe('no-store');
		return { status: result.status, body: await result.json() };
	}
	expect(await post()).toEqual({ status: 200, body: { status: 'invited', staffId } });
	expect(calls.at(-1)?.url.pathname).toBe('/auth/v1/invite');
	expectedTarget = staffId;
	expect((await post({ ...command, targetId: staffId, targetActive: true })).status).toBe(200);
	expectedTarget = null;
	expect(calls.some(call => call.url.pathname === '/auth/v1/admin/users')).toBe(false);
	hasAccess = false;
	expect(await post()).toEqual({ status: 403, body: { error: 'STAFF_REQUIRED' } });
	expect(calls).toHaveLength(2);
	hasAccess = true; grantFails = true;
	expect(await post()).toEqual({ status: 403, body: { error: 'STAFF_REQUIRED' } });
	expect(calls.some(call => call.url.pathname === '/auth/v1/invite')).toBe(false);
	grantFails = false; existing = true; confirmed = true;
	expect(await post()).toEqual({ status: 200, body: { status: 'existing_account', staffId } });
	expect(calls.some(call => call.url.pathname === '/auth/v1/invite')).toBe(false);
	confirmed = false; emailFails = true;
	expect(await post()).toEqual({ status: 502, body: { error: 'INVITATION_EMAIL_FAILED' } });
	emailFails = false;
	expect((await post()).body).toEqual({ status: 'invited', staffId });
	active = false;
	expect(await post()).toEqual({ status: 409, body: { error: 'INVITATION_SUPERSEDED' } });
	expect(calls.some(call => call.url.pathname === '/auth/v1/invite')).toBe(false);
	for (const invalid of [{ ...command, role: 'admin' }, { ...command, locale: 'https://attacker.test' },
		{ ...command, email: 'bad\n@example.test' }, { ...command, displayName: '  ' }, { ...command, requestId: 'bad' }]) {
		expect((await post(invalid)).status).toBe(400); expect(calls).toHaveLength(0);
	}
	for (const [init, status] of [
		[{ headers: { ...headers, Origin: 'https://attacker.test' } }, 403],
		[{ headers: { ...headers, Authorization: '' } }, 401],
		[{ headers: { ...headers, 'Content-Type': 'text/plain' } }, 415],
		[{ body: ' '.repeat(2049) }, 413]
	] as [RequestInit, number][]) {
		expect((await post(command, init)).status).toBe(status); expect(calls).toHaveLength(0);
	}
	config.invitationLimit.limit = async () => ({ success: false });
	expect((await post()).status).toBe(429); expect(calls).toHaveLength(0);
});
