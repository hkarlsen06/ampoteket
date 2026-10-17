/**
 * Newsroom and event calendar in the real pages (docs/page-news.md): one editor
 * creates an article and its event with an image, a link and a tagged volunteer;
 * a save whose response is lost is resent unchanged; the public pages read them at
 * phone and desktop widths; unpublishing takes the pages and the image down.
 * Run with `./scripts/test-web.sh --news`.
 */
import { firefox, expect, type BrowserContext, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { captureFailure, fieldLabel, fits, proofEnvironment, signIn, waitForHydration } from './web-proof/harness';
import { interceptConvex } from './web-proof/convex-socket';
import { en } from '../src/lib/i18n/en';

const m = en.adminNews;
const artifacts = 'test-results/news';
const commandKey = 'ampoteket:admin-news-save:v1';
const osloDate = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

const environment = await proofEnvironment();
const { directory, origin, password, safe, fixtures, createStaff, startWorker } = environment;
const staffEmail = 'news-staff@example.test';
await createStaff(staffEmail, 'News proof volunteer');
const contactId = '74000000-0000-4000-8000-0000000000c1';
const now = new Date().toISOString().replace('Z', '000Z');
await fixtures.insert('help_contacts', [{ id: contactId, display_name: 'Proof Soldering Lead', responsibility: 'Courses', email: 'lead@example.test',
	phone: null, contact_url: null, discord: null, display_order: 0, is_published: true, edit_revision: 1, created_at: now, updated_at: now }]);
// Three days ahead, so the event is upcoming and inside a month view.
const day = osloDate(new Date(Date.now() + 3 * 86_400_000));
const articleTitle = 'Soldering night for beginners', eventTitle = 'Soldering night';

/** Through the browser, which trusts the disposable CA. */
const fetchImage = (page: Page, id: string) => page.evaluate(async (path) => {
	const response = await fetch(path, { cache: 'no-store' });
	return { status: response.status, type: response.headers.get('Content-Type'), cache: response.headers.get('Cache-Control') };
}, `/api/news/images/${id}`);

async function geometry(page: Page, path: string, name: string, ready: (page: Page) => Promise<void>) {
	for (const width of [360, 1280]) {
		await page.setViewportSize({ width, height: 900 });
		await page.goto(`${origin}${path}`);
		await ready(page);
		await page.screenshot({ path: `${artifacts}/${name}-${width}.png`, fullPage: true });
		await fits(page);
	}
}

let context: BrowserContext | undefined;
const { ready, close } = await startWorker(() => context);
try {
	await mkdir(artifacts, { recursive: true });
	await ready();
	context = await firefox.launchPersistentContext(`${directory}/profile`, { headless: true, ignoreHTTPSErrors: false });
	const convex = await interceptConvex(context);
	context.on('page', (tab) => tab.on('console', (message) => {
		if (message.type() === 'error') console.error(`[browser error] ${safe(message.text())}`);
	}));
	const page = await context.newPage();
	await signIn(page, origin, staffEmail, password);
	await expect(page).toHaveURL(`${origin}/en/admin`);

	// ---------- One editor, both sides ----------
	await page.goto(`${origin}/en/admin/news/new?with=article`);
	await waitForHydration(page);
	const article = page.getByRole('region', { name: m.article, exact: true });
	const event = page.getByRole('region', { name: m.event, exact: true });
	await article.getByLabel(fieldLabel(m.titleLabel)).fill(articleTitle);
	await article.getByLabel(fieldLabel(m.summary)).fill('Bring nothing; we have irons, solder and coffee.');
	await expect(article.getByLabel(fieldLabel(m.author))).toHaveValue('News proof volunteer');
	const body = article.getByRole('textbox', { name: fieldLabel(m.body) });
	await body.fill('First paragraph.\n\nSecond paragraph.');
	await event.getByRole('button', { name: m.addEvent, exact: true }).click();
	await expect(event.getByLabel(fieldLabel(m.titleLabel))).toHaveValue(articleTitle);
	await event.getByLabel(fieldLabel(m.titleLabel)).fill(eventTitle);
	await event.getByLabel(fieldLabel(m.starts)).fill(`${day}T18:00`);
	await event.getByLabel(fieldLabel(m.ends)).fill(`${day}T21:00`);
	await event.getByLabel(fieldLabel(m.location)).fill('PS126');

	// A real photograph-sized PNG, re-encoded by the editor before upload.
	const png = await page.evaluate(() => {
		const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 800;
		const draw = canvas.getContext('2d')!;
		draw.fillStyle = '#c45'; draw.fillRect(0, 0, 1200, 800); draw.fillStyle = '#fd3'; draw.fillRect(200, 200, 600, 300);
		return canvas.toDataURL('image/png').split(',')[1];
	});
	await page.locator('input[type=file]').setInputFiles({ name: 'bench.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
	const alt = page.getByLabel(fieldLabel(m.imageAlt));
	await expect(alt).toBeFocused();
	await alt.fill('Two people soldering at a bench');
	// Placed after the line the cursor was in; the text continues below the thumbnail.
	await body.focus(); await body.evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(5, 5));
	await page.getByRole('button', { name: m.insertImageN(1), exact: true }).click();
	await expect(body).toHaveValue('First paragraph.');
	const rest = article.getByLabel(m.bodyPart(2), { exact: true });
	await expect(rest).toHaveValue('Second paragraph.');
	// Dragged by its thumbnail below the last line, then one place back up with its button.
	await rest.scrollIntoViewIfNeeded();
	const handle = (await article.locator('[data-drag-handle]').boundingBox())!, end = (await rest.boundingBox())!;
	await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
	await page.mouse.down();
	for (let step = 1; step <= 6; step++) await page.mouse.move(handle.x + 40, handle.y + (end.y + end.height + 4 - handle.y) * step / 6);
	await page.mouse.up();
	await expect(body).toHaveValue('First paragraph.\n\nSecond paragraph.');
	await expect(rest).toHaveValue('');
	await page.getByRole('button', { name: m.moveInTextUp(1), exact: true }).click();
	await expect(body).toHaveValue('First paragraph.');
	await expect(rest).toHaveValue('Second paragraph.');
	const [image] = await fixtures.rows<{ id: string; content_type: string; width: number; height: number }>('news_images');
	expect(image).toMatchObject({ width: 1200, height: 800 });
	expect(['image/webp', 'image/jpeg']).toContain(image.content_type);
	await page.getByRole('button', { name: m.addLink, exact: true }).click();
	await page.getByLabel(fieldLabel(m.linkLabel)).fill('Sign up');
	await page.getByLabel(fieldLabel(m.linkUrl)).fill('https://example.org/sign-up');
	await page.getByRole('checkbox', { name: /Proof Soldering Lead/ }).check();
	await page.getByRole('switch', { name: m.publishArticle, exact: true }).click();
	await page.getByRole('switch', { name: m.publishEvent, exact: true }).click();

	// The save commits, but the page never hears back: the same command is resent.
	const sentBefore = convex.mutations.length;
	convex.withhold('news:save');
	await page.getByRole('button', { name: m.save, exact: true }).click();
	await expect(page.getByText(m.unknown, { exact: true })).toBeVisible();
	expect(await fixtures.rows('news_articles')).toHaveLength(1);
	const frozen = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? 'null'), commandKey);
	expect(frozen?.article?.title).toBe(articleTitle);
	await page.getByRole('button', { name: m.retrySave, exact: true }).click();
	await expect(page.getByText(en.admin.saved, { exact: true })).toBeVisible();
	expect(await page.evaluate((key) => sessionStorage.getItem(key), commandKey)).toBeNull();
	const saves = convex.sent('news:save', sentBefore);
	expect(saves).toHaveLength(2);
	expect(saves[1]).toEqual(saves[0]);
	const [articleRow] = await fixtures.rows<{ id: string; slug: string; edit_revision: number; author: string; body: string }>('news_articles');
	expect(articleRow).toMatchObject({ author: 'News proof volunteer', body: `First paragraph.\n\n[image:${image.id}]\n\nSecond paragraph.` });
	const [eventRow] = await fixtures.rows<{ id: string; slug: string; article_id: string; starts_at: string }>('events');
	expect(articleRow).toMatchObject({ slug: 'soldering-night-for-beginners', edit_revision: 1 });
	expect(eventRow).toMatchObject({ slug: 'soldering-night', article_id: articleRow.id });
	await expect(page).toHaveURL(`${origin}/en/admin/news/${articleRow.id}`);
	console.log('PASS: editor: article and event created and linked in one save, image re-encoded, uploaded once, placed in the text from the cursor, dragged and moved back by button, byline from the account, lost response resent unchanged');

	// ---------- Public pages ----------
	const visitor = await context.newPage();
	await geometry(visitor, '/en/news', 'news', async (tab) => {
		await expect(tab.getByRole('link', { name: articleTitle })).toBeVisible();
		await expect(tab.getByRole('heading', { name: en.news.upcoming })).toBeVisible();
		await expect(tab.getByText(eventTitle).first()).toBeVisible();
	});
	await geometry(visitor, `/en/news/${articleRow.slug}`, 'article', async (tab) => {
		await expect(tab.getByRole('heading', { name: articleTitle, level: 1 })).toBeVisible();
		await expect(tab.getByText(en.news.byline('News proof volunteer'))).toBeVisible();
		// The image sits between the two paragraphs, not above the text as a cover.
		await expect(tab.locator('article p:text-is("First paragraph.") + figure + p:text-is("Second paragraph.")')).toHaveCount(1);
		const cover = tab.getByRole('img', { name: 'Two people soldering at a bench' }).first();
		await expect.poll(() => cover.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
		await expect(tab.getByRole('link', { name: 'Sign up' })).toBeVisible();
		await expect(tab.getByText('Proof Soldering Lead').first()).toBeVisible();
	});
	await geometry(visitor, `/en/events?month=${day.slice(0, 7)}`, 'calendar', async (tab) => {
		await expect(tab.getByRole('link', { name: eventTitle }).first()).toBeVisible();
	});
	await geometry(visitor, `/en/events/${eventRow.slug}`, 'event', async (tab) => {
		await expect(tab.getByRole('heading', { name: eventTitle, level: 1 })).toBeVisible();
		await expect(tab.getByText('PS126').first()).toBeVisible();
		await expect(tab.getByRole('link', { name: new RegExp(en.events.article) })).toBeVisible();
	});
	await geometry(page, `/en/admin/news/${articleRow.id}`, 'editor', async (tab) => {
		await expect(tab.getByRole('region', { name: m.event, exact: true }).getByLabel(fieldLabel(m.titleLabel))).toHaveValue(eventTitle);
	});
	expect(await fetchImage(visitor, image.id)).toEqual({ status: 200, type: image.content_type, cache: 'public, max-age=3600' });
	console.log('PASS: public: newsroom, article (byline, image between paragraphs, link, person), calendar and event at 360 and 1280 px without horizontal scroll');

	// ---------- Unpublishing ----------
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto(`${origin}/en/admin/news/${articleRow.id}`);
	await waitForHydration(page);
	await page.getByRole('switch', { name: m.publishArticle, exact: true }).click();
	await page.getByRole('switch', { name: m.publishEvent, exact: true }).click();
	await page.getByRole('button', { name: m.save, exact: true }).click();
	await expect(page.getByText(en.admin.saved, { exact: true })).toBeVisible();
	expect((await visitor.goto(`${origin}/en/news/${articleRow.slug}`))?.status()).toBe(404);
	expect((await visitor.goto(`${origin}/en/events/${eventRow.slug}`))?.status()).toBe(404);
	await visitor.goto(`${origin}/en/news`);
	expect((await fetchImage(visitor, image.id)).status).toBe(404);
	await expect(visitor.getByText(en.news.empty, { exact: true })).toBeVisible();
	console.log('PASS: unpublishing hides the article, the event and the image; nothing is deleted');
	expect(await fixtures.rows('news_articles')).toHaveLength(1);
} catch (error) {
	for (const [index, tab] of (context?.pages() ?? []).entries()) {
		console.error(`Open tab ${index}: ${tab.url()}`);
		await captureFailure(tab, artifacts, `news-${index}`);
	}
	const raw = await Bun.file(`${directory}/worker-error.log`).text() + await Bun.file(`${directory}/worker.log`).text();
	const backend = (await Bun.file(`${directory}/convex.log`).text().catch(() => '')).split('\n').filter((line) => /error|fail|timed out/i.test(line));
	if (backend.length) console.error(safe(backend.slice(-20).join('\n')));
	if (safe(raw).trim()) console.error(safe(raw).slice(-4000));
	console.error(safe(error instanceof Error ? error.stack ?? error.message : String(error)));
	process.exitCode = 1;
} finally {
	await close();
}
