import { afterEach, expect, mock, spyOn, test } from 'bun:test';

mock.module('cloudflare:workers', () => ({ waitUntil: () => {} }));
const { GET } = await import('./+server');
import { GET as avatar } from './avatar/[...path]/+server';

const realFetch = globalThis.fetch;
const realNow = Date.now;
const realTimeout = AbortSignal.timeout;
afterEach(() => { globalThis.fetch = realFetch; Date.now = realNow; AbortSignal.timeout = realTimeout; });

// Cache API stand-in with expiry; the put starts immediately.
function platform() {
	const store = new Map<string, { response: Response; expires: number }>();
	const cache = {
		match: async (key: string) => {
			const saved = store.get(key);
			return saved && saved.expires > Date.now() ? saved.response.clone() : undefined;
		},
		put: async (key: string, response: Response) => {
			store.set(key, { response, expires: Date.now() + Number(response.headers.get('Cache-Control')?.match(/max-age=(\d+)/)?.[1]) * 1000 });
		}
	};
	return { default: cache };
}
const call = (p: ReturnType<typeof platform>) => {
	Object.assign(globalThis, { caches: p });
	return (GET as (event: unknown) => Promise<Response>)({ url: new URL('https://ampoteket.no/api/discord') });
};
const read = async (response: Response) => (await response.json()) as Record<string, unknown>;
// Each call answers with the next status; a number is a good widget with that many online.
const discord = (...answers: (number | 429 | 503)[]) => {
	let calls = 0;
	globalThis.fetch = (async () => {
		const answer = answers[Math.min(calls++, answers.length - 1)];
		return answer === 429 || answer === 503 ? Response.json({ retry_after: 0.3 }, { status: answer })
			: Response.json({ presence_count: answer, members: [{ username: 'A', status: 'idle' }] });
	}) as unknown as typeof fetch;
	return () => calls;
};

test('a refused refresh serves the last good answer, and only a cold cache reports unavailable', async () => {
	const p = platform();
	discord(36);
	expect(await read(await call(p))).toEqual({ online: 36, members: [{ name: 'A', status: 'idle', avatar: null }] });

	// Within a minute the kept answer is reused without asking Discord.
	const calls = discord(503);
	expect((await read(await call(p))).online).toBe(36);
	expect(calls()).toBe(0);

	// Once stale, a refusal still serves the kept answer.
	Date.now = () => realNow() + 61_000;
	try {
		const response = await call(p);
		expect(response.status).toBe(200);
		expect((await read(response)).online).toBe(36);
	} finally { Date.now = realNow; }

	discord(503);
	const cold = await call(platform());
	expect(cold.status).toBe(502);
	expect(await read(cold)).toEqual({ online: null });
});

test('a throttled cold data centre retries until Discord answers, and gives up after five tries', async () => {
	const calls = discord(429, 429, 25);
	expect((await read(await call(platform()))).online).toBe(25);
	expect(calls()).toBe(3);

	const refusals = discord(429);
	expect((await call(platform())).status).toBe(502);
	expect(refusals()).toBe(5);
});

test('cold and stale failures cool down, recover after a minute, and never extend stale retention', async () => {
	let now = realNow(); Date.now = () => now;
	for (const warm of [false, true]) {
		const p = platform();
		if (warm) { discord(36); await call(p); now += 61_000; }
		const refused = discord(503);
		for (let repeat = 0; repeat < 3; repeat++) {
			const response = await call(p);
			expect(response.status).toBe(warm ? 200 : 502);
			expect((await read(response)).online).toBe(warm ? 36 : null);
		}
		expect(refused()).toBe(1);
		now += 61_000;
		const recovered = discord(42);
		expect((await read(await call(p))).online).toBe(42);
		expect(recovered()).toBe(1);
		now += 3_601_000;
		discord(503);
		expect((await call(p)).status).toBe(502);
	}
});

test('widget refresh deadlines cover stalled headers and bodies and enter the failure cooldown', async () => {
	spyOn(AbortSignal, 'timeout').mockImplementation((ms) => { expect(ms).toBe(5000); return realTimeout(5); });
	for (const body of [false, true]) {
		const p = platform(); let calls = 0;
		globalThis.fetch = (async (_input, init) => {
			calls++;
			const signal = init?.signal;
			expect(signal).toBeInstanceOf(AbortSignal);
			if (!body) return new Promise<Response>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
			return new Response(new ReadableStream({ start(controller) {
				signal!.addEventListener('abort', () => controller.error(signal!.reason), { once: true });
			} }));
		}) as typeof fetch;
		expect((await call(p)).status).toBe(502);
		expect((await call(p)).status).toBe(502);
		expect(calls).toBe(1);
	}
});

test('avatar failures are bounded through body consumption and a later request can recover', async () => {
	spyOn(AbortSignal, 'timeout').mockImplementation((ms) => { expect(ms).toBe(5000); return realTimeout(5); });
	const callAvatar = (path = 'user/image') => (avatar as (event: unknown) => Promise<Response>)({ params: { path } });
	for (const body of [false, true]) {
		globalThis.fetch = (async (_input, init) => {
			const signal = init?.signal;
			expect(signal).toBeInstanceOf(AbortSignal);
			if (!body) return new Promise<Response>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
			return new Response(new ReadableStream({ start(controller) {
				signal!.addEventListener('abort', () => controller.error(signal!.reason), { once: true });
			} }), { headers: { 'Content-Type': 'image/png' } });
		}) as typeof fetch;
		await expect(callAvatar()).rejects.toMatchObject({ status: 502 });
	}
	let calls = 0;
	globalThis.fetch = (async (input) => {
		calls++;
		expect(String(input)).toBe('https://cdn.discordapp.com/widget-avatars/user/image?size=64');
		return new Response('image', { headers: { 'Content-Type': 'image/png' } });
	}) as typeof fetch;
	const response = await callAvatar();
	expect(await response.text()).toBe('image');
	expect(response.headers.get('Cache-Control')).toBe('public, max-age=86400, immutable');
	await expect(callAvatar('../outside')).rejects.toMatchObject({ status: 404 });
	expect(calls).toBe(1);
});
