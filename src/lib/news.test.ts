import { expect, test } from 'bun:test';
import {
	addMonths, eventDays, formatEventHours, formatEventWhen, monthGrid, osloMidnight, paragraphs, parseMonth, parseNewsArticle,
	readEventCalendar, readNewsFeed, slugify, uniqueSlug
} from './news';
import { clearNewsCommand, newsError, readNewsCommand, saveNewsCommand, type NewsCommand } from './admin-news';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { rejection, type ConvexCaller } from './convex';

/** A client whose public queries answer from `answer`; writes fail the test. */
function stub(answer: (name: string, args: Record<string, unknown>) => unknown): ConvexCaller {
	const unexpected = async () => { throw new Error('Unexpected write'); };
	return { query: async (fn: FunctionReference<'query'>, args: Record<string, unknown>) => answer(getFunctionName(fn), args), mutation: unexpected, action: unexpected } as unknown as ConvexCaller;
}
const event = { id: '11111111-1111-4111-8111-111111111111', slug: 'soldering-night', title: 'Soldering night', location: 'PS126',
	starts_at: '2026-11-05T17:00:00+00:00', ends_at: '2026-11-05T20:00:00+00:00', cover: null, article: null };

test('slugs spell out Norwegian letters, stay short and avoid taken addresses', () => {
	expect(slugify('Lodde­kurs for nybegynnere: Ærlig talt, på øvre plan!')).toBe('loddekurs-for-nybegynnere-aerlig-talt-pa-ovre-plan');
	expect(slugify('Café ÅPENT')).toBe('cafe-apent');
	expect(slugify('!!!')).toBe('post');
	expect(slugify('a'.repeat(70) + ' b').length).toBeLessThanOrEqual(60);
	expect(uniqueSlug('kurs', new Set(['kurs', 'kurs-2']))).toBe('kurs-3');
	expect(uniqueSlug('kurs', new Set())).toBe('kurs');
});

test('a blank line starts a paragraph; single line breaks stay inside it', () => {
	expect(paragraphs('One\nstill one\r\n\r\n  Two  \n \n\n\nThree')).toEqual(['One\nstill one', 'Two', 'Three']);
	expect(paragraphs('  \n\n ')).toEqual([]);
});

test('month grids are whole Monday-first weeks, across DST and year ends', () => {
	const october = monthGrid({ year: 2026, month: 10 });
	expect(october[0][0]).toEqual({ day: '2026-09-28', inMonth: false });
	expect(october.at(-1)!.at(-1)).toEqual({ day: '2026-11-01', inMonth: false });
	expect(october.every(week => week.length === 7)).toBe(true);
	expect(october.flat().filter(day => day.inMonth)).toHaveLength(31);
	// February 2027 starts on a Monday and fills exactly four weeks.
	expect(monthGrid({ year: 2027, month: 2 })).toHaveLength(4);
	expect(addMonths({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
	expect(addMonths({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
	expect(parseMonth('2026-13')).toBeNull();
	expect(parseMonth('2026-1')).toBeNull();
	expect(parseMonth('2026-02')).toEqual({ year: 2026, month: 2 });
	// Oslo midnight is UTC+2 in summer time and UTC+1 after the clocks go back on 25 October.
	expect(osloMidnight('2026-10-25')).toBe('2026-10-24T22:00:00.000Z');
	expect(osloMidnight('2026-10-26')).toBe('2026-10-25T23:00:00.000Z');
});

test('events cover the Oslo days they touch, and an end at midnight stays on its day', () => {
	expect(eventDays({ starts_at: '2026-11-05T22:30:00Z', ends_at: null })).toEqual(['2026-11-05']);
	expect(eventDays({ starts_at: '2026-11-05T23:30:00Z', ends_at: null })).toEqual(['2026-11-06']);
	expect(eventDays({ starts_at: '2026-11-05T17:00:00Z', ends_at: '2026-11-06T23:00:00Z' })).toEqual(['2026-11-05', '2026-11-06']);
	expect(eventDays({ starts_at: '2026-11-05T17:00:00Z', ends_at: '2026-11-07T11:00:00Z' })).toEqual(['2026-11-05', '2026-11-06', '2026-11-07']);
	expect(formatEventHours(event, 'nb')).toBe('18:00–21:00');
	expect(formatEventWhen(event, 'en')).toContain('5 November 2026');
});

test('calendar traversal continues through full pages and rejects a cursor that does not advance', async () => {
	let requests = 0;
	const later = { ...event, id: '22222222-2222-4222-8222-222222222222', starts_at: '2026-11-06T17:00:00+00:00', ends_at: null };
	const events = await readEventCalendar(stub((name, args) => {
		expect(name).toBe('news:calendar');
		if (requests++ === 0) { expect(args.after).toBeNull(); return [event]; }
		if (requests === 2) { expect(args.after).toEqual({ starts_at: event.starts_at, id: event.id }); return [later]; }
		return [];
	}), '2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z');
	expect(events.map(row => row.id)).toEqual([event.id, later.id]);
	await expect(readEventCalendar(stub(() => [event]), '2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z')).rejects.toThrow('cursor');
	await expect(readEventCalendar(stub(() => { throw new Error('offline'); }), '2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z')).rejects.toThrow();
});

test('the newsroom reads one extra row to know whether an older page exists', async () => {
	const entry = (n: number) => ({ id: `${n}0000000-0000-4000-8000-000000000000`, slug: `post-${n}`, title: `Post ${n}`, summary: null, published_at: `2026-10-0${n}T12:00:00+00:00`, cover: null, event: null });
	const page = await readNewsFeed(stub((name, args) => {
		expect(name).toBe('news:feed');
		expect(args).toEqual({ before: null, limit: 3 });
		return [entry(3), entry(2), entry(1)];
	}), null, 2);
	expect(page.entries.map(row => row.slug)).toEqual(['post-3', 'post-2']);
	expect(page.next).toEqual({ published_at: entry(2).published_at, id: entry(2).id });
	expect((await readNewsFeed(stub(() => [entry(1)]), null, 2)).next).toBeNull();
});

test('articles reject unsafe links and malformed images', () => {
	const article = { id: event.id, slug: 'post', title: 'Post', summary: null, body: '', published_at: '2026-10-01T12:00:00+00:00',
		images: [{ id: event.id, alt: 'A bench', width: 1600, height: 900 }], links: [{ label: 'Sign up', url: 'https://example.invalid/a' }], people: [], event: null };
	expect(parseNewsArticle(article).images[0]).toEqual({ id: event.id, alt: 'A bench', width: 1600, height: 900 });
	for (const url of ['javascript:alert(1)', 'http://example.invalid', 'https://user:pass@example.invalid/']) {
		expect(() => parseNewsArticle({ ...article, links: [{ label: 'Bad', url }] })).toThrow();
	}
	expect(() => parseNewsArticle({ ...article, images: [{ ...article.images[0], width: 0 }] })).toThrow();
	expect(() => parseNewsArticle({ ...article, slug: 'Not a slug' })).toThrow();
});

test('a save command survives a reload and is cleared only by its own request', () => {
	const values = new Map<string, string>();
	const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
	const command: NewsCommand = { userId: event.id, requestId: '33333333-3333-4333-8333-333333333333', event: null, article: {
		id: event.id, slug: 'post', title: 'Post', summary: null, body: 'Text', images: [], links: [], people: [], is_published: true, expected_revision: '4' } };
	expect(saveNewsCommand(storage, command)).toEqual(command);
	expect(readNewsCommand(storage)).toEqual(command);
	clearNewsCommand(storage, { ...command, requestId: '44444444-4444-4444-8444-444444444444' });
	expect(readNewsCommand(storage)).toEqual(command);
	clearNewsCommand(storage, command);
	expect(readNewsCommand(storage)).toBeNull();
	expect(newsError(rejection('STALE_NEWS'), ['STALE_NEWS'])).toBe('STALE_NEWS');
	expect(newsError(rejection('NEWS_IMAGE_NOT_FOUND', 'NEWS_IMAGE_NOT_FOUND: <id>'), ['STALE_NEWS', 'NEWS_IMAGE_NOT_FOUND'])).toBe('NEWS_IMAGE_NOT_FOUND');
	expect(newsError(new Error('offline'), ['STALE_NEWS'])).toBeNull();
});
