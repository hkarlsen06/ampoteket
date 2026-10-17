/**
 * Staff help directory, purchase recovery, revocation and password links in the
 * real admin pages. checkout-proof calls `exerciseAdminHelp` with its own
 * lifecycle; `./scripts/test-web.sh --admin-help` runs it on its own.
 */
import { firefox, expect, type BrowserContext, type Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { mkdir } from 'node:fs/promises';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../convex/_generated/api';
import { captureFailure, fieldLabel, passwordLink, post, proofEnvironment, signIn as signInAs, type Email } from './web-proof/harness';
import { interceptConvex } from './web-proof/convex-socket';
import { en } from '../src/lib/i18n/en';
import { nb } from '../src/lib/i18n/nb';

type Environment = Awaited<ReturnType<typeof proofEnvironment>>;
export type ConvexSocket = Awaited<ReturnType<typeof interceptConvex>>;
export type AdminHelpOptions = {
	context: BrowserContext; origin: string; convexUrl: string;
	/** An active staff member and a signed-in user without membership, both with `password`. */
	staffEmail: string; nonstaffEmail: string; password: string;
	/** An unregistered guest checkout and the request ID that prepared it; `context` holds its checkout cookie. */
	checkoutId: string; requestId: string;
	fixtures: Environment['fixtures'];
	/** Installed on `context` before its first page; without it one is installed here, before this proof's pages open. */
	convex?: ConvexSocket;
	/** Both or neither: send an invitation as staff, and read the newest password link sent to an address. */
	invite?: (email: string) => Promise<void>;
	readPasswordLink?: (email: string) => Promise<string>;
};

/** `invite`/`readPasswordLink` for AdminHelpOptions: `members:invite` as `staffEmail`, links from the harness outbox (call startEmail() first). */
export function passwordEmail(environment: Pick<Environment, 'convexUrl' | 'outbox' | 'secrets' | 'password'>, staffEmail: string) {
	const { convexUrl, outbox, secrets, password } = environment;
	const read = new Set<Email>();
	async function invite(email: string) {
		const client = new ConvexHttpClient(convexUrl, { logger: false });
		const { token } = await client.action(api.session.signIn, { email: staffEmail, password });
		secrets.push(token);
		client.setAuth(token);
		const result = await client.action(api.members.invite, { requestId: crypto.randomUUID(), email, displayName: 'Invited proof volunteer',
			locale: 'en', targetId: null, targetActive: null });
		assert.equal(result.status, 'invited');
	}
	async function readPasswordLink(email: string) {
		for (let attempt = 0; attempt < 100; attempt++) {
			const message = outbox.findLast((candidate) => candidate.to.includes(email) && !read.has(candidate));
			if (message) {
				read.add(message);
				const link = passwordLink(message);
				secrets.push(link.searchParams.get('token_hash')!);
				return link.href;
			}
			await Bun.sleep(100);
		}
		throw new Error('No password email reached the disposable outbox');
	}
	return { invite, readPasswordLink };
}

export async function exerciseAdminHelp(options: AdminHelpOptions) {
	const { context, origin, staffEmail, nonstaffEmail, password, checkoutId, requestId, fixtures } = options;
	const convex = options.convex ?? await interceptConvex(context);
	const page = await context.newPage();
	const visitor = await context.newPage();
	const beforeCookies = await context.cookies(origin);
	const checkoutCookie = beforeCookies.find((cookie) => cookie.name === '__Host-amp_checkout');
	if (!checkoutCookie) throw new Error('Admin proof requires an initialized guest checkout cookie');
	const [staffUser] = await fixtures.rows<{ auth_user_id: string }>('users', { email: staffEmail });
	const membership = { auth_user_id: staffUser.auth_user_id };
	const [staffMember] = await fixtures.rows<{ id: string }>('staff_members', membership);
	const open = (path: string) => page.goto(`${origin}/en${path}`);
	const signIn = (email: string, currentPassword = password) => signInAs(page, origin, email, currentPassword);
	async function helpVisible(name: string, visible: boolean) {
		await visitor.goto(`${origin}/en/contact`);
		const entry = visitor.getByRole('heading', { name, exact: true });
		if (visible) await expect(entry).toBeVisible(); else await expect(entry).toHaveCount(0);
	}
	const artifacts = 'test-results/checkout';
	await mkdir(artifacts, { recursive: true });
	async function inspectGeometry(candidate: Page, filename: string, keyboardTarget: string) {
		const overflow = await candidate.evaluate(() => {
			if (document.documentElement.scrollWidth <= innerWidth) return [];
			const W = document.documentElement.clientWidth;
			return Array.from(document.querySelectorAll<HTMLElement>('body *')).filter(el => el.getBoundingClientRect().right > W + 0.5)
				.slice(0, 8).map(el => `${el.tagName}[${el.getAttribute('data-slot') ?? ''}] ${el.className.toString().slice(0, 80)} w=${Math.round(el.getBoundingClientRect().width)}`);
		});
		if (overflow.length) await candidate.screenshot({ path: `${artifacts}/${filename}-overflow.png`, fullPage: true });
		expect(overflow, `Horizontal overflow on ${filename}`).toEqual([]);
		// A filled field already owns focus. Leave it with the keyboard and return
		// directly; cycling through the entire page can leave web content for browser chrome.
		const initiallyFocused = await candidate.evaluate((selector) => Boolean(document.activeElement?.matches(selector)), keyboardTarget);
		if (initiallyFocused) await candidate.keyboard.press('Shift+Tab');
		let reached = false;
		const focusTrail: { tag: string | null; id: string | null; name: string | null; type: string | null }[] = [];
		for (let steps = 0; steps < (initiallyFocused ? 1 : 60); steps++) {
			await candidate.keyboard.press('Tab');
			const current = await candidate.evaluate((selector) => {
				const active = document.activeElement;
				return { reached: Boolean(active?.matches(selector)), tag: active?.tagName ?? null,
					id: active?.id ?? null, name: active?.getAttribute('name') ?? null, type: active?.getAttribute('type') ?? null };
			}, keyboardTarget);
			reached = current.reached;
			focusTrail.push({ tag: current.tag, id: current.id, name: current.name, type: current.type });
			if (reached) break;
		}
		if (!reached) {
			await candidate.screenshot({ path: `${artifacts}/${filename}-focus-failure.png`, fullPage: true });
			throw new Error(`Keyboard did not reach ${keyboardTarget} (${filename}); initially focused: ${initiallyFocused}; focus identifiers: ${JSON.stringify(focusTrail.slice(-12))}`);
		}
		const focus = await candidate.evaluate(() => {
			const active = document.activeElement as HTMLElement;
			const style = getComputedStyle(active);
			const rect = active.getBoundingClientRect();
			let unclipped = rect.left >= 4 && rect.right <= innerWidth - 4;
			for (let parent = active.parentElement; parent; parent = parent.parentElement) {
				const css = getComputedStyle(parent);
				if (['hidden', 'clip', 'scroll', 'auto'].includes(css.overflowX) || ['hidden', 'clip', 'scroll', 'auto'].includes(css.overflowY)) {
					const edge = parent.getBoundingClientRect();
					if (rect.left - 4 < edge.left || rect.right + 4 > edge.right || rect.top - 4 < edge.top || rect.bottom + 4 > edge.bottom) unclipped = false;
				}
			}
			return { visible: active.matches(':focus-visible'), outline: Number.parseFloat(style.outlineWidth) >= 2 && style.outlineStyle !== 'none', unclipped };
		});
		expect(focus).toEqual({ visible: true, outline: true, unclipped: true });
		await candidate.screenshot({ path: `${artifacts}/${filename}.png`, fullPage: true });
	}
	async function operationalGeometry(contactName: string, reason: string) {
		// A separate tab preserves the initiating tab's frozen retry payload and state.
		const geometry = await context.newPage();
		for (const locale of ['nb', 'en'] as const) for (const colorScheme of ['light', 'dark'] as const) for (const width of [360, 1280]) {
			const prefix = locale === 'nb' ? '' : '/en';
			const suffix = `${locale}-${colorScheme}-${width}`;
			await geometry.emulateMedia({ colorScheme }); await geometry.setViewportSize({ width, height: 900 });
			await geometry.goto(`${origin}${prefix}/contact`);
			await expect(geometry.getByRole('heading', { name: contactName, exact: true })).toBeVisible();
			await inspectGeometry(geometry, `admin-public-help-${suffix}`, 'main a[href^="mailto:"]');
			await geometry.goto(`${origin}${prefix}/admin/contacts`);
			await geometry.getByRole('button', { name: `${(locale === 'nb' ? nb : en).admin.edit} ${contactName}`, exact: true }).click();
			await expect(geometry.getByLabel(fieldLabel((locale === 'nb' ? nb : en).admin.contactName))).toHaveValue(contactName);
			await inspectGeometry(geometry, `admin-help-editor-${suffix}`, 'main input');
			await geometry.goto(`${origin}${prefix}/admin/purchases`);
			await geometry.getByLabel(fieldLabel((locale === 'nb' ? nb : en).admin.reference)).fill(requestId);
			await geometry.getByRole('button', { name: (locale === 'nb' ? nb : en).admin.lookup, exact: true }).click();
			await expect(geometry.getByText((locale === 'nb' ? nb : en).admin.unregistered, { exact: true })).toBeVisible();
			await geometry.getByLabel(fieldLabel((locale === 'nb' ? nb : en).admin.reason)).fill(reason);
			await inspectGeometry(geometry, `admin-recovery-${suffix}`, 'main textarea');
		}
		await geometry.close();
	}
	async function authGeometry() {
		const geometry = await context.newPage();
		for (const locale of ['nb', 'en'] as const) for (const colorScheme of ['light', 'dark'] as const) for (const width of [360, 1280]) {
			const prefix = locale === 'nb' ? '' : '/en';
			await geometry.emulateMedia({ colorScheme }); await geometry.setViewportSize({ width, height: 900 });
			for (const route of ['login', 'password']) {
				await geometry.goto(`${origin}${prefix}/admin/${route}`);
				await expect(geometry.getByLabel(fieldLabel((locale === 'nb' ? nb : en).admin.email))).toBeVisible();
				await inspectGeometry(geometry, `admin-${route}-${locale}-${colorScheme}-${width}`, 'main input');
			}
		}
		await geometry.close();
	}
	// Sign-in verifies a bcrypt hash in a mutation; a loaded test machine needs longer than the default.
	const signedInTimeout = { timeout: 30_000 };
	await signIn(nonstaffEmail);
	await expect(page.getByText(en.admin.noAccess, { exact: true })).toBeVisible(signedInTimeout);
	await page.getByRole('button', { name: 'Sign out', exact: true }).click();
	await signIn(staffEmail);
	await expect(page.getByRole('heading', { name: en.admin.overview, exact: true })).toBeVisible(signedInTimeout);

	// Real audited insert, publication and edit, using guarded original revisions.
	await open('/admin/contacts');
	await page.getByRole('button', { name: 'New contact', exact: true }).click();
	const initialName = `Checkout proof volunteer ${'Longvolunteercontactname'.repeat(3)} ${crypto.randomUUID().slice(0, 8)}`;
	const recoveryReason = 'Disposable browser proof: the buyer identified the original checkout from its reference, saved items, saved prices and time. '.repeat(8).trim();
	await page.getByLabel(fieldLabel('Display name')).fill(initialName);
	await page.getByLabel(fieldLabel('Email (optional)')).fill('checkout-proof@example.invalid');
	await page.getByLabel(fieldLabel('Show this contact on the public contact page')).check();
	await page.getByRole('button', { name: 'Save contact', exact: true }).click();
	await expect(page.getByText(en.admin.saved, { exact: true })).toBeVisible();
	await helpVisible(initialName, true);
	await operationalGeometry(initialName, recoveryReason);
	await page.getByLabel(fieldLabel('Display name')).fill(`${initialName} updated`);
	await page.getByRole('button', { name: 'Save contact', exact: true }).click();
	await expect(page.getByText(en.admin.saved, { exact: true })).toBeVisible();
	await helpVisible(`${initialName} updated`, true);
	await page.getByLabel(fieldLabel('Show this contact on the public contact page')).uncheck();
	await page.getByRole('button', { name: 'Save contact', exact: true }).click();
	await expect(page.getByText(en.admin.saved, { exact: true })).toBeVisible();
	await helpVisible(`${initialName} updated`, false);

	// Two real browser forms keep their shown revisions; the loser never overwrites.
	const rival = await context.newPage();
	await rival.goto(`${origin}/en/admin/contacts`);
	await rival.getByRole('button', { name: `Edit ${initialName} updated`, exact: true }).click();
	await page.getByLabel(fieldLabel('Display name')).fill(`${initialName} winner`);
	await page.getByRole('button', { name: 'Save contact', exact: true }).click();
	await expect(page.getByText(en.admin.saved, { exact: true })).toBeVisible();
	await rival.getByLabel(fieldLabel('Display name')).fill(`${initialName} stale`);
	await rival.getByRole('button', { name: 'Save contact', exact: true }).click();
	await expect(rival.getByText(en.admin.contactStale, { exact: true })).toBeVisible();
	await expect(rival.getByRole('button', { name: 'Save contact', exact: true })).toBeDisabled();
	await rival.getByRole('button', { name: en.admin.reviewContact, exact: true }).click();
	await expect(rival.getByLabel(fieldLabel('Display name'))).toHaveValue(`${initialName} stale`);
	await rival.getByRole('button', { name: en.admin.reviewedContact, exact: true }).click();
	await rival.getByRole('button', { name: 'Save contact', exact: true }).click();
	await expect(rival.getByText(en.admin.saved, { exact: true })).toBeVisible();
	await expect(rival.getByLabel(fieldLabel('Display name'))).toHaveValue(`${initialName} stale`);

	await rival.close();

	await open('/admin/purchases');
	await page.getByLabel(fieldLabel(en.admin.reference)).fill(requestId);
	await page.getByRole('button', { name: en.admin.lookup, exact: true }).click();
	await expect(page.getByText(en.admin.unregistered, { exact: true })).toBeVisible();
	await page.getByLabel(fieldLabel('Reason')).fill(recoveryReason);
	await page.getByRole('checkbox').check();
	// The recovery commits, but the page gets an outcome without a code: unknown.
	const sentBefore = convex.mutations.length;
	convex.withhold('checkout:recover');
	await page.getByRole('button', { name: 'Register the original purchase', exact: true }).click();
	await expect(page.getByText(en.admin.recoveryUnknown, { exact: true })).toBeVisible();
	expect(await fixtures.rows('sales', { checkout_id: checkoutId })).toHaveLength(1);
	const frozen = await page.evaluate(() => JSON.parse(sessionStorage.getItem('ampoteket:admin-recovery:v1') ?? 'null'));
	expect(frozen).toEqual({ userId: staffUser.auth_user_id, requestId: frozen.requestId, checkoutId, reason: recoveryReason });
	await page.getByRole('button', { name: en.admin.retryRecovery, exact: true }).click();
	await expect(page.getByRole('button', { name: en.admin.retryRecovery, exact: true })).toHaveCount(0);
	await expect(page.getByText(en.admin.registered, { exact: true }).first()).toBeVisible();
	expect(await page.evaluate(() => sessionStorage.getItem('ampoteket:admin-recovery:v1'))).toBeNull();
	const commands = convex.sent('checkout:recover', sentBefore);
	expect(commands).toHaveLength(2);
	expect(commands[1]).toEqual(commands[0]);
	expect(commands[0].args).toEqual({ requestId: frozen.requestId, checkoutId, reason: recoveryReason });
	const sales = await fixtures.rows<{ recovered_by: string | null; recovery_reason: string | null }>('sales', { checkout_id: checkoutId });
	expect(sales).toHaveLength(1);
	expect(sales[0]).toMatchObject({ recovered_by: staffMember.id, recovery_reason: recoveryReason });
	await open('/admin/purchases');
	await page.getByLabel(fieldLabel(en.admin.reference)).fill(checkoutId);
	await page.getByRole('button', { name: en.admin.lookup, exact: true }).click();
	await expect(page.getByText(en.admin.registered, { exact: true }).first()).toBeVisible();
	await expect(page.getByRole('button', { name: 'Register the original purchase', exact: true })).toHaveCount(0);

	// Private operational content disappears when the active membership is revoked;
	// membership is a live subscription, so both changes arrive without any page event.
	await fixtures.patch('staff_members', membership, { is_active: false });
	await expect(page.getByText(en.admin.revoked, { exact: true })).toBeVisible();
	await expect(page.getByRole('heading', { name: en.admin.savedCheckout, exact: true })).toHaveCount(0);
	await fixtures.patch('staff_members', membership, { is_active: true });
	await expect(page.getByRole('heading', { name: en.admin.recoveryHeading, exact: true })).toBeVisible();
	await expect(page.getByText(en.admin.revoked, { exact: true })).toHaveCount(0);
	await page.getByRole('button', { name: 'Sign out', exact: true }).click();
	await expect(page.getByLabel(fieldLabel('Email address'))).toBeVisible();
	await expect(page.getByLabel(fieldLabel('Password'))).toBeVisible();
	await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
	await expect(page.getByRole('heading', { name: en.admin.recoveryHeading, exact: true })).toHaveCount(0);
	expect((await context.cookies(origin)).find((cookie) => cookie.name === '__Host-amp_checkout')?.value).toBe(checkoutCookie.value);

	await authGeometry();

	// Open the emailed link so the rendered template and the password page agree.
	if (options.invite && options.readPasswordLink) {
		for (const type of ['recovery', 'invite'] as const) {
			const email = type === 'recovery' ? nonstaffEmail : `checkout-invite-${crypto.randomUUID()}@example.test`;
			if (type === 'invite') await options.invite(email);
			else {
				await page.goto(`${origin}/en/admin/password?next=%2Fadmin`);
				await page.getByLabel(fieldLabel('Email address')).fill(email);
				await page.getByRole('button', { name: 'Send password link', exact: true }).click();
				await expect(page.getByText('If the account exists, you will receive an email with a password link.', { exact: true })).toBeVisible();
			}
			const link = new URL(await options.readPasswordLink(email));
			expect([link.origin, link.pathname, link.searchParams.get('next'), link.searchParams.get('type')]).toEqual([origin, '/en/admin/password', '/admin', type]);
			expect(link.searchParams.get('token_hash')).toMatch(/^[a-f0-9]{64}$/);
			const changedPassword = `${password}-${type}`;
			await page.goto(link.href);
			// The page discards the link's token once hydrated, which may be after the load event.
			await expect(page).toHaveURL(`${origin}/en/admin/password`);
			await page.getByRole('button', { name: 'Continue', exact: true }).click();
			await expect(page.getByLabel(fieldLabel('New password'))).toBeVisible();
			await page.getByLabel(fieldLabel('New password')).fill(changedPassword);
			await page.getByLabel(fieldLabel('Repeat new password')).fill(changedPassword);
			await page.getByRole('button', { name: 'Save password', exact: true }).click();
			await expect(page.getByText(en.admin.saved, { exact: true })).toBeVisible(signedInTimeout);
			await page.getByRole('link', { name: en.admin.continueToAdmin, exact: true }).click();
			// An invitation grants membership before the email is sent; a reset grants nothing.
			const signedIn = () => type === 'invite'
				? page.getByRole('heading', { name: en.admin.overview, exact: true }) : page.getByText(en.admin.noAccess, { exact: true });
			await expect(signedIn()).toBeVisible();
			await page.getByRole('button', { name: 'Sign out', exact: true }).click();
			await signIn(email, changedPassword);
			await expect(signedIn()).toBeVisible(signedInTimeout);
			await page.getByRole('button', { name: 'Sign out', exact: true }).click();
			// The link is single-use.
			await page.goto(link.href);
			await page.getByRole('button', { name: 'Continue', exact: true }).click();
			await expect(page.getByText(en.admin.invalidCallback, { exact: true })).toBeVisible();
		}
	}

	// Hostile return destinations and callback material cannot survive in page metadata.
	await page.goto(`${origin}/en/admin/password?code=bad&next=https%3A%2F%2Fevil.invalid#access_token=invalid`);
	await expect(page.getByText(en.admin.invalidCallback, { exact: true })).toBeVisible();
	expect(page.url()).toBe(`${origin}/en/admin/password`);
	await page.close(); await visitor.close();
	return { directory: 'published/edited/unpublished, stale draft reviewed and saved', recovery: 'same frozen command after committed lost response, one sale', auth: 'nonstaff denied, live revocation enforced, guest cookie preserved' };
}

if (import.meta.main) {
	const environment = await proofEnvironment();
	const { directory, origin, convexUrl, password, safe, fixtures, createStaff, createUser, startEmail, startWorker } = environment;
	const staffEmail = 'help-staff@example.test', nonstaffEmail = 'help-nonstaff@example.test';
	await createStaff(staffEmail, 'Help proof volunteer');
	await createUser(nonstaffEmail);
	startEmail();
	const product = '73000000-0000-4000-8000-0000000000a1';
	const now = new Date().toISOString().replace('Z', '000Z');
	await fixtures.insert('products', [{ id: product, code: 'HLP-00001', name_nb: 'Hjelpebevis-motstand', name_en: 'Help proof resistor', description: null,
		category_id: null, bin_id: 'a0000002-0000-4000-8000-000000000001', location_note: null, unit_code: 'pcs', stock_step: '1', sale_step: '1',
		sale_unit_price_nok: '2.5', minimum_stock: '0', datasheet_url: null, purchase_url: null, is_active: true, metadata_revision: 1, created_at: now, updated_at: now }]);
	let context: BrowserContext | undefined;
	const { ready, close } = await startWorker(() => context);
	try {
		await ready();
		context = await firefox.launchPersistentContext(`${directory}/profile`, { headless: true, ignoreHTTPSErrors: false });
		const convex = await interceptConvex(context);
		context.on('page', (tab) => tab.on('console', (message) => {
			if (message.type() === 'error') console.error(`[browser error] ${safe(message.text())}`);
		}));
		// A guest checkout through the Worker's own routes: the cookie, then an unregistered prepare.
		const buyer = await context.newPage();
		await buyer.goto(`${origin}/en/contact`);
		const session = await post(buyer, '/api/checkouts/session');
		assert.equal(session.status, 200);
		const requestId = crypto.randomUUID();
		const body = { request_id: requestId, fingerprint: session.body.fingerprint, items: [{ product_id: product, quantity: '1' }], contact: null };
		// Repeat-safe: an unavailable answer (a slow backend) is retried with the identical body.
		let prepared = await post(buyer, '/api/checkouts/prepare', body);
		for (let attempt = 0; prepared.status === 503 && attempt < 3; attempt++) prepared = await post(buyer, '/api/checkouts/prepare', body);
		assert.equal(prepared.status, 200);
		const checkoutId = prepared.body.checkout_id as string;
		assert.equal((await fixtures.rows('sales', { checkout_id: checkoutId })).length, 0);
		await buyer.close();
		const result = await exerciseAdminHelp({ context, origin, convexUrl, staffEmail, nonstaffEmail, password, checkoutId, requestId, fixtures, convex,
			...passwordEmail(environment, staffEmail) });
		for (const [area, proof] of Object.entries(result)) console.log(`PASS: ${area}: ${proof}`);
		console.log('PASS: rendered invitation and reset links set single-use passwords; invited staff reach admin, reset nonstaff stay denied');
	} catch (error) {
		for (const [index, tab] of (context?.pages() ?? []).entries()) {
			console.error(`Open tab ${index}: ${tab.url()}`);
			await captureFailure(tab, 'test-results/checkout', `admin-help-${index}`);
		}
		const raw = await Bun.file(`${directory}/worker-error.log`).text() + await Bun.file(`${directory}/worker.log`).text();
		const backend = (await Bun.file(`${directory}/convex.log`).text().catch(() => '')).split('\n').filter((line) => /error|fail|timed out/i.test(line));
		if (backend.length) console.error(safe(backend.slice(-20).join('\n')));
		const redacted = safe(raw);
		if (redacted.trim()) console.error(redacted.slice(-4000));
		// Playwright's own dump includes accessibility snapshots, which can hold the filled password.
		console.error(safe(error instanceof Error ? error.stack ?? error.message : String(error)));
		process.exitCode = 1;
	} finally {
		await close();
	}
}
