/** Admin sidebar on the built Worker and a disposable Convex backend: ./scripts/test-web.sh --sidebar */
import { firefox, expect, type BrowserContext } from '@playwright/test';
import { captureFailure, proofEnvironment, signIn } from './web-proof/harness';
import { interceptConvex } from './web-proof/convex-socket';
import { mkdir } from 'node:fs/promises';
import { en } from '../src/lib/i18n/en';
import { nb } from '../src/lib/i18n/nb';

const { directory, origin, password, safe, fixtures, createStaff, startWorker } = await proofEnvironment();
const staffEmail = 'sidebar-staff@example.test';
const { authUserId } = await createStaff(staffEmail, 'Sidebar proof volunteer');
const artifacts = 'test-results/admin-sidebar';
await mkdir(artifacts, { recursive: true });
let context: BrowserContext | undefined;
const { ready, close } = await startWorker(() => context);
try {
	await ready();
	context = await firefox.launchPersistentContext(`${directory}/profile`, { headless: true, ignoreHTTPSErrors: false });
	const convex = await interceptConvex(context);
	const page = await context.newPage();
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	// The editor tidies a name when focus leaves it, so the draft has no trailing space.
	const longDraft = 'Long product name '.repeat(10).trim();
	// A new product chooses its category first and the name fields grow in below;
	// microcontroller names carry no locked category prefix.
	const chooseCategory = () => page.locator('#product-category-mcu').click();
	page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') console.error(`[browser ${message.type()}] ${safe(message.text())}`); });
	await signIn(page, origin, staffEmail, password);
	// Sign-in verifies a bcrypt hash in a mutation; a loaded test machine needs longer than the default.
	await expect(page.getByRole('navigation', { name: en.admin.navigation })).toBeVisible({ timeout: 30_000 });
	await page.goto(`${origin}/en/admin`);
	await expect(page.getByRole('heading', { name: en.admin.overview, exact: true })).toBeVisible();

	for (const [locale, messages] of [['nb', nb], ['en', en]] as const) {
		const prefix = locale === 'nb' ? '' : '/en';
		for (const colorScheme of ['light', 'dark'] as const) for (const width of [360, 768, 1280]) {
			await page.emulateMedia({ colorScheme });
			await page.setViewportSize({ width, height: 900 });
			await page.goto(`${origin}${prefix}/admin/products/new`);
			const nav = page.getByRole('navigation', { name: messages.admin.navigation });
			const trigger = page.getByRole('button', { name: messages.admin.toggleSidebar });
			const firstLink = nav.locator('a').first();
			const input = page.locator('#product-name-en');
			await chooseCategory();
			await expect(input).toBeEditable();
			await input.fill(longDraft);
			if (width < 768) {
				await expect(firstLink).toBeHidden();
				await trigger.click();
				await expect(page.getByRole('dialog', { name: messages.admin.navigation })).toBeVisible();
			} else {
				await expect(trigger).toBeVisible();
				const railBox = (await page.locator('[data-slot=sidebar-container]').boundingBox())!;
				expect(railBox.x).toBe(0);
				expect(railBox.height).toBe(836);
				const navBox = (await nav.boundingBox())!;
				const inputBox = (await input.boundingBox())!;
				expect(navBox.x + navBox.width).toBeLessThan(inputBox.x);
			}
			await expect(nav.getByRole('link')).toHaveCount(12);
			await expect(nav.locator('[aria-current="page"]')).toHaveAttribute('href', `${prefix}/admin/products`);
			await firstLink.focus();
			await page.keyboard.press('Tab');
			const focused = await page.evaluate(() => {
				const active = document.activeElement as HTMLElement;
				const css = getComputedStyle(active);
				return { visible: active.matches(':focus-visible') && parseFloat(css.outlineWidth) >= 2,
					rect: active.getBoundingClientRect().toJSON(), ring: [...css.outlineColor.matchAll(/\d+/g)].slice(0, 3).map(Number) };
			});
			expect(focused.visible).toBe(true);
			// Inspect rendered pixels: a later row used to paint over the lower focus ring.
			const keyboardShot = await page.screenshot({ path: `${artifacts}/${locale}-${colorScheme}-${width}-keyboard.png`, animations: 'disabled' });
			const ringPixels = await page.evaluate(async ({ png, rect }) => {
				const image = new Image();
				image.src = `data:image/png;base64,${png}`;
				await image.decode();
				const canvas = document.createElement('canvas');
				canvas.width = image.width; canvas.height = image.height;
				const ctx = canvas.getContext('2d')!;
				ctx.drawImage(image, 0, 0);
				return [rect.y - 3, rect.y + rect.height + 3].map(y =>
					Array.from(ctx.getImageData(Math.floor(rect.x + rect.width / 2), Math.floor(y), 1, 1).data));
			}, { png: keyboardShot.toString('base64'), rect: focused.rect });
			// The ring follows the --ring token of the current colour scheme.
			expect(focused.ring).toHaveLength(3);
			expect(ringPixels).toEqual([[...focused.ring, 255], [...focused.ring, 255]]);
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'No horizontal page scroll').toBe(true);
			// Sidebar buttons are 44px for touch and 36px under a fine pointer (sidebar-menu-button.svelte).
			expect(await nav.evaluate(element => {
				const minimum = matchMedia('(pointer: fine)').matches ? 36 : 44;
				return [...element.querySelectorAll('a, button')].filter(control => control.getBoundingClientRect().height > 0)
					.filter(control => control.getBoundingClientRect().height < minimum).map(control => control.textContent);
			}), 'Sidebar targets below their minimum height').toEqual([]);
			// The ordinary preview should show the selected page, not the keyboard-test focus.
			await page.locator('[data-sidebar="header"]').click({ position: { x: 4, y: 4 } });
			await page.screenshot({ path: `${artifacts}/${locale}-${colorScheme}-${width}.png` });
			if (width < 768) {
				await page.keyboard.press('Escape');
				await expect(trigger).toBeFocused();
				await expect(firstLink).toBeHidden();
				await expect(input).toHaveValue(longDraft);
				await trigger.click();
			} else {
				await trigger.click();
				await expect(trigger).toHaveAttribute('aria-expanded', 'false');
				await expect(page.locator('[data-slot=sidebar-container]')).toHaveCSS('width', '64px');
				await expect(nav.getByRole('link')).toHaveCount(12);
				await page.screenshot({ path: `${artifacts}/${locale}-${colorScheme}-${width}-collapsed.png` });
				await trigger.click();
				await expect(page.locator('[data-slot=sidebar-container]')).toHaveCSS('width', '256px');
			}
			await nav.locator(`a[href="${prefix}/admin/products/labels"]`).click();
			await expect(page).toHaveURL(`${origin}${prefix}/admin/products/labels`);
			if (width < 768) {
				await expect(trigger).toHaveAttribute('aria-expanded', 'false');
				await expect(page.getByRole('dialog')).toHaveCount(0);
				await expect(trigger).not.toBeFocused();
				await trigger.click();
			}
			await expect(nav.locator('[aria-current="page"]')).toHaveAttribute('href', `${prefix}/admin/products/labels`);
		}
	}

	// A membership read failure must keep the same editor and sidebar in place.
	await page.goto(`${origin}/en/admin/products/new`);
	const input = page.locator('#product-name-en');
	await chooseCategory();
	await expect(input).toBeEditable();
	await input.fill('Unsaved sidebar regression draft');
	const before = await input.boundingBox();
	// Membership is a live read: a change to the member re-runs it, and that result fails.
	convex.fail('members:me');
	await fixtures.patch('staff_members', { auth_user_id: authUserId }, { display_name: 'Sidebar proof volunteer, renamed' });
	await expect(page.getByText(en.admin.accessUnavailable, { exact: true })).toBeVisible();
	await expect(input).toHaveValue('Unsaved sidebar regression draft');
	expect(await input.boundingBox()).toEqual(before);
	expect(await page.getByRole('navigation', { name: en.admin.navigation, includeHidden: true }).evaluate(element => Boolean(element.closest('[inert]')))).toBe(true);
	convex.restore('members:me');
	await page.getByRole('button', { name: en.admin.retry, exact: true }).click();
	// toBeEditable ignores `inert`, so check that the blocked state really ended.
	await expect(page.getByText(en.admin.accessUnavailable, { exact: true })).toHaveCount(0);
	expect(await page.getByRole('navigation', { name: en.admin.navigation }).evaluate(element => Boolean(element.closest('[inert]')))).toBe(false);
	await expect(input).toBeEditable();
	await expect(input).toHaveValue('Unsaved sidebar regression draft');
	// Admin is its own workspace: no public footer follows the page.
	await expect(page.locator('.site-footer')).toHaveCount(0);
	await page.getByRole('button', { name: en.admin.signOut, exact: true }).click();
	await expect(page).toHaveURL(/\/en\/admin\/login/);
	await expect(page.locator('[data-sidebar="sidebar"]')).toHaveCount(0);
	expect(errors).toEqual([]);
	console.log('PASS: sidebar geometry, links, phone drawer and desktop collapse, focus, retained drafts and sign-out; nb/en, light/dark, 360/768/1280px');
} catch (error) {
	for (const [index, tab] of (context?.pages() ?? []).entries()) {
		console.error(`Open tab ${index}: ${tab.url()}`);
		await captureFailure(tab, artifacts, `sidebar-${index}`);
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
