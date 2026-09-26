/** Real Auth, Mailpit, built HTTPS Worker and responsive admin page. No hosted services. */
import { strict as assert } from 'node:assert';
import { mkdir } from 'node:fs/promises';
import { firefox, expect, type BrowserContext } from '@playwright/test';
import { resolve } from 'node:path';
import { en } from '../src/lib/i18n/en';
import { nb } from '../src/lib/i18n/nb';
import { ApiError, identifier, object, requestApiJson } from '../src/lib/api';
import { staffRequest, type StaffSession } from '../src/lib/admin-api';
import { readAdminMembers } from '../src/lib/admin-members';
import { proofEnvironment, signIn, fieldLabel, fits, captureFailure } from './web-proof/harness';

const { directory, origin, api, publicKey, password, secrets, safe, ca, sql, createUser, startWorker } = await proofEnvironment();
const mailpitPort = Number(process.argv[5]);
assert.ok(Number.isInteger(mailpitPort) && mailpitPort > 0 && mailpitPort <= 65535, 'Use scripts/test-web.sh --admins');
const config = { url: api.origin, publishableKey: publicKey };
const staffEmail = 'access-staff@example.test';
const nonstaffEmail = 'access-nonstaff@example.test';
const disabledEmail = 'access-disabled@example.test';
const staffUserId = await createUser(staffEmail);
await createUser(nonstaffEmail);
const disabledUserId = await createUser(disabledEmail);
await sql(`INSERT INTO app.staff_members(auth_user_id,display_name,is_active) VALUES
 ('${staffUserId}', 'Access proof operator', true), ('${disabledUserId}', 'Previous operator', false);`);
const staffId = identifier(await sql(`SELECT id FROM app.staff_members WHERE auth_user_id='${staffUserId}'`));
const disabledId = identifier(await sql(`SELECT id FROM app.staff_members WHERE auth_user_id='${disabledUserId}'`));

async function auth(path: string, body: unknown, token?: string, method = 'POST') {
	return object(await requestApiJson(`${api.origin}/auth/v1/${path}`, {
		method, headers: { apikey: publicKey, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(body)
	}));
}
function session(value: Record<string, unknown>): StaffSession {
	assert.equal(typeof value.access_token, 'string', 'Auth returns an access token');
	const token = value.access_token as string;
	secrets.push(token);
	return { config, token, userId: identifier(object(value.user).id) };
}
async function login(email: string) { return session(await auth('token?grant_type=password', { email, password })); }
type Invitation = { requestId: string; email: string; displayName: string; locale: 'nb' | 'en'; targetId: string | null; targetActive: boolean | null };
function invite(token: string | undefined, body: Invitation) {
	return requestApiJson(`${origin}/api/admin/invitations`, {
		method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json',
			...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body)
	}, (input, init) => fetch(input, { ...init, tls: { ca } }), 60_000);
}
async function denied(operation: () => Promise<unknown>, code: string, status?: number) {
	await assert.rejects(operation, (error: unknown) => {
		assert.ok(error instanceof ApiError, 'Rejected through the HTTP API');
		if (status !== undefined) assert.equal(error.status, status);
		const body = object(error.body);
		assert.equal(body.error ?? body.message, code);
		return true;
	});
}
async function invitationToken(email: string, locale: 'nb' | 'en') {
	const mailbox = `http://127.0.0.1:${mailpitPort}/view/latest.html?query=${encodeURIComponent(`to:${email}`)}`;
	for (let attempt = 0; attempt < 100; attempt++) {
		const response = await fetch(mailbox);
		if (response.ok) {
			const html = await response.text();
			const link = html.match(/<a href="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
			assert.ok(link, 'Rendered invitation contains a password link');
			const url = new URL(link);
			assert.equal(url.origin, origin);
			assert.equal(url.pathname, `${locale === 'en' ? '/en' : ''}/admin/password`);
			assert.equal(url.searchParams.get('next'), '/admin');
			assert.equal(url.searchParams.get('type'), 'invite');
			const token = url.searchParams.get('token_hash');
			assert.match(token ?? '', /^(?:pkce_)?[a-f0-9]{32,256}$/);
			secrets.push(token!);
			return token!;
		}
		assert.equal(response.status, 404, 'Mailpit mailbox read');
		await Bun.sleep(100);
	}
	throw new Error('Invitation did not reach local Mailpit');
}

let browser: BrowserContext | undefined;
const { ready, close } = await startWorker(() => browser);
try {
	await ready();

	const staff = await login(staffEmail);
	const nonstaff = await login(nonstaffEmail);
	const disabled = await login(disabledEmail);
	const forbidden: Invitation = { requestId: crypto.randomUUID(), email: 'must-not-exist@example.test', displayName: 'Rejected invite', locale: 'en', targetId: null, targetActive: null };
	await denied(() => invite(undefined, forbidden), 'STAFF_REQUIRED', 401);
	await denied(() => invite(nonstaff.token, forbidden), 'STAFF_REQUIRED', 403);
	await denied(() => invite(disabled.token, forbidden), 'STAFF_REQUIRED', 403);
	assert.equal(await sql("SELECT count(*) FROM auth.users WHERE email='must-not-exist@example.test'"), '0');
	console.log('PASS: anonymous, nonstaff and disabled callers cannot create an Auth account');

	const invited: { command: Invitation; staffId: string; session: StaffSession }[] = [];
	for (const locale of ['en', 'nb'] as const) {
		const command: Invitation = { requestId: crypto.randomUUID(), email: `access-invite-${locale}@example.test`, displayName: `Invited ${locale}`, locale, targetId: null, targetActive: null };
		const result = object(await invite(staff.token, command));
		assert.equal(result.status, 'invited');
		const invitedId = identifier(result.staffId);
		const pending = (await readAdminMembers(staff)).find(member => member.id === invitedId);
		assert.ok(pending?.isActive && !pending.emailConfirmed && pending.email === command.email);
		assert.equal(await sql(`SELECT count(*) FROM app.audit_log WHERE table_name='staff_members'
 AND row_key->>'id'='${invitedId}' AND action='INSERT' AND actor_id='${staffId}' AND database_role='authenticated'`), '1');
		const tokenHash = await invitationToken(command.email, locale);
		const verified = session(await auth('verify', { type: 'invite', token_hash: tokenHash }));
		assert.equal(verified.userId, pending.authUserId, 'Invitation retains the created Auth identity');
		await auth('user', { password }, verified.token, 'PUT');
		const signedIn = await login(command.email);
		assert.equal(signedIn.userId, verified.userId);
		const active = (await readAdminMembers(signedIn)).find(member => member.id === invitedId);
		assert.ok(active?.isActive && active.emailConfirmed, 'New password login can call a staff-only RPC');
		invited.push({ command, staffId: invitedId, session: signedIn });
	}
	assert.equal((await readAdminMembers(staff)).length, 4, 'Directory is complete despite a two-row API cap');
	console.log('PASS: both locales deliver valid invitations; password setup/login grants access and audits the inviter');

	const original = invited[0];
	assert.deepEqual(await invite(staff.token, original.command), { status: 'existing_account', staffId: original.staffId });
	assert.equal(await sql(`SELECT count(*) FROM app.command_requests WHERE id='${original.command.requestId}'`), '1');
	assert.equal(await sql(`SELECT count(*) FROM app.audit_log WHERE table_name='staff_members' AND row_key->>'id'='${original.staffId}'`), '1');
	const returning: Invitation = { requestId: crypto.randomUUID(), email: disabledEmail, displayName: 'Returning operator', locale: 'en', targetId: disabledId, targetActive: false };
	assert.deepEqual(await invite(staff.token, returning), { status: 'existing_account', staffId: disabledId });
	const returned = await login(disabledEmail);
	assert.equal(returned.userId, disabledUserId, 'Reactivation retains the Auth identity and password');
	assert.ok((await readAdminMembers(returned)).some(member => member.id === disabledId && member.isActive));
	console.log('PASS: replay keeps its command and audit row; confirmed-account reactivation preserves identity and password');

	await denied(() => staffRequest(staff, 'rpc/amp_deactivate_staff', {}, {
		p_request_id: crypto.randomUUID(), p_staff_id: staffId
	}), 'STAFF_SELF_DEACTIVATION');
	const deactivation = { p_request_id: crypto.randomUUID(), p_staff_id: original.staffId };
	assert.equal(await staffRequest(staff, 'rpc/amp_deactivate_staff', {}, deactivation), original.staffId);
	assert.equal(await staffRequest(staff, 'rpc/amp_deactivate_staff', {}, deactivation), original.staffId);
	await denied(() => readAdminMembers(original.session), 'STAFF_REQUIRED');
	await denied(() => invite(original.session.token, forbidden), 'STAFF_REQUIRED', 403);
	await denied(() => invite(staff.token, original.command), 'INVITATION_SUPERSEDED', 409);
	await denied(() => invite(staff.token, { ...original.command, requestId: crypto.randomUUID(), targetId: original.staffId, targetActive: true }), 'INVITATION_SUPERSEDED', 409);
	const inactive = (await readAdminMembers(staff)).find(member => member.id === original.staffId);
	assert.equal(inactive?.isActive, false);
	assert.equal(await sql(`SELECT count(*) FROM app.audit_log WHERE table_name='staff_members'
 AND row_key->>'id'='${original.staffId}' AND actor_id='${staffId}' AND database_role='authenticated'`), '2');
	assert.equal(await sql("SELECT count(*) FROM auth.users WHERE email='must-not-exist@example.test'"), '0');
	console.log('PASS: self-deactivation is rejected, revoked JWTs lose access, and replay cannot undo later deactivation');
	await sql(`UPDATE app.staff_members SET display_name='Frivillig med et langt navn som skal vises uten at knapper flytter seg eller siden ruller sidelengs'
 WHERE id='${invited[1].staffId}';`);
	browser = await firefox.launchPersistentContext(`${directory}/profile`, { headless: true, ignoreHTTPSErrors: false });
	const page = await browser.newPage();
	const artifacts = resolve('test-results/admins');
	await mkdir(artifacts, { recursive: true });
	const diagnostics: string[] = [];
	page.on('pageerror', error => diagnostics.push(error.message));
	try {
		await signIn(page, origin, staffEmail, password);
		await expect(page.getByRole('heading', { name: en.admin.overview, exact: true })).toBeVisible();
		await page.goto(`${origin}/en/admin/admins`);
		await expect(page.getByRole('heading', { name: en.adminMembers.heading, exact: true })).toBeVisible();
		await expect(page.getByText(staffEmail, { exact: true }).last()).toBeVisible();
		for (const [locale, messages] of [['nb', nb], ['en', en]] as const) {
			await page.goto(`${origin}${locale === 'en' ? '/en' : ''}/admin/admins`);
			await expect(page.getByRole('heading', { name: messages.adminMembers.heading, exact: true })).toBeVisible();
			for (const width of [360, 1280]) {
				await page.setViewportSize({ width, height: 800 });
				for (const colorScheme of ['light', 'dark'] as const) {
					await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
					await fits(page);
					await page.screenshot({ path: `${artifacts}/${locale}-${width}-${colorScheme}.png`, fullPage: true });
				}
			}
		}
		const name = page.getByLabel(fieldLabel(en.adminMembers.name), { exact: true });
		const email = page.getByLabel(fieldLabel(en.admin.email), { exact: true });
		await name.fill('Preserved draft'); await email.fill('draft@example.test');
		await name.focus();
		const before = await name.boundingBox();
		const directoryRead = `${api.origin}/rest/v1/rpc/amp_list_staff`;
		await page.route(directoryRead, route => route.abort('failed'));
		await page.evaluate(() => window.dispatchEvent(new Event('focus')));
		await expect(page.getByText(en.adminMembers.unavailable, { exact: true })).toBeVisible();
		await expect(name).toHaveValue('Preserved draft'); await expect(name).toBeFocused();
		expect(await name.boundingBox()).toEqual(before);
		await page.unroute(directoryRead);
		await page.getByRole('button', { name: en.admin.retry, exact: true }).click();
		await expect(page.getByText(en.adminMembers.unavailable, { exact: true })).toHaveCount(0);
		await expect(name).toHaveValue('Preserved draft');
		const returnedRow = page.getByRole('listitem').filter({ hasText: disabledEmail });
		await returnedRow.getByRole('button', { name: en.adminMembers.deactivateNamed('Returning operator'), exact: true }).click();
		await returnedRow.getByRole('button', { name: en.adminMembers.confirmDeactivate, exact: true }).click();
		await expect(returnedRow.getByText(en.adminMembers.inactive, { exact: true })).toBeVisible();
		await expect(returnedRow.getByText(en.adminMembers.feedback.deactivated, { exact: true })).toBeVisible();
		await returnedRow.getByRole('button', { name: en.adminMembers.close, exact: true }).click();
		await expect(returnedRow.getByText('Returning operator', { exact: true })).toBeFocused();
		await returnedRow.getByRole('button', { name: en.adminMembers.reactivate, exact: true }).click();
		await expect(returnedRow.getByText(en.adminMembers.active, { exact: true })).toBeVisible();
		await expect(returnedRow.getByText(en.adminMembers.feedback.existing_account, { exact: true })).toBeVisible();
		await expect(name).toHaveValue('Preserved draft');
		const ownRow = page.getByRole('listitem').filter({ hasText: staffEmail });
		await expect(ownRow.getByRole('button', { name: /Deactivate/ })).toHaveCount(0);
		expect(diagnostics).toEqual([]);
		console.log('PASS: phone/desktop, both locales/themes, preserved draft/focus on failed refresh, deactivation and reactivation UI');
	} catch (error) {
		await captureFailure(page, artifacts, 'admins'); throw error;
	}

} catch (error) {
	console.error(safe(error instanceof Error ? error.stack ?? error.message : String(error)));
	process.exitCode = 1;
} finally {
	await close();
}
