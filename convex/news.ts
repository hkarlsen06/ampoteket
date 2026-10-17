/**
 * Newsroom and event calendar (docs/page-news.md, api-contract.md "News and
 * events"). Staff write articles and events through `save`, one retry-safe
 * command, so an article and its event are created, linked and unlinked
 * together. Nothing is deleted: unpublishing hides a row, and the audit log keeps
 * every version. The public reads return only published rows, published
 * volunteer contacts and images that a published row shows.
 */
import { v } from 'convex/values';
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { insertAudited, patchAudited, type Actor } from './lib/audit';
import { beginCommand } from './lib/commands';
import { fail } from './lib/errors';
import { byUuid, isUuid } from './lib/ids';
import { requireStaff } from './lib/staff';
import { isoAt, isoNow } from './lib/time';

const nullableString = v.union(v.string(), v.null());
const imageRef = v.object({ id: v.string(), alt: v.string() });
const link = v.object({ label: v.string(), url: v.string() });
const articleWrite = v.object({
	id: v.string(), slug: v.string(), title: v.string(), author: nullableString, summary: nullableString, body: v.string(), images: v.array(imageRef),
	links: v.array(link), people: v.array(v.string()), is_published: v.boolean(), expected_revision: nullableString
});
const eventWrite = v.object({
	id: v.string(), slug: v.string(), title: v.string(), description: v.string(), location: nullableString, starts_at: v.string(),
	ends_at: nullableString, article_id: nullableString, images: v.array(imageRef), links: v.array(link), people: v.array(v.string()),
	is_published: v.boolean(), expected_revision: nullableString
});
type ArticleWrite = typeof articleWrite.type;
type EventWrite = typeof eventWrite.type;
type ImageRef = typeof imageRef.type;
type Link = typeof link.type;

const MAX_IMAGE_BYTES = 1_000_000;
const DAY = 86_400_000;
// eslint-disable-next-line no-control-regex -- control characters are exactly what this rejects.
const control = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex -- long text keeps line breaks and tabs only.
const controlExceptBreaks = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// Instants carry an explicit offset; the editor converts Oslo wall time.
const instantPattern = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,6})?)?(Z|[+-]\d\d:\d\d)$/;
const chars = (value: string) => [...value].length;
// A paragraph of its own in an article body that places one of the article's images.
const imageMarker = /^\[image:([^\]]*)\]$/;

/** One line of text: not blank, at most `max` characters, no control characters. */
function line(value: string, max: number): string {
	if (!value.trim() || chars(value) > max || control.test(value)) fail('INVALID_NEWS');
	return value;
}
function longText(value: string, max: number): string {
	if (chars(value) > max || controlExceptBreaks.test(value)) fail('INVALID_NEWS');
	return value;
}
/** The same URL rule as help_contacts.contact_url. */
function safeUrl(url: string): boolean {
	const port = /^https:\/\/[^/:?#]+:([0-9]+)/.exec(url)?.[1];
	return url.length <= 500 && !control.test(url) && (port === undefined || Number(port) <= 65535)
		&& /^https:\/\/([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}(:[0-9]{1,5})?([/?#][^\s\\]*)?$/.test(url);
}
function revision(value: string | null): number | null {
	if (value === null) return null;
	if (!/^[1-9][0-9]{0,14}$/.test(value)) fail('INVALID_NEWS');
	return Number(value);
}
function instant(value: string): string {
	const ms = Date.parse(value);
	if (!instantPattern.test(value) || !Number.isFinite(ms)) fail('INVALID_NEWS');
	return isoAt(ms);
}

/** Up to 8 images (the first is the cover), up to 10 links and up to 20 tagged contacts, all of which must exist. */
async function checkLists(ctx: QueryCtx, images: ImageRef[], links: Link[], people: string[]) {
	if (images.length > 8 || links.length > 10 || people.length > 20) fail('INVALID_NEWS');
	if (new Set(images.map((i) => i.id)).size !== images.length || new Set(people).size !== people.length) fail('INVALID_NEWS');
	for (const image of images) if (!isUuid(image.id) || chars(image.alt) > 300 || !image.alt.trim() || control.test(image.alt)) fail('INVALID_NEWS');
	for (const l of links) { line(l.label, 80); if (!safeUrl(l.url)) fail('INVALID_NEWS'); }
	if (!people.every(isUuid)) fail('INVALID_NEWS');
	for (const id of people) if (!await byUuid(ctx, 'help_contacts', id)) fail('NEWS_PERSON_NOT_FOUND', id);
	for (const image of images) if (!await byUuid(ctx, 'news_images', image.id)) fail('NEWS_IMAGE_NOT_FOUND', image.id);
}
/** Every image marker in the body names one of the article's own images. */
function checkBody(body: string, images: ImageRef[]) {
	const ids = new Set(images.map((i) => i.id));
	for (const paragraph of body.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n+/)) {
		const id = imageMarker.exec(paragraph.trim())?.[1];
		if (id !== undefined && !ids.has(id)) fail('INVALID_NEWS');
	}
}
function checkRow(row: { id: string; slug: string }) {
	if (!isUuid(row.id) || row.slug.length > 80 || !slugPattern.test(row.slug)) fail('INVALID_NEWS');
}
async function slugTaken(ctx: QueryCtx, table: 'news_articles' | 'events', slug: string, id: string) {
	const other = await ctx.db.query(table).withIndex('slug', (q) => q.eq('slug', slug)).first();
	return other !== null && other.id !== id;
}

/** Point the image index at this row's current list. */
async function recordImageUses(ctx: MutationCtx, ownerId: string, images: ImageRef[]) {
	const current = await ctx.db.query('news_image_uses').withIndex('owner_id', (q) => q.eq('owner_id', ownerId)).collect();
	const wanted = new Set(images.map((i) => i.id));
	for (const use of current) if (!wanted.has(use.image_id)) await ctx.db.delete(use._id);
	const have = new Set(current.map((use) => use.image_id));
	for (const id of wanted) if (!have.has(id)) await ctx.db.insert('news_image_uses', { image_id: id, owner_id: ownerId });
}

async function saveArticle(ctx: MutationCtx, actor: Actor, a: ArticleWrite): Promise<Doc<'news_articles'>> {
	checkRow(a);
	const expected = revision(a.expected_revision);
	const fields = { title: line(a.title, 160), author: a.author === null ? null : line(a.author, 80), summary: a.summary === null ? null : line(a.summary, 300),
		body: longText(a.body, 20000), images: a.images, links: a.links, people: a.people, is_published: a.is_published };
	await checkLists(ctx, a.images, a.links, a.people);
	checkBody(fields.body, a.images);
	const current = await byUuid(ctx, 'news_articles', a.id);
	const now = isoNow();
	let row: Doc<'news_articles'>;
	if (expected === null) {
		if (current) fail('STALE_NEWS');
		if (await slugTaken(ctx, 'news_articles', a.slug, a.id)) fail('NEWS_SLUG_TAKEN');
		row = await insertAudited(ctx, actor, 'news_articles', { id: a.id, slug: a.slug, ...fields, published_at: a.is_published ? now : null,
			edit_revision: 1, created_at: now, updated_at: now });
	} else {
		if (!current) fail('NEWS_NOT_FOUND', a.id);
		if (current.edit_revision !== expected) fail('STALE_NEWS');
		if (current.slug !== a.slug) fail('INVALID_NEWS');
		// The first publication date is kept, so republishing does not move an article to the top.
		row = await patchAudited(ctx, actor, 'news_articles', current, { ...fields, published_at: current.published_at ?? (a.is_published ? now : null),
			edit_revision: current.edit_revision + 1, updated_at: now });
	}
	await recordImageUses(ctx, row.id, row.images);
	return row;
}

async function saveEvent(ctx: MutationCtx, actor: Actor, e: EventWrite, article: Doc<'news_articles'> | null): Promise<Doc<'events'>> {
	checkRow(e);
	const expected = revision(e.expected_revision);
	if (e.article_id !== null && !isUuid(e.article_id)) fail('INVALID_NEWS');
	const starts = instant(e.starts_at);
	const ends = e.ends_at === null ? null : instant(e.ends_at);
	// An event lasts at most 62 days, so a month view stays readable.
	if (ends !== null && (ends <= starts || Date.parse(ends) - Date.parse(starts) > 62 * DAY)) fail('INVALID_NEWS');
	const fields = { title: line(e.title, 160), description: longText(e.description, 5000), location: e.location === null ? null : line(e.location, 160),
		starts_at: starts, ends_at: ends, article_id: e.article_id, images: e.images, links: e.links, people: e.people, is_published: e.is_published };
	await checkLists(ctx, e.images, e.links, e.people);
	// Saved together, the event can only belong to the article beside it.
	if (e.article_id !== null && article && e.article_id !== article.id) fail('INVALID_NEWS');
	if (e.article_id !== null) {
		if (!await byUuid(ctx, 'news_articles', e.article_id)) fail('NEWS_NOT_FOUND', e.article_id);
		const other = await ctx.db.query('events').withIndex('article_id', (q) => q.eq('article_id', e.article_id)).first();
		if (other && other.id !== e.id) fail('EVENT_ARTICLE_TAKEN');
	}
	const current = await byUuid(ctx, 'events', e.id);
	const now = isoNow();
	let row: Doc<'events'>;
	if (expected === null) {
		if (current) fail('STALE_NEWS');
		if (await slugTaken(ctx, 'events', e.slug, e.id)) fail('NEWS_SLUG_TAKEN');
		row = await insertAudited(ctx, actor, 'events', { id: e.id, slug: e.slug, ...fields, edit_revision: 1, created_at: now, updated_at: now });
	} else {
		if (!current) fail('NEWS_NOT_FOUND', e.id);
		if (current.edit_revision !== expected) fail('STALE_NEWS');
		if (current.slug !== e.slug) fail('INVALID_NEWS');
		row = await patchAudited(ctx, actor, 'events', current, { ...fields, edit_revision: current.edit_revision + 1, updated_at: now });
	}
	await recordImageUses(ctx, row.id, row.images);
	return row;
}

type Saved = { id: string; slug: string; edit_revision: string } | null;
const saved = (row: { id: string; slug: string; edit_revision: number } | null): Saved => row && { id: row.id, slug: row.slug, edit_revision: String(row.edit_revision) };

/**
 * Save an article, its event or both. Each side is null (left untouched) or the
 * complete row; `expected_revision` is null to create it, otherwise the
 * `edit_revision` the editor read. The event owns the link: `article_id` null
 * unlinks it. A retry with the same request ID returns the first result.
 */
export const save = mutation({
	args: { requestId: v.string(), article: v.union(articleWrite, v.null()), event: v.union(eventWrite, v.null()) },
	handler: async (ctx, { requestId, article, event }): Promise<{ article: Saved; event: Saved }> => {
		const { staff, actor } = await requireStaff(ctx);
		const command = await beginCommand<{ article: Saved; event: Saved }>(ctx, requestId, 'save_news', staff.id, { article, event });
		if (command.done) return command.result;
		if (!article && !event) fail('INVALID_NEWS');
		const savedArticle = article ? await saveArticle(ctx, actor, article) : null;
		const savedEvent = event ? await saveEvent(ctx, actor, event, savedArticle) : null;
		return await command.finish({ article: saved(savedArticle), event: saved(savedEvent) });
	}
});

function signatureMatches(type: string, bytes: Uint8Array): boolean {
	const starts = (offset: number, ...expected: number[]) => expected.every((byte, i) => bytes[offset + i] === byte);
	if (type === 'image/webp') return starts(0, 0x52, 0x49, 0x46, 0x46) && starts(8, 0x57, 0x45, 0x42, 0x50);
	if (type === 'image/jpeg') return starts(0, 0xff, 0xd8, 0xff);
	if (type === 'image/png') return starts(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
	return false;
}
function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
	if (a.byteLength !== b.byteLength) return false;
	const x = new Uint8Array(a), y = new Uint8Array(b);
	return x.every((byte, i) => byte === y[i]);
}

/**
 * Store an image the browser has already re-encoded (dropping EXIF and GPS). The
 * client chooses the UUID, so a retry with the same ID and bytes stores nothing
 * twice. The declared type must match the file's signature, so the site can serve
 * it as declared.
 */
export const addImage = mutation({
	args: { id: v.string(), contentType: v.string(), data: v.bytes(), width: v.number(), height: v.number() },
	handler: async (ctx, { id, contentType, data, width, height }) => {
		const { staff } = await requireStaff(ctx);
		if (!isUuid(id)) fail('REQUEST_ID_REQUIRED');
		const size = (n: number) => Number.isInteger(n) && n >= 1 && n <= 4096;
		if (contentType !== 'image/webp' && contentType !== 'image/jpeg' && contentType !== 'image/png') fail('INVALID_NEWS_IMAGE');
		if (data.byteLength < 1 || data.byteLength > MAX_IMAGE_BYTES || !size(width) || !size(height)
			|| !signatureMatches(contentType, new Uint8Array(data))) fail('INVALID_NEWS_IMAGE');
		const current = await byUuid(ctx, 'news_images', id);
		if (current) {
			const stored = await ctx.db.query('news_image_data').withIndex('image_id', (q) => q.eq('image_id', id)).unique();
			if (current.content_type !== contentType || current.width !== width || current.height !== height || !stored || !sameBytes(stored.data, data)) {
				fail('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT');
			}
			return id;
		}
		await ctx.db.insert('news_images', { id, content_type: contentType, width, height, created_by: staff.id, created_at: isoNow() });
		await ctx.db.insert('news_image_data', { image_id: id, data });
		return id;
	}
});

// ---------- Staff reads ----------

function adminArticle(a: Doc<'news_articles'>) {
	return { id: a.id, slug: a.slug, title: a.title, author: a.author ?? null, summary: a.summary, body: a.body, images: a.images, links: a.links, people: a.people,
		is_published: a.is_published, published_at: a.published_at, edit_revision: String(a.edit_revision), updated_at: a.updated_at };
}
function adminEvent(e: Doc<'events'>) {
	return { id: e.id, slug: e.slug, title: e.title, description: e.description, location: e.location, starts_at: e.starts_at, ends_at: e.ends_at,
		article_id: e.article_id, images: e.images, links: e.links, people: e.people, is_published: e.is_published,
		edit_revision: String(e.edit_revision), updated_at: e.updated_at };
}

/** Every article and event, drafts included. */
export const list = query({
	args: {},
	handler: async (ctx) => {
		await requireStaff(ctx);
		const [articles, events] = await Promise.all([ctx.db.query('news_articles').collect(), ctx.db.query('events').collect()]);
		return { articles: articles.map(adminArticle), events: events.map(adminEvent) };
	}
});

async function imageBytes(ctx: QueryCtx, image: Doc<'news_images'>) {
	const stored = await ctx.db.query('news_image_data').withIndex('image_id', (q) => q.eq('image_id', image.id)).unique();
	return stored && { content_type: image.content_type, data: stored.data };
}

/** Any stored image, for previews in the editor. */
export const adminImage = query({
	args: { id: v.string() },
	handler: async (ctx, { id }) => {
		await requireStaff(ctx);
		const image = await byUuid(ctx, 'news_images', id);
		return image && await imageBytes(ctx, image);
	}
});

// ---------- Public reads ----------

/** Image size travels with the reference, so pages reserve the space before it loads. */
async function imageCards(ctx: QueryCtx, refs: ImageRef[]) {
	const cards = [];
	for (const ref of refs) {
		const image = await byUuid(ctx, 'news_images', ref.id);
		if (image) cards.push({ id: image.id, alt: ref.alt, width: image.width, height: image.height });
	}
	return cards;
}
/** Published contacts only, in tag order, with the /contact details. */
async function people(ctx: QueryCtx, ids: string[]) {
	const result = [];
	for (const id of ids) {
		const c = await byUuid(ctx, 'help_contacts', id);
		if (c?.is_published) result.push({ id: c.id, display_name: c.display_name, responsibility: c.responsibility, email: c.email,
			phone: c.phone, contact_url: c.contact_url, discord: c.discord });
	}
	return result;
}
async function publishedEventOf(ctx: QueryCtx, articleId: string) {
	const e = await ctx.db.query('events').withIndex('article_id', (q) => q.eq('article_id', articleId)).first();
	return e?.is_published ? { slug: e.slug, title: e.title, starts_at: e.starts_at, ends_at: e.ends_at, location: e.location } : null;
}
async function publishedArticle(ctx: QueryCtx, id: string | null) {
	const a = await byUuid(ctx, 'news_articles', id);
	return a?.is_published ? a : null;
}

const pageSize = (limit: number, max: number) => {
	if (!Number.isInteger(limit) || limit < 1 || limit > max) fail('INVALID_NEWS_PAGE_SIZE');
};
const cursorTime = (value: string) => {
	if (!Number.isFinite(Date.parse(value))) fail('INVALID_NEWS_CURSOR');
	return isoAt(Date.parse(value));
};

/** Published articles, newest first by (published_at, id); `before` continues after the last one shown. */
export const feed = query({
	args: { before: v.union(v.object({ published_at: v.string(), id: v.string() }), v.null()), limit: v.number() },
	handler: async (ctx, { before, limit }) => {
		pageSize(limit, 100);
		const at = before && cursorTime(before.published_at);
		if (before && !isUuid(before.id)) fail('INVALID_NEWS_CURSOR');
		const rows: Doc<'news_articles'>[] = [];
		const articles = ctx.db.query('news_articles')
			.withIndex('published', (q) => at ? q.eq('is_published', true).lte('published_at', at) : q.eq('is_published', true)).order('desc');
		for await (const a of articles) {
			if (at && a.published_at === at && a.id >= before!.id) continue;
			rows.push(a);
			if (rows.length === limit) break;
		}
		return await Promise.all(rows.map(async (a) => ({ id: a.id, slug: a.slug, title: a.title, author: a.author ?? null, summary: a.summary, published_at: a.published_at!,
			cover: (await imageCards(ctx, a.images.slice(0, 1)))[0] ?? null, event: await publishedEventOf(ctx, a.id) })));
	}
});

/** One published article, or null. */
export const article = query({
	args: { slug: v.string() },
	handler: async (ctx, { slug }) => {
		const a = await ctx.db.query('news_articles').withIndex('slug', (q) => q.eq('slug', slug)).first();
		if (!a?.is_published) return null;
		return { id: a.id, slug: a.slug, title: a.title, author: a.author ?? null, summary: a.summary, body: a.body, published_at: a.published_at!,
			images: await imageCards(ctx, a.images), links: a.links, people: await people(ctx, a.people), event: await publishedEventOf(ctx, a.id) };
	}
});

/**
 * Published events overlapping [from, to), by (starts_at, id). The range is at
 * most 400 days; page with `after` until a page comes back empty.
 */
export const calendar = query({
	args: { from: v.string(), to: v.string(), after: v.union(v.object({ starts_at: v.string(), id: v.string() }), v.null()), limit: v.number() },
	handler: async (ctx, args) => {
		pageSize(args.limit, 500);
		const fromMs = Date.parse(args.from), toMs = Date.parse(args.to);
		if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs || toMs - fromMs > 400 * DAY) fail('INVALID_EVENT_RANGE');
		const after = args.after && cursorTime(args.after.starts_at);
		if (args.after && !isUuid(args.after.id)) fail('INVALID_NEWS_CURSOR');
		const from = isoAt(fromMs), to = isoAt(toMs);
		// No event lasts longer than 62 days, so earlier starts cannot reach the range.
		const lower = [isoAt(fromMs - 62 * DAY), after ?? ''].sort().at(-1)!;
		const rows: Doc<'events'>[] = [];
		const events = ctx.db.query('events').withIndex('published_start', (q) => q.eq('is_published', true).gte('starts_at', lower).lt('starts_at', to));
		for await (const e of events) {
			if ((e.ends_at ?? e.starts_at) < from) continue;
			if (after && e.starts_at === after && e.id <= args.after!.id) continue;
			rows.push(e);
			if (rows.length === args.limit) break;
		}
		return await Promise.all(rows.map(async (e) => {
			const a = await publishedArticle(ctx, e.article_id);
			return { id: e.id, slug: e.slug, title: e.title, location: e.location, starts_at: e.starts_at, ends_at: e.ends_at,
				cover: (await imageCards(ctx, e.images.slice(0, 1)))[0] ?? null, article: a && { slug: a.slug, title: a.title } };
		}));
	}
});

/** One published event, or null. */
export const event = query({
	args: { slug: v.string() },
	handler: async (ctx, { slug }) => {
		const e = await ctx.db.query('events').withIndex('slug', (q) => q.eq('slug', slug)).first();
		if (!e?.is_published) return null;
		const a = await publishedArticle(ctx, e.article_id);
		return { id: e.id, slug: e.slug, title: e.title, description: e.description, location: e.location, starts_at: e.starts_at, ends_at: e.ends_at,
			images: await imageCards(ctx, e.images), links: e.links, people: await people(ctx, e.people),
			article: a && { slug: a.slug, title: a.title, summary: a.summary } };
	}
});

/** An image's bytes, only while a published article or event shows it; served by the Worker at /api/news/images/<id>. */
export const image = query({
	args: { id: v.string() },
	handler: async (ctx, { id }) => {
		const image = await byUuid(ctx, 'news_images', id);
		if (!image) return null;
		for (const use of await ctx.db.query('news_image_uses').withIndex('image_id', (q) => q.eq('image_id', id)).collect()) {
			const owner = await byUuid(ctx, 'news_articles', use.owner_id) ?? await byUuid(ctx, 'events', use.owner_id);
			if (owner?.is_published) return await imageBytes(ctx, image);
		}
		return null;
	}
});
