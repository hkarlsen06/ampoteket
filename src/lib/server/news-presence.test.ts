import { expect, test } from 'bun:test';
import { getFunctionName, type FunctionReference } from 'convex/server';
import type { ConvexCaller } from '#lib/convex.js';
import { hasPublishedNews } from './news-presence';

const entry = { id: '11111111-1111-4111-8111-111111111111', slug: 'post', title: 'Post', author: null, summary: null,
	published_at: '2026-10-17T19:40:00.000000Z', cover: null, event: null };
function client(answer: () => Promise<unknown[]>) {
	let reads = 0;
	const caller = { query: async (fn: FunctionReference<'query'>) => { expect(getFunctionName(fn)).toBe('news:feed'); reads++; return answer(); } } as unknown as ConvexCaller;
	return { caller, reads: () => reads };
}

test('the homepage asks about published news at most once a minute and never waits long', async () => {
	let start = 1_000_000;
	const one = client(async () => [entry]);
	expect(await hasPublishedNews(one.caller, start)).toBe(true);
	expect(await hasPublishedNews(one.caller, start + 59_000)).toBe(true);
	expect(one.reads()).toBe(1);

	// After a minute it asks again; nothing published hides the link.
	start += 60_000;
	expect(await hasPublishedNews(client(async () => []).caller, start)).toBe(false);
	// A failed read keeps the last answer once it is stale.
	start += 60_000;
	expect(await hasPublishedNews(client(async () => { throw new Error('down'); }).caller, start)).toBe(false);
	// A slow read gives up after 300 ms with the last answer, and its result still counts later.
	const slow = client(() => new Promise(resolve => setTimeout(() => resolve([entry]), 600)));
	const began = performance.now();
	expect(await hasPublishedNews(slow.caller, start)).toBe(false);
	expect(performance.now() - began).toBeLessThan(500);
	await new Promise(resolve => setTimeout(resolve, 400));
	expect(await hasPublishedNews(slow.caller, start + 1000)).toBe(true);
	expect(slow.reads()).toBe(1);
	// Without a backend there is no link.
	expect(await hasPublishedNews(null, start + 200_000)).toBe(false);
});
