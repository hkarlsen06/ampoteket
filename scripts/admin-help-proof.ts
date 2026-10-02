import { expect, type BrowserContext, type Page } from '@playwright/test';
import { fieldLabel, signIn as signInAs } from './web-proof/harness';
import { mkdir } from 'node:fs/promises';
import { en } from '../src/lib/i18n/en';
import { nb } from '../src/lib/i18n/nb';

type ProofOptions = {
	context: BrowserContext; origin: string; api: string; publicKey: string;
	staffEmail: string; nonstaffEmail: string; password: string; checkoutId: string; requestId: string;
	sql: (statement: string) => Promise<string> | string;
	inviteAuthUser?: (email: string) => Promise<void>;
	readAuthEmail?: (type: 'invite' | 'recovery', email: string) => Promise<string>;
};

/** Uses the lifecycle and real Auth/database identities provided by checkout-proof. */
export async function exerciseAdminHelp(options: ProofOptions) {
	const { context, origin, api, staffEmail, nonstaffEmail, password, checkoutId, requestId, sql } = options;
	const page = await context.newPage();
	const visitor = await context.newPage();
	const beforeCookies = await context.cookies(origin);
	const checkoutCookie = beforeCookies.find((cookie) => cookie.name === '__Host-amp_checkout');
	if (!checkoutCookie) throw new Error('Admin proof requires an initialized guest checkout cookie');
	const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
	const membershipFilter = `auth_user_id=(SELECT id FROM auth.users WHERE email=${literal(staffEmail)})`;
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
			await geometry.goto(`${origin}${prefix}/admin/help`);
			await geometry.getByRole('button', { name: (locale === 'nb' ? nb : en).admin.editContact(contactName), exact: true }).click();
			await expect(geometry.getByLabel(fieldLabel((locale === 'nb' ? nb : en).admin.contactName))).toHaveValue(contactName);
			await inspectGeometry(geometry, `admin-help-editor-${suffix}`, 'main input');
			await geometry.goto(`${origin}${prefix}/admin/privacy`);
			await geometry.getByLabel(fieldLabel((locale === 'nb' ? nb : en).admin.reference)).fill(requestId);
			await geometry.getByRole('button', { name: (locale === 'nb' ? nb : en).admin.lookup, exact: true }).click();
			await expect(geometry.getByText(checkoutId, { exact: true })).toBeVisible();
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
	await signIn(nonstaffEmail);
	await expect(page.getByText(en.admin.noAccess, { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Sign out', exact: true }).click();
	await signIn(staffEmail);
	await expect(page.getByRole('heading', { name: en.admin.overview, exact: true })).toBeVisible();

	// Real audited insert, publication and edit, using guarded original revisions.
	await open('/admin/help');
	await page.getByRole('button', { name: 'New contact', exact: true }).click();
	const initialName = `Checkout proof volunteer ${'Longvolunteercontactname'.repeat(3)} ${crypto.randomUUID().slice(0, 8)}`;
	const recoveryReason = 'Disposable browser proof: the buyer identified the original checkout from its reference, saved items, saved prices and time. '.repeat(8).trim();
	await page.getByLabel(fieldLabel('Display name')).fill(initialName);
	await page.getByLabel(fieldLabel('Email (optional)')).fill('checkout-proof@example.invalid');
	await page.getByLabel(fieldLabel('Show this contact on the public contact page')).check();
	await page.getByRole('button', { name: 'Save contact', exact: true }).click();
	await expect(page.getByText('Contact saved.', { exact: true })).toBeVisible();
	await helpVisible(initialName, true);
	await operationalGeometry(initialName, recoveryReason);
	await page.getByLabel(fieldLabel('Display name')).fill(`${initialName} updated`);
	await page.getByRole('button', { name: 'Save contact', exact: true }).click();
	await expect(page.getByText('Contact saved.', { exact: true })).toBeVisible();
	await helpVisible(`${initialName} updated`, true);
	await page.getByLabel(fieldLabel('Show this contact on the public contact page')).uncheck();
	await page.getByRole('button', { name: 'Save contact', exact: true }).click();
	await expect(page.getByText('Contact saved.', { exact: true })).toBeVisible();
	await helpVisible(`${initialName} updated`, false);

	// Two real browser forms keep their shown revisions; the loser never overwrites.
	const rival = await context.newPage();
	await rival.goto(`${origin}/en/admin/help`);
	await rival.getByRole('button', { name: `Edit ${initialName} updated`, exact: true }).click();
	await page.getByLabel(fieldLabel('Display name')).fill(`${initialName} winner`);
	await page.getByRole('button', { name: 'Save contact', exact: true }).click();
	await expect(page.getByText('Contact saved.', { exact: true })).toBeVisible();
	await rival.getByLabel(fieldLabel('Display name')).fill(`${initialName} stale`);
	await rival.getByRole('button', { name: 'Save contact', exact: true }).click();
	await expect(rival.getByText(en.admin.contactStale, { exact: true })).toBeVisible();
	await expect(rival.getByRole('button', { name: 'Save contact', exact: true })).toBeDisabled();
	await rival.getByRole('button', { name: en.admin.reviewContact, exact: true }).click();
	await expect(rival.getByLabel(fieldLabel('Display name'))).toHaveValue(`${initialName} stale`);
	await rival.getByRole('button', { name: en.admin.reviewedContact, exact: true }).click();
	await rival.getByRole('button', { name: 'Save contact', exact: true }).click();
	await expect(rival.getByText('Contact saved.', { exact: true })).toBeVisible();
	await expect(rival.getByLabel(fieldLabel('Display name'))).toHaveValue(`${initialName} stale`);

	await rival.close();

	await open('/admin/privacy');
	await page.getByLabel(fieldLabel(en.admin.reference)).fill(requestId);
	await page.getByRole('button', { name: 'Find purchase', exact: true }).click();
	await expect(page.getByText(checkoutId, { exact: true })).toBeVisible();
	await expect(page.getByText('Purchase not registered.', { exact: true })).toBeVisible();
	await page.getByLabel(fieldLabel('Reason')).fill(recoveryReason);
	await page.getByRole('checkbox').check();
	const commands: Record<string, unknown>[] = [];
	const rpc = `${api}/rest/v1/rpc/amp_recover_checkout`;
	await context.route(rpc, async (route) => {
		if (route.request().method() !== 'POST') { await route.continue(); return; }
		commands.push(route.request().postDataJSON());
		if (commands.length === 1) {
			const response = await route.fetch();
			if (!response.ok()) throw new Error(`Recovery failed before lost-response proof: ${response.status()}`);
			await route.abort('failed');
		} else await route.continue();
	});
	await page.getByRole('button', { name: 'Register the original purchase', exact: true }).click();
	await expect(page.getByText(en.admin.recoveryUnknown, { exact: true })).toBeVisible();
	await page.getByRole('button', { name: en.admin.retryRecovery, exact: true }).click();
	await expect(page.getByRole('button', { name: en.admin.retryRecovery, exact: true })).toHaveCount(0);
	await expect(page.getByText('Purchase registered.', { exact: true }).first()).toBeVisible();
	await context.unroute(rpc);
	expect(commands).toHaveLength(2);
	expect(commands[1]).toEqual(commands[0]);
	expect(commands[0].p_checkout_id).toBe(checkoutId);
	expect(commands[0].p_reason).toBe(recoveryReason);
	expect(String(await sql(`SELECT recovery_reason=${literal(recoveryReason)} FROM app.sales WHERE checkout_id=${literal(checkoutId)};`)).trim()).toBe('t');
	expect(String(await sql(`SELECT count(*) FROM app.sales WHERE checkout_id=${literal(checkoutId)};`)).trim()).toBe('1');
	await open('/admin/privacy');
	await page.getByLabel(fieldLabel(en.admin.reference)).fill(checkoutId);
	await page.getByRole('button', { name: 'Find purchase', exact: true }).click();
	await expect(page.getByText('Purchase registered.', { exact: true }).first()).toBeVisible();
	await expect(page.getByRole('button', { name: 'Register the original purchase', exact: true })).toHaveCount(0);

	// Private operational content disappears when the active membership is revoked.
	await sql(`UPDATE app.staff_members SET is_active=false WHERE ${membershipFilter};`);
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect(page.getByText(en.admin.revoked, { exact: true })).toBeVisible();
	await expect(page.getByRole('heading', { name: en.admin.savedCheckout, exact: true })).toHaveCount(0);
	await sql(`UPDATE app.staff_members SET is_active=true WHERE ${membershipFilter};`);
	await page.getByRole('button', { name: 'Try again', exact: true }).click();
	await expect(page.getByRole('heading', { name: en.admin.recoveryHeading, exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Sign out', exact: true }).click();
	await expect(page.getByLabel(fieldLabel('Email address'))).toBeVisible();
	await expect(page.getByLabel(fieldLabel('Password'))).toBeVisible();
	await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
	await expect(page.getByRole('heading', { name: en.admin.recoveryHeading, exact: true })).toHaveCount(0);
	expect((await context.cookies(origin)).find((cookie) => cookie.name === '__Host-amp_checkout')?.value).toBe(checkoutCookie.value);

	await authGeometry();

	// Open the rendered link from Mailpit so template rendering and callbacks agree.
	if (options.inviteAuthUser && options.readAuthEmail) {
		for (const type of ['recovery', 'invite'] as const) {
			const email = type === 'recovery' ? nonstaffEmail : `checkout-invite-${crypto.randomUUID()}@example.test`;
			if (type === 'invite') await options.inviteAuthUser(email);
			else {
				await page.goto(`${origin}/en/admin/password?next=%2Fadmin`);
				await page.getByLabel(fieldLabel('Email address')).fill(email);
				await page.getByRole('button', { name: 'Send password link', exact: true }).click();
				await expect(page.getByText('If the account exists, you will receive an email with a password link.', { exact: true })).toBeVisible();
			}
			const link = await options.readAuthEmail(type, email);
			const changedPassword = `${password}-${type}`;
			await page.goto(link);
			// The page discards the callback once hydrated, which may be after the load event.
			await expect(page).toHaveURL(`${origin}/en/admin/password`);
			await page.getByRole('button', { name: 'Continue', exact: true }).click();
			await expect(page.getByLabel(fieldLabel('New password (at least 8 characters)'))).toBeVisible();
			await page.getByLabel(fieldLabel('New password (at least 8 characters)')).fill(changedPassword);
			await page.getByLabel(fieldLabel('Repeat new password')).fill(changedPassword);
			await page.getByRole('button', { name: 'Save password', exact: true }).click();
			await expect(page.getByText('Your password has been saved.', { exact: true })).toBeVisible();
			await page.getByRole('link', { name: 'Continue', exact: true }).click();
			await expect(page.getByText(en.admin.noAccess, { exact: true })).toBeVisible();
			await page.getByRole('button', { name: 'Sign out', exact: true }).click();
			await signIn(email, changedPassword);
			await expect(page.getByText(en.admin.noAccess, { exact: true })).toBeVisible();
			await page.getByRole('button', { name: 'Sign out', exact: true }).click();
		}
	}

	// Hostile return destinations and callback material cannot survive in page metadata.
	await page.goto(`${origin}/en/admin/password?code=bad&next=https%3A%2F%2Fevil.invalid#access_token=invalid`);
	await expect(page.getByText(en.admin.invalidCallback, { exact: true })).toBeVisible();
	expect(page.url()).toBe(`${origin}/en/admin/password`);
	await page.close(); await visitor.close();
	return { directory: 'published/edited/unpublished, stale draft reviewed and saved', recovery: 'same frozen command after committed lost response, one sale', auth: 'nonstaff denied, revocation enforced, guest cookie preserved' };
}
