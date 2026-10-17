/** Real Convex Auth, invitation email (Resend stand-in), built HTTPS Worker and responsive admin page. No hosted services. */
import { strict as assert } from 'node:assert';
import { mkdir } from 'node:fs/promises';
import { firefox, expect as baseExpect, type BrowserContext } from '@playwright/test';
import { resolve } from 'node:path';
import { ConvexHttpClient } from 'convex/browser';
import type { FunctionArgs } from 'convex/server';
import { en } from '../src/lib/i18n/en';
import { nb } from '../src/lib/i18n/nb';
import { identifier } from '../src/lib/api';
import { api, errorCode, type ConvexCaller, type StaffSession } from '../src/lib/convex';
import { readAdminMembers, runMemberCommand } from '../src/lib/admin-members';
import { proofEnvironment, signIn, fieldLabel, fits, captureFailure, passwordLink } from './web-proof/harness';
import { watchConvex } from './web-proof/convex-socket';

// A page load includes the Convex Auth handshake, which a loaded machine can stretch past the 5 s default.
const expect = baseExpect.configure({ timeout: 15_000 });
const { directory, origin, convexUrl, password, secrets, safe, fixtures, createStaff, createUser, startEmail, startWorker } = await proofEnvironment();
const staffEmail = 'access-staff@example.test';
const nonstaffEmail = 'access-nonstaff@example.test';
const disabledEmail = 'access-disabled@example.test';
const { staffId } = await createStaff(staffEmail, 'Access proof operator');
await createUser(nonstaffEmail);
const { staffId: disabledId, authUserId: disabledUserId } = await createStaff(disabledEmail, 'Previous operator', false);
const outbox = startEmail();

const client = () => new ConvexHttpClient(convexUrl, { logger: false });
/** Signs in as the login page does and carries the token like the shared client. */
async function login(email: string): Promise<StaffSession> {
	const signedIn = client();
	const tokens = await signedIn.action(api.session.signIn, { email, password });
	secrets.push(tokens.token, tokens.refreshToken);
	signedIn.setAuth(tokens.token);
	const me = await signedIn.query(api.members.me, {});
	return { client: signedIn, userId: identifier(me?.authUserId) };
}
type Invitation = FunctionArgs<typeof api.members.invite>;
const invite = (caller: ConvexCaller | StaffSession, command: Invitation) =>
	('client' in caller ? caller.client : caller).action(api.members.invite, command);
async function denied(operation: () => Promise<unknown>, code: string) {
	await assert.rejects(operation, (error: unknown) => { assert.equal(errorCode(error), code); return true; });
}
const users = async (email: string) => (await fixtures.rows('users', { email })).length;
const staffAudit = (where: Record<string, unknown>) => fixtures.rows('audit_log', { table_name: 'staff_members', ...where });
/** The single invitation sent to this address, checked down to its single-use link. */
function invitationToken(email: string, locale: 'nb' | 'en') {
	const messages = outbox.filter(message => message.to.includes(email));
	assert.equal(messages.length, 1, 'One invitation per new account');
	assert.match(messages[0].subject, /Invitation/);
	const url = passwordLink(messages[0]);
	assert.equal(url.origin, origin);
	assert.equal(url.pathname, `${locale === 'en' ? '/en' : ''}/admin/password`);
	assert.equal(url.searchParams.get('next'), '/admin');
	assert.equal(url.searchParams.get('type'), 'invite');
	const token = url.searchParams.get('token_hash');
	assert.match(token ?? '', /^[a-f0-9]{64}$/);
	secrets.push(token!);
	return token!;
}

let browser: BrowserContext | undefined;
const { ready, close } = await startWorker(() => browser);
try {
	await ready();

	const staff = await login(staffEmail);
	const nonstaff = await login(nonstaffEmail);
	const disabled = await login(disabledEmail);
	const forbidden: Invitation = { requestId: crypto.randomUUID(), email: 'must-not-exist@example.test', displayName: 'Rejected invite', locale: 'en', targetId: null, targetActive: null };
	await denied(() => invite(client(), forbidden), 'STAFF_REQUIRED');
	await denied(() => invite(nonstaff, forbidden), 'STAFF_REQUIRED');
	await denied(() => invite(disabled, forbidden), 'STAFF_REQUIRED');
	assert.equal(await users('must-not-exist@example.test'), 0);
	assert.equal(outbox.length, 0);
	console.log('PASS: anonymous, nonstaff and disabled callers cannot create an Auth account');

	const invited: { command: Invitation; staffId: string; session: StaffSession }[] = [];
	for (const locale of ['en', 'nb'] as const) {
		const command: Invitation = { requestId: crypto.randomUUID(), email: `access-invite-${locale}@example.test`, displayName: `Invited ${locale}`, locale, targetId: null, targetActive: null };
		const result = await invite(staff, command);
		assert.equal(result.status, 'invited');
		const invitedId = identifier(result.staffId);
		const pending = (await readAdminMembers(staff)).find(member => member.id === invitedId);
		assert.ok(pending?.isActive && !pending.emailConfirmed && pending.email === command.email);
		assert.equal((await staffAudit({ row_id: invitedId, action: 'INSERT', actor_id: staffId, database_role: 'authenticated' })).length, 1);
		// The password page's calls: check the link, then set the password, which consumes it.
		const token = invitationToken(command.email, locale), guest = client();
		assert.deepEqual(await guest.query(api.passwords.checkLink, { token }), { valid: true });
		assert.deepEqual(await guest.mutation(api.passwords.complete, { token, password }), { email: command.email });
		assert.deepEqual(await guest.query(api.passwords.checkLink, { token }), { valid: false });
		await denied(() => guest.mutation(api.passwords.complete, { token, password }), 'INVALID_PASSWORD_LINK');
		const signedIn = await login(command.email);
		assert.equal(signedIn.userId, pending.authUserId, 'Invitation retains the created Auth identity');
		const active = (await readAdminMembers(signedIn)).find(member => member.id === invitedId);
		assert.ok(active?.isActive && active.emailConfirmed, 'New password login can call a staff-only query');
		invited.push({ command, staffId: invitedId, session: signedIn });
	}
	assert.equal((await readAdminMembers(staff)).length, 4, 'Directory lists every membership');
	console.log('PASS: both locales deliver valid single-use invitations; password setup/login grants access and audits the inviter');

	const original = invited[0], sent = outbox.length;
	assert.deepEqual(await invite(staff, original.command), { status: 'existing_account', staffId: original.staffId });
	assert.equal((await fixtures.rows('command_requests', { id: original.command.requestId })).length, 1);
	assert.equal((await staffAudit({ row_id: original.staffId })).length, 1);
	const returning: Invitation = { requestId: crypto.randomUUID(), email: disabledEmail, displayName: 'Returning operator', locale: 'en', targetId: disabledId, targetActive: false };
	assert.deepEqual(await invite(staff, returning), { status: 'existing_account', staffId: disabledId });
	assert.equal(outbox.length, sent, 'A confirmed account is not emailed again');
	const returned = await login(disabledEmail);
	assert.equal(returned.userId, disabledUserId, 'Reactivation retains the Auth identity and password');
	assert.ok((await readAdminMembers(returned)).some(member => member.id === disabledId && member.isActive));
	console.log('PASS: replay keeps its command and audit row; confirmed-account reactivation preserves identity and password');

	await denied(() => runMemberCommand(staff, { kind: 'deactivate', userId: staff.userId, requestId: crypto.randomUUID(), staffId }), 'STAFF_SELF_DEACTIVATION');
	const deactivation = { kind: 'deactivate', userId: staff.userId, requestId: crypto.randomUUID(), staffId: original.staffId } as const;
	assert.equal(await runMemberCommand(staff, deactivation), 'deactivated');
	assert.equal(await runMemberCommand(staff, deactivation), 'deactivated');
	await denied(() => readAdminMembers(original.session), 'STAFF_REQUIRED');
	await denied(() => invite(original.session, forbidden), 'STAFF_REQUIRED');
	await denied(() => invite(staff, original.command), 'INVITATION_SUPERSEDED');
	await denied(() => invite(staff, { ...original.command, requestId: crypto.randomUUID(), targetId: original.staffId, targetActive: true }), 'INVITATION_SUPERSEDED');
	const inactive = (await readAdminMembers(staff)).find(member => member.id === original.staffId);
	assert.equal(inactive?.isActive, false);
	assert.equal((await staffAudit({ row_id: original.staffId, actor_id: staffId, database_role: 'authenticated' })).length, 2);
	assert.equal(await users('must-not-exist@example.test'), 0);
	console.log('PASS: self-deactivation is rejected, revoked sessions lose access, and replay cannot undo later deactivation');
	await fixtures.patch('staff_members', { id: invited[1].staffId },
		{ display_name: 'Frivillig med et langt navn som skal vises uten at knapper flytter seg eller siden ruller sidelengs' });
	browser = await firefox.launchPersistentContext(`${directory}/profile`, { headless: true, ignoreHTTPSErrors: false });
	const socket = await watchConvex(browser);
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
		await expect(page.getByText(disabledEmail, { exact: true })).toBeVisible();
		await name.fill('Preserved draft'); await email.fill('draft@example.test');
		await name.focus();
		const before = await name.boundingBox();
		// The directory is a one-off read on focus, not a live subscription.
		const restore = socket.rule(call => call.path === 'members:list' ? 'fail' : undefined);
		await page.evaluate(() => window.dispatchEvent(new Event('focus')));
		await expect(page.getByText(en.adminMembers.unavailable, { exact: true })).toBeVisible();
		await expect(name).toHaveValue('Preserved draft'); await expect(name).toBeFocused();
		expect(await name.boundingBox()).toEqual(before);
		restore();
		await page.getByRole('button', { name: en.admin.retry, exact: true }).click();
		await expect(page.getByText(en.adminMembers.unavailable, { exact: true })).toHaveCount(0);
		await expect(name).toHaveValue('Preserved draft');
		const returnedRow = page.getByRole('listitem').filter({ hasText: disabledEmail });
		await returnedRow.getByRole('button', { name: en.adminMembers.deactivateNamed('Returning operator'), exact: true }).click();
		// Confirmation is a shared AlertDialog outside the row; it names the person and states the consequence.
		const deactivationDialog = page.getByRole('alertdialog', { name: en.adminMembers.deactivateNamed('Returning operator'), exact: true });
		await expect(deactivationDialog).toHaveAccessibleDescription(en.adminMembers.deactivateHint('Returning operator'));
		await deactivationDialog.getByRole('button', { name: en.adminMembers.confirmDeactivate, exact: true }).click();
		await expect(returnedRow.getByText(en.adminMembers.inactive, { exact: true })).toBeVisible();
		await expect(returnedRow.getByText(en.adminMembers.feedback.deactivated, { exact: true })).toBeVisible();
		// The deactivate button is gone once confirmed, so focus lands on the person's name.
		await expect(returnedRow.getByText('Returning operator', { exact: true })).toBeFocused();
		await returnedRow.getByRole('button', { name: en.adminMembers.reactivate, exact: true }).click();
		await expect(returnedRow.getByText(en.adminMembers.active, { exact: true })).toBeVisible();
		await expect(returnedRow.getByText(en.adminMembers.feedback.existing_account, { exact: true })).toBeVisible();
		await expect(name).toHaveValue('Preserved draft');
		assert.equal(socket.of('members:deactivate').length, 1);
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
