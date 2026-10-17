import { describe, expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { passwordLinkToken, signInFailure } from './admin-auth';
import { rejection } from './convex';
import { authStorageKeys, ConvexAuthSession, mayHaveSession, type AuthStorage } from './convex-auth';

const url = 'https://happy-otter-123.convex.cloud';
const keys = authStorageKeys(url);
function memoryStorage(initial: Record<string, string> = {}): AuthStorage & { values: Record<string, string> } {
	const values = { ...initial };
	return { values, getItem: (k) => values[k] ?? null, setItem: (k, v) => { values[k] = v; }, removeItem: (k) => { delete values[k]; } };
}
/** One lock at a time, like navigator.locks within a browser. */
function locks() {
	let chain = Promise.resolve();
	return { request<T>(_name: string, callback: () => Promise<T>) { const result = chain.then(callback); chain = result.then(() => {}, () => {}); return result; } };
}

test('sign-in failures separate a refused login from an unreachable service', () => {
	expect(signInFailure(rejection('INVALID_CREDENTIALS'))).toBe('invalid');
	expect(signInFailure(rejection('SOMETHING_ELSE'))).toBe('unavailable');
	expect(signInFailure(new TypeError('Failed to fetch'))).toBe('unavailable');
	expect(signInFailure(new Error('[Request ID: x] Server Error'))).toBe('unavailable');
	expect(signInFailure(null)).toBe('unavailable');
});

test('password links carry exactly one 64-hex token and a known type', () => {
	const link = (query: string) => passwordLinkToken(new URL(`https://ampoteket.no/admin/password${query}`));
	expect(link('')).toBeNull();
	expect(link('?next=%2Fadmin')).toBeNull();
	expect(link(`?token_hash=${'a'.repeat(64)}&type=invite`)).toEqual({ token: 'a'.repeat(64), type: 'invite' });
	expect(link(`?token_hash=${'b'.repeat(64)}&type=recovery`)).toEqual({ token: 'b'.repeat(64), type: 'recovery' });
	for (const bad of [`?token_hash=${'a'.repeat(63)}&type=invite`, `?token_hash=${'a'.repeat(64)}&type=signup`, `?token_hash=${'A'.repeat(64)}&type=invite`,
		`?token_hash=${'a'.repeat(64)}&token_hash=${'a'.repeat(64)}&type=invite`, '?code=abc', '?error=access_denied', `?token_hash=${'a'.repeat(64)}`]) {
		expect(link(bad)).toBe('invalid');
	}
});

describe('Convex Auth session', () => {
	const tokens = (n: number) => ({ token: `jwt-${n}`, refreshToken: `refresh-${n}` });
	function harness(storage = memoryStorage(), refreshResult: () => Promise<unknown> = async () => ({ tokens: tokens(2) })) {
		const calls: string[] = [];
		const http = { action: (async (fn: never, args: Record<string, unknown>) => {
			const name = getFunctionName(fn);
			calls.push(name);
			if (name === 'session:signIn') return args.password === 'right' ? tokens(1) : Promise.reject(rejection('INVALID_CREDENTIALS'));
			if (name === 'auth:signIn') return refreshResult();
			throw new Error(name);
		}) as never };
		const lock = locks();
		const session = new ConvexAuthSession(url, http, () => storage, () => lock, async () => {});
		const seen: (string | null)[] = [];
		session.subscribe((token) => seen.push(token));
		return { session, storage, calls, seen };
	}

	test('sign-in stores both tokens under the deployment namespace; sign-out forgets them', async () => {
		const { session, storage, seen } = harness();
		expect(mayHaveSession(url, storage)).toBe(false);
		await expect(session.signIn('staff@example.no', 'wrong')).rejects.toThrow();
		expect(storage.values).toEqual({});
		await session.signIn(' staff@example.no ', 'right');
		expect(storage.values).toEqual({ [keys.jwt]: 'jwt-1', [keys.refresh]: 'refresh-1' });
		expect(mayHaveSession(url, storage)).toBe(true);
		expect(await session.fetchAccessToken({ forceRefreshToken: false })).toBe('jwt-1');
		await session.signOut({ action: async () => { throw new Error('offline'); } });
		expect(storage.values).toEqual({});
		expect(seen).toEqual(['jwt-1', null]);
	});

	test('concurrent refreshes spend the refresh token once and share the result', async () => {
		const { session, calls } = harness(memoryStorage({ [keys.jwt]: 'jwt-1', [keys.refresh]: 'refresh-1' }));
		session.load();
		const results = await Promise.all([1, 2, 3].map(() => session.fetchAccessToken({ forceRefreshToken: true })));
		expect(results).toEqual(['jwt-2', 'jwt-2', 'jwt-2']);
		expect(calls.filter((name) => name === 'auth:signIn')).toHaveLength(1);
	});

	test("a token another tab stored is adopted without refreshing", async () => {
		const storage = memoryStorage({ [keys.jwt]: 'jwt-1', [keys.refresh]: 'refresh-1' });
		const { session, calls } = harness(storage);
		session.load();
		storage.values[keys.jwt] = 'jwt-from-other-tab';
		expect(session.isTokenEvent(keys.jwt)).toBe(true);
		expect(await session.fetchAccessToken({ forceRefreshToken: true })).toBe('jwt-from-other-tab');
		expect(calls).toEqual([]);
	});

	test('a rejected refresh signs out; a failed request keeps the session for a later retry', async () => {
		const rejected = harness(memoryStorage({ [keys.jwt]: 'jwt-1', [keys.refresh]: 'refresh-1' }), async () => ({ tokens: null }));
		rejected.session.load();
		expect(await rejected.session.fetchAccessToken({ forceRefreshToken: true })).toBeNull();
		expect(rejected.storage.values).toEqual({});
		expect(rejected.session.token).toBeNull();
		const failing = harness(memoryStorage({ [keys.jwt]: 'jwt-1', [keys.refresh]: 'refresh-1' }), async () => { throw new Error('Server Error'); });
		failing.session.load();
		await expect(failing.session.fetchAccessToken({ forceRefreshToken: true })).rejects.toThrow();
		expect(failing.storage.values).toEqual({ [keys.jwt]: 'jwt-1', [keys.refresh]: 'refresh-1' });
		expect(failing.session.token).toBe('jwt-1');
		expect(failing.calls.filter((name) => name === 'auth:signIn')).toHaveLength(1);
		const offline = harness(memoryStorage({ [keys.jwt]: 'jwt-1', [keys.refresh]: 'refresh-1' }), async () => { throw new TypeError('Failed to fetch'); });
		offline.session.load();
		await expect(offline.session.fetchAccessToken({ forceRefreshToken: true })).rejects.toThrow();
		expect(offline.storage.values[keys.refresh]).toBe('refresh-1');
		expect(offline.calls.filter((name) => name === 'auth:signIn')).toHaveLength(3);
	});

	test('a refresh the browser aborts on unload keeps the session and reports nothing', async () => {
		const aborted = harness(memoryStorage({ [keys.jwt]: 'jwt-1', [keys.refresh]: 'refresh-1' }),
			async () => { throw new DOMException('The operation was aborted. ', 'AbortError'); });
		aborted.session.load();
		expect(await aborted.session.fetchAccessToken({ forceRefreshToken: true })).toBe('jwt-1');
		expect(aborted.storage.values[keys.refresh]).toBe('refresh-1');
	});
});
