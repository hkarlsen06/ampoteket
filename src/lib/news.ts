import { object, text, identifier } from './api';
import { api, type ConvexCaller } from './convex';
import { isSafeHttpsUrl, parseHelpContact, type HelpContact } from './help';
import { osloInstant } from './oslo-time';
import type { Locale } from './i18n/locales';

// Newsroom and event calendar: the public read protocol (docs/api-contract.md#news-and-events)
// and the date arithmetic both the pages and the admin editor share.

export type NewsImage = { id: string; alt: string; width: number; height: number };
export type NewsLink = { label: string; url: string };
export type NewsPerson = Omit<HelpContact, 'display_order'>;
export type EventSummary = { slug: string; title: string; starts_at: string; ends_at: string | null; location: string | null };
export type FeedEntry = { id: string; slug: string; title: string; author: string | null; summary: string | null; published_at: string; cover: NewsImage | null; event: EventSummary | null };
export type NewsArticle = Omit<FeedEntry, 'cover'> & { body: string; images: NewsImage[]; links: NewsLink[]; people: NewsPerson[] };
export type CalendarEvent = { id: string; slug: string; title: string; location: string | null; starts_at: string; ends_at: string | null; cover: NewsImage | null; article: { slug: string; title: string } | null };
export type EventDetail = Omit<CalendarEvent, 'cover' | 'article'> & {
	description: string; images: NewsImage[]; links: NewsLink[]; people: NewsPerson[];
	article: { slug: string; title: string; summary: string | null } | null;
};

export const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const OSLO = 'Europe/Oslo';

function optionalText(value: unknown, max: number): string | null {
	return value === null || value === undefined ? null : text(value, max);
}
function body(value: unknown, max: number): string {
	if (typeof value !== 'string' || [...value].length > max) throw new Error('Invalid news text');
	return value;
}
function slug(value: unknown): string {
	if (typeof value !== 'string' || value.length > 80 || !slugPattern.test(value)) throw new Error('Invalid news slug');
	return value;
}
export function timestamp(value: unknown): string {
	if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Invalid news time');
	return value;
}
function dimension(value: unknown): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 4096) throw new Error('Invalid image size');
	return value;
}
function list<T>(value: unknown, max: number, parse: (item: unknown) => T): T[] {
	if (!Array.isArray(value) || value.length > max) throw new Error('Invalid news list');
	return value.map(parse);
}
export function parseNewsImage(value: unknown): NewsImage {
	const row = object(value);
	return { id: identifier(row.id), alt: text(row.alt, 300), width: dimension(row.width), height: dimension(row.height) };
}
export function parseNewsLink(value: unknown): NewsLink {
	const row = object(value);
	const url = text(row.url, 500);
	if (!isSafeHttpsUrl(url)) throw new Error('Invalid news link');
	return { label: text(row.label, 80), url };
}
function parsePerson(value: unknown): NewsPerson {
	const { display_order: _, ...person } = parseHelpContact({ ...object(value), display_order: 0 });
	return person;
}
function parseEventSummary(value: unknown): EventSummary {
	const row = object(value);
	return { slug: slug(row.slug), title: text(row.title, 160), starts_at: timestamp(row.starts_at), ends_at: row.ends_at === null ? null : timestamp(row.ends_at), location: optionalText(row.location, 160) };
}
const nullable = <T>(value: unknown, parse: (item: unknown) => T): T | null => value === null || value === undefined ? null : parse(value);

export function parseFeedEntry(value: unknown): FeedEntry {
	const row = object(value);
	return { id: identifier(row.id), slug: slug(row.slug), title: text(row.title, 160), author: optionalText(row.author, 80), summary: optionalText(row.summary, 300),
		published_at: timestamp(row.published_at), cover: nullable(row.cover, parseNewsImage), event: nullable(row.event, parseEventSummary) };
}
export function parseNewsArticle(value: unknown): NewsArticle {
	const row = object(value);
	return { id: identifier(row.id), slug: slug(row.slug), title: text(row.title, 160), author: optionalText(row.author, 80), summary: optionalText(row.summary, 300),
		body: body(row.body, 20000), published_at: timestamp(row.published_at), images: list(row.images, 8, parseNewsImage),
		links: list(row.links, 10, parseNewsLink), people: list(row.people, 20, parsePerson), event: nullable(row.event, parseEventSummary) };
}
export function parseCalendarEvent(value: unknown): CalendarEvent {
	const row = object(value);
	const article = nullable(row.article, item => { const a = object(item); return { slug: slug(a.slug), title: text(a.title, 160) }; });
	return { ...parseEventSummary(row), id: identifier(row.id), cover: nullable(row.cover, parseNewsImage), article };
}
export function parseEventDetail(value: unknown): EventDetail {
	const row = object(value);
	const article = nullable(row.article, item => { const a = object(item); return { slug: slug(a.slug), title: text(a.title, 160), summary: optionalText(a.summary, 300) }; });
	return { ...parseEventSummary(row), id: identifier(row.id), description: body(row.description, 5000), images: list(row.images, 8, parseNewsImage),
		links: list(row.links, 10, parseNewsLink), people: list(row.people, 20, parsePerson), article };
}

export type FeedCursor = { published_at: string; id: string };
/** One page of the newsroom, newest first; `next` is set when an older page exists. */
export async function readNewsFeed(client: ConvexCaller, before: FeedCursor | null, pageSize = 12): Promise<{ entries: FeedEntry[]; next: FeedCursor | null }> {
	const rows: unknown[] = await client.query(api.news.feed, { before, limit: pageSize + 1 });
	if (rows.length > pageSize + 1) throw new Error('Invalid news page');
	const entries = rows.map(parseFeedEntry);
	if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('Invalid news page');
	const page = entries.slice(0, pageSize);
	const last = page.at(-1);
	return { entries: page, next: entries.length > pageSize && last ? { published_at: last.published_at, id: last.id } : null };
}
export async function readNewsArticle(client: ConvexCaller, articleSlug: string): Promise<NewsArticle | null> {
	if (!slugPattern.test(articleSlug) || articleSlug.length > 80) return null;
	const value = await client.query(api.news.article, { slug: articleSlug });
	return value === null ? null : parseNewsArticle(value);
}
export async function readEvent(client: ConvexCaller, eventSlug: string): Promise<EventDetail | null> {
	if (!slugPattern.test(eventSlug) || eventSlug.length > 80) return null;
	const value = await client.query(api.news.event, { slug: eventSlug });
	return value === null ? null : parseEventDetail(value);
}
/** Every published event overlapping [from, to); a short page is never evidence that traversal finished. */
export async function readEventCalendar(client: ConvexCaller, from: string, to: string): Promise<CalendarEvent[]> {
	const result: CalendarEvent[] = [];
	const seen = new Set<string>();
	let cursor: CalendarEvent | undefined;
	for (;;) {
		const rows: unknown[] = await client.query(api.news.calendar, { from, to, limit: 100, after: cursor ? { starts_at: cursor.starts_at, id: cursor.id } : null });
		if (rows.length > 100) throw new Error('Invalid calendar page');
		if (!rows.length) return result;
		for (const raw of rows) {
			const event = parseCalendarEvent(raw);
			if (seen.has(event.id) || (cursor && (Date.parse(event.starts_at) < Date.parse(cursor.starts_at)
				|| (event.starts_at === cursor.starts_at && event.id <= cursor.id)))) throw new Error('Invalid calendar cursor');
			seen.add(event.id); result.push(event); cursor = event;
		}
	}
}

/** Served by the Worker (src/routes/api/news/images/[id]); only images a published page shows. */
export const newsImageUrl = (id: string) => `/api/news/images/${id}`;

/** Paragraphs of a plain-text body: a blank line starts a new one, single line breaks stay. */
export function paragraphs(value: string): string[] {
	return value.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n+/).map(part => part.trim()).filter(Boolean);
}

// A paragraph of its own, `[image:<id>]`, places one of the article's images (convex/news.ts).
const imageMarker = /^\[image:([^\]]*)\]$/;
export type ArticleBlock = { type: 'text'; text: string } | { type: 'image'; image: NewsImage };
/** An article body as paragraphs and placed images; a marker for an image the article lacks shows nothing. */
export function articleBlocks(value: string, images: NewsImage[]): ArticleBlock[] {
	return paragraphs(value).flatMap((paragraph): ArticleBlock[] => {
		const id = imageMarker.exec(paragraph)?.[1];
		if (id === undefined) return [{ type: 'text', text: paragraph }];
		const image = images.find(item => item.id === id);
		return image ? [{ type: 'image', image }] : [];
	});
}
/** The ids an article body places. */
export const placedImages = (value: string): Set<string> =>
	new Set(paragraphs(value).flatMap(paragraph => imageMarker.exec(paragraph)?.[1] ?? []));

/** A readable, permanent address from a title: æ, ø and å spelt out, at most 60 characters. */
export function slugify(title: string): string {
	// Soft hyphens are line-break hints in long Norwegian words, not word breaks.
	const base = title.replace(/\u00ad/g, '').toLowerCase().replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a')
		.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	return base.slice(0, 60).replace(/-+$/, '') || 'post';
}
/** The first free slug among `base`, `base-2`, `base-3`, …; the database's unique key is the backstop. */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
	if (!taken.has(base)) return base;
	for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

// ---------- Oslo calendar arithmetic ----------

/** `YYYY-MM-DD` of an instant in Oslo. */
export function osloDay(instant: string | Date): string {
	const parts = new Intl.DateTimeFormat('en-CA', { timeZone: OSLO, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant));
	const part = (type: string) => parts.find(item => item.type === type)?.value ?? '';
	return `${part('year')}-${part('month')}-${part('day')}`;
}
/** Midnight in Oslo at the start of a `YYYY-MM-DD` day, as an ISO instant (never ambiguous: DST shifts at 02:00–03:00). */
export const osloMidnight = (day: string) => osloInstant(`${day}T00:00`);

export type Month = { year: number; month: number };
export const monthKey = ({ year, month }: Month) => `${year}-${String(month).padStart(2, '0')}`;
export function parseMonth(value: string | null): Month | null {
	const match = value?.match(/^(\d{4})-(\d{2})$/);
	if (!match) return null;
	const year = Number(match[1]), month = Number(match[2]);
	return year >= 2020 && year <= 2100 && month >= 1 && month <= 12 ? { year, month } : null;
}
export function addMonths({ year, month }: Month, delta: number): Month {
	const index = year * 12 + month - 1 + delta;
	return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}
export const monthOf = (instant: string | Date): Month => {
	const [year, month] = osloDay(instant).split('-').map(Number);
	return { year, month };
};
/** Calendar arithmetic on plain dates, in UTC so no local zone can shift a day. */
function shiftDay(day: string, delta: number): string {
	const date = new Date(`${day}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + delta);
	return date.toISOString().slice(0, 10);
}
/** Monday-first weeks covering the month, so the grid always has whole rows. */
export function monthGrid(month: Month): { day: string; inMonth: boolean }[][] {
	const first = `${monthKey(month)}-01`, next = `${monthKey(addMonths(month, 1))}-01`;
	const weekday = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7;
	const weeks: { day: string; inMonth: boolean }[][] = [];
	for (let day = shiftDay(first, -weekday); day < next;) {
		const week: { day: string; inMonth: boolean }[] = [];
		for (let i = 0; i < 7; i++) { week.push({ day, inMonth: day >= first && day < next }); day = shiftDay(day, 1); }
		weeks.push(week);
	}
	return weeks;
}
/** The Oslo days an event touches; one ending exactly at midnight does not touch the next day. */
export function eventDays(event: { starts_at: string; ends_at: string | null }): string[] {
	const first = osloDay(event.starts_at);
	const last = event.ends_at ? osloDay(new Date(Date.parse(event.ends_at) - 1)) : first;
	const days = [first];
	while (days.at(-1)! < last && days.length < 63) days.push(shiftDay(days.at(-1)!, 1));
	return days;
}
/** Whether an event has not finished at `now`. */
export const upcoming = (event: { starts_at: string; ends_at: string | null }, now: Date) => Date.parse(event.ends_at ?? event.starts_at) >= now.valueOf();

// ---------- Display ----------

const intlLocale = (locale: Locale) => (locale === 'nb' ? 'nb-NO' : 'en-GB');
const capitalize = (value: string) => value.charAt(0).toLocaleUpperCase() + value.slice(1);
/** «torsdag 5. november 2026, 18:00–21:00»; a multi-day event names both days. */
export function formatEventWhen(event: { starts_at: string; ends_at: string | null }, locale: Locale): string {
	const format = new Intl.DateTimeFormat(intlLocale(locale), { timeZone: OSLO, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
	return capitalize(event.ends_at ? format.formatRange(new Date(event.starts_at), new Date(event.ends_at)) : format.format(new Date(event.starts_at)));
}
/** The hours alone, for a list already grouped by day; a multi-day event keeps its dates. */
export function formatEventHours(event: { starts_at: string; ends_at: string | null }, locale: Locale): string {
	if (event.ends_at && eventDays(event).length > 1) return formatEventWhen(event, locale);
	const format = new Intl.DateTimeFormat(intlLocale(locale), { timeZone: OSLO, hour: '2-digit', minute: '2-digit' });
	return event.ends_at ? format.formatRange(new Date(event.starts_at), new Date(event.ends_at)) : format.format(new Date(event.starts_at));
}
/**
 * Beside a date mark that already shows the first day: «Torsdag 18:00–21:00»; within
 * a week the weekdays tell the days apart («Lør. 10:00–søn. 16:00»); longer, the dates.
 */
export function formatEventShort(event: { starts_at: string; ends_at: string | null }, locale: Locale): string {
	const start = new Date(event.starts_at), end = event.ends_at ? new Date(event.ends_at) : null;
	const days = eventDays(event).length;
	if (end && days > 7) {
		return capitalize(new Intl.DateTimeFormat(intlLocale(locale), { timeZone: OSLO, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).formatRange(start, end));
	}
	if (end && days > 1) {
		const weekday = new Intl.DateTimeFormat(intlLocale(locale), { timeZone: OSLO, weekday: 'short' });
		const time = new Intl.DateTimeFormat(intlLocale(locale), { timeZone: OSLO, hour: '2-digit', minute: '2-digit' });
		return capitalize(`${weekday.format(start)} ${time.format(start)}–${weekday.format(end)} ${time.format(end)}`);
	}
	const weekday = new Intl.DateTimeFormat(intlLocale(locale), { timeZone: OSLO, weekday: 'long' }).format(start);
	return capitalize(`${weekday} ${formatEventHours(event, locale)}`);
}
/** «17. oktober 2026 kl. 21:40», «17 October 2026 at 21:40» */
export function formatPublished(instant: string, locale: Locale): string {
	return new Intl.DateTimeFormat(intlLocale(locale), { timeZone: OSLO, dateStyle: 'long', timeStyle: 'short' }).format(new Date(instant));
}
/** «Torsdag 5. november» for a `YYYY-MM-DD` day. */
export function formatDay(day: string, locale: Locale): string {
	return capitalize(new Intl.DateTimeFormat(intlLocale(locale), { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${day}T12:00:00Z`)));
}
/** «Oktober 2026» */
export function formatMonth(month: Month, locale: Locale): string {
	return capitalize(new Intl.DateTimeFormat(intlLocale(locale), { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(`${monthKey(month)}-15T12:00:00Z`)));
}
