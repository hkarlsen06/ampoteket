import { afterEach, expect, test } from 'bun:test';
import { GET } from './+server';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// A one-entry Cache API stand-in; waitUntil runs the put immediately.
function platform() {
	const store = new Map<string, Response>();
	const cache = {
		match: async (key: string) => store.get(key)?.clone(),
		put: async (key: string, response: Response) => { store.set(key, response); }
	};
	return { caches: { default: cache }, ctx: { waitUntil: (promise: Promise<unknown>) => promise } };
}
const call = (p: ReturnType<typeof platform>) =>
	(GET as (event: unknown) => Promise<Response>)({ platform: p, url: new URL('https://ampoteket.no/api/discord') });
const read = async (response: Response) => (await response.json()) as Record<string, unknown>;
const discord = (online: number | null) => {
	let calls = 0;
	globalThis.fetch = (async () => {
		calls++;
		return online === null ? new Response('{"retry_after":5}', { status: 429 })
			: Response.json({ presence_count: online, members: [{ username: 'A', status: 'idle' }] });
	}) as unknown as typeof fetch;
	return () => calls;
};

test('a refused refresh serves the last good answer, and only a cold cache reports unavailable', async () => {
	const p = platform();
	discord(36);
	expect(await read(await call(p))).toEqual({ online: 36, members: [{ name: 'A', status: 'idle', avatar: null }] });

	// Within a minute the kept answer is reused without asking Discord.
	const calls = discord(null);
	expect((await read(await call(p))).online).toBe(36);
	expect(calls()).toBe(0);

	// Once stale, a refusal still serves the kept answer.
	const realNow = Date.now;
	Date.now = () => realNow() + 61_000;
	try {
		const response = await call(p);
		expect(response.status).toBe(200);
		expect((await read(response)).online).toBe(36);
	} finally { Date.now = realNow; }

	const cold = await call(platform());
	expect(cold.status).toBe(502);
	expect(await read(cold)).toEqual({ online: null });
});
