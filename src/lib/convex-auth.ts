/**
 * Convex Auth's browser protocol, ported from @convex-dev/auth's React client.
 * The access token (a JWT, one hour) and the refresh token live in localStorage
 * under Convex Auth's own keys, namespaced by deployment URL. Refreshes run
 * under a cross-tab lock, so two tabs never spend the same refresh token, and a
 * tab adopts a token another tab just stored. Plain TypeScript so it can be
 * tested; src/lib/convex-auth.svelte.ts makes it reactive.
 */
import { api } from '#convex/_generated/api.js';
import type { ConvexCaller } from './convex';

type Tokens = { token: string; refreshToken: string };
export type AuthStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Locks = { request<T>(name: string, callback: () => Promise<T>): Promise<T> };
const RETRY_BACKOFF = [500, 2000];

/** Convex Auth's storage keys for this deployment. */
export function authStorageKeys(url: string) {
	const namespace = url.replace(/[^a-zA-Z0-9]/g, '');
	return { jwt: `__convexAuthJWT_${namespace}`, refresh: `__convexAuthRefreshToken_${namespace}` };
}

/** True when this browser may hold a staff session (or storage cannot be read). */
export function mayHaveSession(url: string, storage: AuthStorage = localStorage): boolean {
	try { return storage.getItem(authStorageKeys(url).refresh) !== null; } catch { return true; }
}

const isNetworkError = (error: unknown) => error instanceof TypeError || (error instanceof Error && /network|fetch|Failed to connect/i.test(error.message));

export class ConvexAuthSession {
	#token: string | null = null;
	readonly #keys: ReturnType<typeof authStorageKeys>;
	readonly #listeners = new Set<(token: string | null) => void>();

	/** `http` is an unauthenticated client (ConvexHttpClient) for sign-in and refresh. */
	constructor(url: string, private readonly http: Pick<ConvexCaller, 'action'>,
		private readonly storage: () => AuthStorage = () => localStorage,
		private readonly locks: () => Locks | undefined = () => typeof navigator === 'undefined' ? undefined : navigator.locks,
		private readonly sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))) {
		this.#keys = authStorageKeys(url);
	}

	get token() { return this.#token; }
	/** Called with the new access token (or null) whenever it changes. */
	subscribe(listener: (token: string | null) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	#set(token: string | null) {
		if (token === this.#token) return;
		this.#token = token;
		for (const listener of this.#listeners) listener(token);
	}

	/** Adopt the stored token, e.g. on start or after another tab changed it. */
	load() { this.#set(this.storage().getItem(this.#keys.jwt)); }
	/** Is this storage event another tab's sign-in, refresh or sign-out? */
	isTokenEvent(key: string | null) { return key === this.#keys.jwt; }

	#store(tokens: Tokens | null) {
		const storage = this.storage();
		if (tokens) {
			storage.setItem(this.#keys.jwt, tokens.token);
			storage.setItem(this.#keys.refresh, tokens.refreshToken);
		} else {
			storage.removeItem(this.#keys.jwt);
			storage.removeItem(this.#keys.refresh);
		}
		this.#set(tokens?.token ?? null);
	}

	/** Throws a ConvexError with code INVALID_CREDENTIALS for a refused sign-in. */
	async signIn(email: string, password: string): Promise<void> {
		this.#store(await this.http.action(api.session.signIn, { email: email.trim(), password }));
	}

	/** Ends the server session when reachable (with the signed-in client); always forgets the local tokens. */
	async signOut(client?: Pick<ConvexCaller, 'action'>): Promise<void> {
		try { await client?.action(api.auth.signOut, {}); } catch { /* Already signed out is fine. */ }
		this.#store(null);
	}

	/** Called by the Convex client; `forceRefreshToken` means the current JWT expired or was rejected. */
	fetchAccessToken = async ({ forceRefreshToken }: { forceRefreshToken: boolean }): Promise<string | null> => {
		if (!forceRefreshToken) return this.#token;
		const before = this.#token;
		const refresh = async () => {
			// Another tab refreshed while this one waited: use its token.
			const stored = this.storage().getItem(this.#keys.jwt);
			if (stored !== before) { this.#set(stored); return stored; }
			const refreshToken = this.storage().getItem(this.#keys.refresh);
			if (refreshToken === null) { this.#store(null); return null; }
			for (let attempt = 0; ; attempt++) {
				try {
					// Convex Auth answers an ended session (signed out elsewhere or expired) with `tokens: null`.
					const result = await this.http.action(api.auth.signIn, { refreshToken });
					this.#store(result.tokens ?? null);
					return this.#token;
				} catch (error) {
					// The page is unloading and the browser cancelled the request: nothing to report, nothing to end.
					if (error instanceof Error && error.name === 'AbortError') return this.#token;
					// A thrown error is a failed request (server error, or cut off by navigation), not an ended session: keep it.
					if (!isNetworkError(error) || attempt >= RETRY_BACKOFF.length) throw error;
					await this.sleep(RETRY_BACKOFF[attempt] + Math.random() * 100);
				}
			}
		};
		const locks = this.locks();
		return locks ? await locks.request(this.#keys.refresh, refresh) : await refresh();
	};
}
