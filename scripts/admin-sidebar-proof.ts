/** Run against the local disposable seed: bun scripts/admin-sidebar-proof.ts */
import { chromium, expect } from '@playwright/test';
import { fieldLabel } from './web-proof/harness';
import { mkdir } from 'node:fs/promises';
import { en } from '../src/lib/i18n/en';
import { nb } from '../src/lib/i18n/nb';

const origin = 'http://localhost:5174';
const artifacts = 'test-results/admin-sidebar';
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
try {
	await page.goto(`${origin}/en/admin/login`);
	await page.getByLabel(fieldLabel('Email address')).fill('test@test.no');
	await page.getByLabel(fieldLabel('Password')).fill('test');
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	await expect(page.getByRole('navigation', { name: en.admin.navigation })).toBeVisible();
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
			await expect(input).toBeEditable();
			await input.fill('Long product name '.repeat(10));
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
			await expect(nav.getByRole('link')).toHaveCount(8);
			await expect(nav.locator('[aria-current="page"]')).toHaveAttribute('href', `${prefix}/admin/products`);
			await firstLink.focus();
			await page.keyboard.press('Tab');
			const focused = await page.evaluate(() => {
				const active = document.activeElement as HTMLElement;
				const css = getComputedStyle(active);
				return { visible: active.matches(':focus-visible') && parseFloat(css.outlineWidth) >= 2,
					rect: active.getBoundingClientRect().toJSON() };
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
			expect(ringPixels).toEqual([[255, 220, 0, 255], [255, 220, 0, 255]]);
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
			expect(await nav.evaluate(element => [...element.querySelectorAll('a, button')].filter(control => control.getBoundingClientRect().height > 0).every(control => control.getBoundingClientRect().height >= 44))).toBe(true);
			// The ordinary preview should show the selected page, not the keyboard-test focus.
			await page.locator('[data-sidebar="header"]').click({ position: { x: 4, y: 4 } });
			await page.screenshot({ path: `${artifacts}/${locale}-${colorScheme}-${width}.png` });
			if (width < 768) {
				await page.keyboard.press('Escape');
				await expect(trigger).toBeFocused();
				await expect(firstLink).toBeHidden();
				await expect(input).toHaveValue('Long product name '.repeat(10));
				await trigger.click();
			} else {
				await trigger.click();
				await expect(trigger).toHaveAttribute('aria-expanded', 'false');
				await expect(page.locator('[data-slot=sidebar-container]')).toHaveCSS('width', '64px');
				await expect(nav.getByRole('link')).toHaveCount(8);
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
	await expect(input).toBeEditable();
	await input.fill('Unsaved sidebar regression draft');
	const before = await input.boundingBox();
	await page.route('**/rest/v1/amp_staff_members*', route => route.abort('failed'));
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect(page.getByText(en.admin.unavailable, { exact: true })).toBeVisible();
	await expect(input).toHaveValue('Unsaved sidebar regression draft');
	expect(await input.boundingBox()).toEqual(before);
	expect(await page.getByRole('navigation', { name: en.admin.navigation, includeHidden: true }).evaluate(element => Boolean(element.closest('[inert]')))).toBe(true);
	await page.unroute('**/rest/v1/amp_staff_members*');
	await page.getByRole('button', { name: en.admin.retry, exact: true }).click();
	await expect(input).toBeEditable();
	const footer = page.locator('footer').last();
	await footer.scrollIntoViewIfNeeded();
	const railBox = (await page.locator('[data-slot=sidebar-container]').boundingBox())!;
	expect(railBox.y + railBox.height).toBeLessThanOrEqual((await footer.boundingBox())!.y + 1);
	await page.getByRole('button', { name: en.admin.signOut, exact: true }).click();
	await expect(page).toHaveURL(/\/en\/admin\/login/);
	await expect(page.locator('[data-sidebar="sidebar"]')).toHaveCount(0);
	expect(errors).toEqual([]);
	console.log('PASS: sidebar geometry, links, phone drawer and desktop collapse, focus, retained drafts and sign-out; nb/en, light/dark, 360/768/1280px');
} finally {
	await browser.close();
}
