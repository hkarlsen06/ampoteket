// Newsroom and event calendar (docs/page-news.md, datamodell.md §10).
import { beforeEach, describe, expect, test } from 'bun:test';
import type { ConvexHttpClient } from 'convex/browser';
import { api } from '../../convex/_generated/api';
import { enabled, freshDeployment, guest, rejected, staff, uuid } from './harness';

const png = (extra = 0) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, extra]).buffer;
const article = (overrides: Record<string, unknown> = {}) => ({
	id: uuid(), slug: `post-${uuid().slice(0, 8)}`, title: 'Loddekveld', author: null, summary: null, body: 'Første avsnitt.\n\nAndre avsnitt.',
	images: [], links: [], people: [], is_published: false, expected_revision: null, ...overrides
});
const event = (overrides: Record<string, unknown> = {}) => ({
	id: uuid(), slug: `event-${uuid().slice(0, 8)}`, title: 'Loddekveld', description: '', location: 'Verkstedet',
	starts_at: '2026-11-05T18:00+01:00', ends_at: '2026-11-05T21:00+01:00', article_id: null,
	images: [], links: [], people: [], is_published: false, expected_revision: null, ...overrides
});
const save = (client: ConvexHttpClient, a: unknown, e: unknown, requestId = uuid()) =>
	client.mutation(api.news.save, { requestId, article: a as never, event: e as never });

describe.skipIf(!enabled)('news', () => {
	beforeEach(freshDeployment);

	test('an article and its event are created together, published, and read publicly', async () => {
		const { client } = await staff();
		const imageId = uuid();
		await client.mutation(api.news.addImage, { id: imageId, contentType: 'image/png', data: png(), width: 800, height: 600 });
		const contact = uuid();
		await client.mutation(api.help.save, { id: contact, revision: null, fields: { display_name: 'Ada', responsibility: null, email: 'ada@example.no',
			phone: null, contact_url: null, discord: null, is_published: true } });
		const hidden = uuid();
		await client.mutation(api.help.save, { id: hidden, revision: null, fields: { display_name: 'Bo', responsibility: null, email: null,
			phone: null, contact_url: null, discord: null, is_published: false } });
		const a = article({ images: [{ id: imageId, alt: 'Lodding' }], links: [{ label: 'Påmelding', url: 'https://example.no/meld' }],
			people: [contact, hidden], is_published: true });
		const e = event({ article_id: a.id, images: a.images, people: [contact], is_published: true });
		const result = await save(client, a, e);
		expect(result).toEqual({ article: { id: a.id, slug: a.slug, edit_revision: '1' }, event: { id: e.id, slug: e.slug, edit_revision: '1' } });

		const feed = await guest().query(api.news.feed, { before: null, limit: 10 });
		expect(feed).toHaveLength(1);
		expect(feed[0]).toMatchObject({ slug: a.slug, cover: { id: imageId, alt: 'Lodding', width: 800, height: 600 },
			event: { slug: e.slug, starts_at: '2026-11-05T17:00:00.000000Z', ends_at: '2026-11-05T20:00:00.000000Z', location: 'Verkstedet' } });
		const read = await guest().query(api.news.article, { slug: a.slug });
		// Unpublished contacts are never shown.
		expect(read?.people.map((p) => p.display_name)).toEqual(['Ada']);
		expect(read?.links).toEqual(a.links);
		const calendar = await guest().query(api.news.calendar, { from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z', after: null, limit: 100 });
		expect(calendar.map((row) => row.slug)).toEqual([e.slug]);
		expect(calendar[0].article).toEqual({ slug: a.slug, title: a.title });
		expect((await guest().query(api.news.event, { slug: e.slug }))?.article?.slug).toBe(a.slug);
		const bytes = await guest().query(api.news.image, { id: imageId });
		expect(bytes?.content_type).toBe('image/png');
		expect(new Uint8Array(bytes!.data)).toEqual(new Uint8Array(png()));
	});

	test('the byline is read back, and an image marker must name one of the article\'s images', async () => {
		const { client } = await staff();
		const [inline, other] = [uuid(), uuid()];
		for (const id of [inline, other]) await client.mutation(api.news.addImage, { id, contentType: 'image/png', data: png(), width: 40, height: 30 });
		const body = `Før bildet.\n\n[image:${inline}]\n\nEtter bildet.`;
		const a = article({ author: 'Kari Nordmann', body, images: [{ id: inline, alt: 'Benken' }], is_published: true });
		await save(client, a, null);
		expect(await guest().query(api.news.feed, { before: null, limit: 10 })).toMatchObject([{ slug: a.slug, author: 'Kari Nordmann' }]);
		expect(await guest().query(api.news.article, { slug: a.slug })).toMatchObject({ author: 'Kari Nordmann', body });
		expect((await client.query(api.news.list, {})).articles[0].author).toBe('Kari Nordmann');
		// A marker for an image the article does not list, or no image at all, is refused; inside a sentence it is plain text.
		for (const bad of [`[image:${other}]`, '[image:]', 'Tekst\n\n  [image:nope]  ']) {
			expect(await rejected(save(client, article({ body: bad, images: [{ id: inline, alt: 'Benken' }] }), null))).toBe('INVALID_NEWS');
		}
		await save(client, article({ body: `Se [image:${other}] her.` }), null);
		for (const author of ['', '   ', 'x'.repeat(81), 'Kari\nNordmann']) expect(await rejected(save(client, article({ author }), null))).toBe('INVALID_NEWS');
	});

	test('drafts, their images and unpublished rows stay private; republishing keeps the first date', async () => {
		const { client } = await staff();
		const imageId = uuid();
		await client.mutation(api.news.addImage, { id: imageId, contentType: 'image/png', data: png(), width: 10, height: 10 });
		const a = article({ images: [{ id: imageId, alt: 'Bilde' }] });
		await save(client, a, null);
		expect(await guest().query(api.news.feed, { before: null, limit: 10 })).toEqual([]);
		expect(await guest().query(api.news.article, { slug: a.slug })).toBeNull();
		expect(await guest().query(api.news.image, { id: imageId })).toBeNull();
		// Staff preview any stored image.
		expect(await client.query(api.news.adminImage, { id: imageId })).not.toBeNull();

		await save(client, { ...a, is_published: true, expected_revision: '1' }, null);
		const first = (await client.query(api.news.list, {})).articles[0].published_at;
		expect(first).not.toBeNull();
		expect(await guest().query(api.news.image, { id: imageId })).not.toBeNull();
		await save(client, { ...a, is_published: false, expected_revision: '2' }, null);
		expect(await guest().query(api.news.image, { id: imageId })).toBeNull();
		await save(client, { ...a, is_published: true, expected_revision: '3' }, null);
		expect((await client.query(api.news.list, {})).articles[0].published_at).toBe(first);
		// Removing the image from the published row takes it down.
		await save(client, { ...a, images: [], is_published: true, expected_revision: '4' }, null);
		expect(await guest().query(api.news.image, { id: imageId })).toBeNull();
	});

	test('saves are retry-safe and revision-guarded; slugs are permanent and unique', async () => {
		const { client } = await staff();
		const a = article();
		const requestId = uuid();
		const first = await save(client, a, null, requestId);
		expect(await save(client, a, null, requestId)).toEqual(first);
		expect(await rejected(save(client, { ...a, title: 'Annet' }, null, requestId))).toBe('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT');
		// Two editors read revision 1; the second save is stale.
		const [one, two] = await Promise.allSettled([
			save(client, { ...a, title: 'En', expected_revision: '1' }, null),
			save(client, { ...a, title: 'To', expected_revision: '1' }, null)
		]);
		expect([one.status, two.status].sort()).toEqual(['fulfilled', 'rejected']);
		expect(await rejected(save(client, { ...a, expected_revision: '1' }, null))).toBe('STALE_NEWS');
		expect(await rejected(save(client, a, null))).toBe('STALE_NEWS');
		expect(await rejected(save(client, { ...a, slug: 'new-address', expected_revision: '2' }, null))).toBe('INVALID_NEWS');
		expect(await rejected(save(client, article({ slug: a.slug }), null))).toBe('NEWS_SLUG_TAKEN');
		expect(await rejected(save(client, null, null))).toBe('INVALID_NEWS');
		const audit = await client.query(api.auditLog.page, {});
		expect(audit.entries.filter((entry) => entry.table_name === 'news_articles')).toHaveLength(2); // the insert and the one save that won
	});

	test('an event belongs to at most one article; unlinking keeps both rows', async () => {
		const { client } = await staff();
		const a = article(), e = event({ article_id: a.id });
		await save(client, a, e);
		expect(await rejected(save(client, null, event({ article_id: a.id })))).toBe('EVENT_ARTICLE_TAKEN');
		expect(await rejected(save(client, article(), event({ article_id: a.id })))).toBe('INVALID_NEWS');
		expect(await rejected(save(client, null, event({ article_id: uuid() })))).toBe('NEWS_NOT_FOUND');
		await save(client, null, { ...e, article_id: null, expected_revision: '1' });
		const { articles, events } = await client.query(api.news.list, {});
		expect(articles).toHaveLength(1);
		expect(events[0].article_id).toBeNull();
		// The freed article can take another event.
		await save(client, null, event({ article_id: a.id }));
	});

	test('input is checked: times, lists, references and images', async () => {
		const { client } = await staff();
		const bad = [
			event({ starts_at: '2026-11-05 18:00' }), event({ ends_at: '2026-11-05T17:00+01:00' }), event({ ends_at: '2027-01-10T18:00+01:00' }),
			event({ title: '  ' }), event({ location: 'a\u0007b' })
		];
		for (const e of bad) expect(await rejected(save(client, null, e))).toBe('INVALID_NEWS');
		expect(await rejected(save(client, article({ links: [{ label: 'x', url: 'http://example.no' }] }), null))).toBe('INVALID_NEWS');
		expect(await rejected(save(client, article({ slug: 'Not a slug' }), null))).toBe('INVALID_NEWS');
		expect(await rejected(save(client, article({ people: [uuid()] }), null))).toBe('NEWS_PERSON_NOT_FOUND');
		expect(await rejected(save(client, article({ images: [{ id: uuid(), alt: 'x' }] }), null))).toBe('NEWS_IMAGE_NOT_FOUND');
		expect(await rejected(save(client, article({ body: 'x'.repeat(20001) }), null))).toBe('INVALID_NEWS');

		const id = uuid();
		expect(await rejected(client.mutation(api.news.addImage, { id, contentType: 'image/jpeg', data: png(), width: 1, height: 1 }))).toBe('INVALID_NEWS_IMAGE');
		expect(await rejected(client.mutation(api.news.addImage, { id, contentType: 'image/png', data: png(), width: 5000, height: 1 }))).toBe('INVALID_NEWS_IMAGE');
		await client.mutation(api.news.addImage, { id, contentType: 'image/png', data: png(), width: 1, height: 1 });
		expect(await client.mutation(api.news.addImage, { id, contentType: 'image/png', data: png(), width: 1, height: 1 })).toBe(id);
		expect(await rejected(client.mutation(api.news.addImage, { id, contentType: 'image/png', data: png(1), width: 1, height: 1 })))
			.toBe('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT');
	});

	test('the feed and calendar page by cursor; ranges are bounded', async () => {
		const { client } = await staff();
		for (let i = 0; i < 5; i++) await save(client, article({ is_published: true }), null);
		const firstPage = await guest().query(api.news.feed, { before: null, limit: 3 });
		const last = firstPage.at(-1)!;
		const secondPage = await guest().query(api.news.feed, { before: { published_at: last.published_at, id: last.id }, limit: 3 });
		expect(firstPage).toHaveLength(3);
		expect(secondPage).toHaveLength(2);
		expect(new Set([...firstPage, ...secondPage].map((row) => row.id)).size).toBe(5);

		// A multi-day event that began before the range still shows; one that is over before it starts does not.
		await save(client, null, event({ starts_at: '2026-10-30T10:00Z', ends_at: '2026-11-02T10:00Z', is_published: true }));
		await save(client, null, event({ starts_at: '2026-10-31T10:00Z', ends_at: null, is_published: true }));
		for (let i = 0; i < 3; i++) await save(client, null, event({ starts_at: '2026-11-10T10:00Z', ends_at: null, is_published: true }));
		const range = { from: '2026-11-01T00:00Z', to: '2026-12-01T00:00Z' };
		const page = await guest().query(api.news.calendar, { ...range, after: null, limit: 2 });
		const rest = await guest().query(api.news.calendar, { ...range, after: { starts_at: page[1].starts_at, id: page[1].id }, limit: 10 });
		expect([...page, ...rest]).toHaveLength(4);
		expect(await rejected(guest().query(api.news.calendar, { from: '2026-01-01T00:00Z', to: '2027-03-01T00:00Z', after: null, limit: 10 }))).toBe('INVALID_EVENT_RANGE');
		expect(await rejected(guest().query(api.news.feed, { before: null, limit: 0 }))).toBe('INVALID_NEWS_PAGE_SIZE');
	});

	test('only staff write or read drafts', async () => {
		const { client: revoked } = await staff('Former', false);
		expect(await rejected(save(guest() as ConvexHttpClient, article(), null))).toBe('STAFF_REQUIRED');
		expect(await rejected(save(revoked, article(), null))).toBe('STAFF_REQUIRED');
		expect(await rejected(guest().query(api.news.list, {}))).toBe('STAFF_REQUIRED');
		expect(await rejected(guest().mutation(api.news.addImage, { id: uuid(), contentType: 'image/png', data: png(), width: 1, height: 1 }))).toBe('STAFF_REQUIRED');
		expect(await rejected(guest().query(api.news.adminImage, { id: uuid() }))).toBe('STAFF_REQUIRED');
	});
});
