import { object, text, identifier, uuidPattern } from './api';
import { api, errorCode, type StaffSession } from './convex';
import { parseNewsLink, slugPattern, timestamp, type NewsLink } from './news';

// Staff side of the newsroom (docs/api-contract.md#news-and-events): complete reads of
// both lists, the persisted news.save command, and image preparation and upload.

export type ImageRef = { id: string; alt: string };
type Common = { id: string; slug: string; title: string; images: ImageRef[]; links: NewsLink[]; people: string[]; is_published: boolean; edit_revision: string; updated_at: string };
export type AdminArticle = Common & { summary: string | null; body: string; published_at: string | null };
export type AdminEvent = Common & { description: string; location: string | null; starts_at: string; ends_at: string | null; article_id: string | null };

function imageRef(value: unknown): ImageRef {
	const row = object(value);
	return { id: identifier(row.id), alt: text(row.alt, 300) };
}
function list<T>(value: unknown, max: number, parse: (item: unknown) => T): T[] {
	if (!Array.isArray(value) || value.length > max) throw new Error('Invalid news list');
	return value.map(parse);
}
function common(row: Record<string, unknown>): Common {
	if (typeof row.slug !== 'string' || !slugPattern.test(row.slug) || typeof row.is_published !== 'boolean'
		|| typeof row.edit_revision !== 'string' || !/^[1-9]\d*$/.test(row.edit_revision)) throw new Error('Invalid news row');
	return { id: identifier(row.id), slug: row.slug, title: text(row.title, 160), images: list(row.images, 8, imageRef), links: list(row.links, 10, parseNewsLink),
		people: list(row.people, 20, identifier), is_published: row.is_published, edit_revision: row.edit_revision, updated_at: timestamp(row.updated_at) };
}
function longText(value: unknown, max: number): string {
	if (typeof value !== 'string' || [...value].length > max) throw new Error('Invalid news text');
	return value;
}
export function parseAdminArticle(value: unknown): AdminArticle {
	const row = object(value);
	return { ...common(row), summary: row.summary === null ? null : text(row.summary, 300), body: longText(row.body, 20000),
		published_at: row.published_at === null ? null : timestamp(row.published_at) };
}
export function parseAdminEvent(value: unknown): AdminEvent {
	const row = object(value);
	return { ...common(row), description: longText(row.description, 5000), location: row.location === null ? null : text(row.location, 160),
		starts_at: timestamp(row.starts_at), ends_at: row.ends_at === null ? null : timestamp(row.ends_at), article_id: row.article_id === null ? null : identifier(row.article_id) };
}
/** Every article and event, drafts included. */
export async function readAdminNews(session: StaffSession): Promise<{ articles: AdminArticle[]; events: AdminEvent[] }> {
	const { articles, events } = await session.client.query(api.news.list, {});
	return { articles: articles.map(parseAdminArticle), events: events.map(parseAdminEvent) };
}

export type ImageType = 'image/webp' | 'image/jpeg' | 'image/png';
const imageTypes = ['image/webp', 'image/jpeg', 'image/png'];
/** The stored bytes, for previews in the editor; the public endpoint serves only published images. */
export async function readNewsImage(session: StaffSession, id: string): Promise<Blob> {
	if (!uuidPattern.test(id)) throw new Error('Invalid image id');
	const row = await session.client.query(api.news.adminImage, { id });
	if (!row || !imageTypes.includes(row.content_type) || !(row.data instanceof ArrayBuffer)) throw new Error('Unknown image');
	return new Blob([row.data], { type: row.content_type });
}

export type PreparedImage = { blob: Blob; type: ImageType; width: number; height: number };
/** Re-encodes in the browser: at most 1600 px and 1 MB, and no EXIF or GPS left in the file. */
export async function prepareImage(file: Blob): Promise<PreparedImage> {
	const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
	try {
		let scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
		for (let attempt = 0; attempt < 6; attempt++) {
			const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
			const canvas = document.createElement('canvas');
			canvas.width = width; canvas.height = height;
			canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
			const quality = 0.85 - attempt * 0.05;
			// Browsers without a WebP encoder return PNG; JPEG is then the compact fallback.
			let blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', quality));
			if (blob?.type !== 'image/webp') blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
			if (!blob || !['image/webp', 'image/jpeg'].includes(blob.type)) break;
			if (blob.size <= 1_000_000) return { blob, type: blob.type as ImageType, width, height };
			scale *= 0.8;
		}
		throw new Error('Image too large');
	} finally { bitmap.close(); }
}
/** The id is chosen before sending, so a retry of a lost response stores nothing twice. */
export async function uploadNewsImage(session: StaffSession, id: string, image: PreparedImage): Promise<void> {
	const result = await session.client.mutation(api.news.addImage, { id, contentType: image.type, data: await image.blob.arrayBuffer(), width: image.width, height: image.height });
	if (result !== id) throw new Error('Invalid image response');
}

export type ArticleWrite = { id: string; slug: string; title: string; summary: string | null; body: string; images: ImageRef[]; links: NewsLink[]; people: string[]; is_published: boolean; expected_revision: string | null };
export type EventWrite = { id: string; slug: string; title: string; description: string; location: string | null; starts_at: string; ends_at: string | null; article_id: string | null;
	images: ImageRef[]; links: NewsLink[]; people: string[]; is_published: boolean; expected_revision: string | null };
export type NewsCommand = { userId: string; requestId: string; article: ArticleWrite | null; event: EventWrite | null };
export type SavedNews = { article: { id: string; slug: string; edit_revision: string } | null; event: { id: string; slug: string; edit_revision: string } | null };

const commandKey = 'ampoteket:admin-news-save:v1';
function revision(value: unknown): string | null {
	if (value === null) return null;
	if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw new Error('Invalid revision');
	return value;
}
function optional(value: unknown, max: number): string | null { return value === null ? null : text(value, max); }
function parseArticleWrite(value: unknown): ArticleWrite {
	const row = object(value);
	if (typeof row.slug !== 'string' || !slugPattern.test(row.slug) || typeof row.is_published !== 'boolean') throw new Error('Invalid article');
	return { id: identifier(row.id), slug: row.slug, title: text(row.title, 160), summary: optional(row.summary, 300), body: longText(row.body, 20000),
		images: list(row.images, 8, imageRef), links: list(row.links, 10, parseNewsLink), people: list(row.people, 20, identifier), is_published: row.is_published, expected_revision: revision(row.expected_revision) };
}
function parseEventWrite(value: unknown): EventWrite {
	const row = object(value);
	if (typeof row.slug !== 'string' || !slugPattern.test(row.slug) || typeof row.is_published !== 'boolean') throw new Error('Invalid event');
	return { id: identifier(row.id), slug: row.slug, title: text(row.title, 160), description: longText(row.description, 5000), location: optional(row.location, 160),
		starts_at: timestamp(row.starts_at), ends_at: row.ends_at === null ? null : timestamp(row.ends_at), article_id: row.article_id === null ? null : identifier(row.article_id),
		images: list(row.images, 8, imageRef), links: list(row.links, 10, parseNewsLink), people: list(row.people, 20, identifier), is_published: row.is_published, expected_revision: revision(row.expected_revision) };
}
function parseNewsCommand(value: unknown): NewsCommand {
	const row = object(value);
	const command = { userId: identifier(row.userId), requestId: identifier(row.requestId),
		article: row.article === null ? null : parseArticleWrite(row.article), event: row.event === null ? null : parseEventWrite(row.event) };
	if (!command.article && !command.event) throw new Error('Empty news command');
	return command;
}
export function readNewsCommand(storage: Pick<Storage, 'getItem'>): NewsCommand | null {
	const raw = storage.getItem(commandKey);
	return raw ? parseNewsCommand(JSON.parse(raw)) : null;
}
/** Persist the exact command before sending, so a lost response is retried, never rebuilt. */
export function saveNewsCommand(storage: Pick<Storage, 'getItem' | 'setItem'>, command: NewsCommand): NewsCommand {
	const expected = parseNewsCommand(command);
	storage.setItem(commandKey, JSON.stringify(expected));
	const saved = readNewsCommand(storage);
	if (!saved || JSON.stringify(saved) !== JSON.stringify(expected)) throw new Error('News command persistence unavailable');
	return saved;
}
export function clearNewsCommand(storage: Pick<Storage, 'getItem' | 'removeItem'>, command: NewsCommand): void {
	const saved = readNewsCommand(storage);
	if (saved?.requestId === command.requestId) storage.removeItem(commandKey);
}
function savedPart(value: unknown) {
	if (value === null) return null;
	const row = object(value);
	if (typeof row.slug !== 'string' || !slugPattern.test(row.slug)) throw new Error('Invalid save result');
	return { id: identifier(row.id), slug: row.slug, edit_revision: revision(row.edit_revision)! };
}
export async function saveNews(session: StaffSession, command: NewsCommand): Promise<SavedNews> {
	if (session.userId !== command.userId) throw new Error('News command identity changed');
	const result = await session.client.mutation(api.news.save, { requestId: command.requestId, article: command.article, event: command.event });
	const saved = { article: savedPart(result.article), event: savedPart(result.event) };
	if (saved.article?.id !== command.article?.id || saved.event?.id !== command.event?.id) throw new Error('Invalid save result');
	return saved;
}

/** The rejection's code, if it is one of `names`; null for anything else, including an unknown outcome. */
export function newsError<T extends string>(error: unknown, names: readonly T[]): T | null {
	const code = errorCode(error);
	return names.find(name => name === code) ?? null;
}
