/**
 * Convex Auth for Svelte: the token side of @convex-dev/auth's React client,
 * ported. The access token (a JWT, one hour) and the refresh token live in
 * localStorage under Convex Auth's own keys, namespaced by deployment URL.
 * Refreshes run under a cross-tab lock, so two tabs never spend the same refresh
 * token, and a tab adopts a token another tab just stored.
 *
 * Wire it into the Convex client with convex-svelte's `setupAuth(() => auth.provider)`.
 */
import { ConvexHttpClient } from 'convex/browser';
import { api } from '#convex/_generated/api.js';

type Tokens = { token: string; refreshToken: string };
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;
const RETRY_BACKOFF = [500, 2000];

/** Convex Auth's storage keys for this deployment. */
export function authStorageKeys(url: string) {
	const namespace = url.replace(/[^a-zA-Z0-9]/g, '');
	return { jwt: `__convexAuthJWT_${namespace}`, refresh: `__convexAuthRefreshToken_${namespace}` };
}

/** True when this browser may hold a staff session (or storage cannot be read). */
export function mayHaveSession(url: string, storage: Storage = localStorage): boolean {
	try { return storage.getItem(authStorageKeys(url).refresh) !== null; } catch { return true; }
}

const isNetworkError = (error: unknown) => error instanceof TypeError || (error instanceof Error && /network|fetch|Failed to connect/i.test(error.message));

export class ConvexAuthClient {
	token = $state<string | null>(null);
	/** False until `start` for guests too, so public pages never wait on auth. */
	isLoading = $state(false);
	readonly #keys: ReturnType<typeof authStorageKeys>;
	#started = false;

	constructor(readonly url: string, private readonly storageOverride?: Storage,
		private readonly http: Pick<ConvexHttpClient, 'action'> = new ConvexHttpClient(url, { logger: false })) {
		this.#keys = authStorageKeys(url);
	}
	/** Browser storage, read lazily so the class can be constructed during SSR. */
	private get storage(): Storage { return this.storageOverride ?? localStorage; }

	get isAuthenticated() { return this.token !== null; }

	/** What convex-svelte's `setupAuth` reads. */
	get provider() {
		return { isLoading: this.isLoading, isAuthenticated: this.isAuthenticated, fetchAccessToken: this.fetchAccessToken };
	}

	/** Read the stored session and follow other tabs. Idempotent; returns a cleanup. */
	start(): () => void {
		if (this.#started) return () => {};
		this.#started = true;
		this.token = this.storage.getItem(this.#keys.jwt);
		const listener = (event: StorageEvent) => {
			if (event.key === this.#keys.jwt) this.token = event.newValue;
		};
		window.addEventListener('storage', listener);
		return () => { window.removeEventListener('storage', listener); this.#started = false; };
	}

	#store(tokens: Tokens | null) {
		if (tokens) {
			this.storage.setItem(this.#keys.jwt, tokens.token);
			this.storage.setItem(this.#keys.refresh, tokens.refreshToken);
		} else {
			this.storage.removeItem(this.#keys.jwt);
			this.storage.removeItem(this.#keys.refresh);
		}
		this.token = tokens?.token ?? null;
		this.isLoading = false;
	}

	/** Throws a ConvexError with code INVALID_CREDENTIALS for a refused sign-in. */
	async signIn(email: string, password: string): Promise<void> {
		this.#store(await this.http.action(api.session.signIn, { email: email.trim(), password }));
	}

	/** Ends the server session when reachable; always forgets the local tokens. */
	async signOut(client?: { action: ConvexHttpClient['action'] }): Promise<void> {
		try { await client?.action(api.auth.signOut, {}); } catch { /* Already signed out is fine. */ }
		this.#store(null);
	}

	/** Called by the Convex client; `forceRefreshToken` means the current JWT expired or was rejected. */
	fetchAccessToken = async ({ forceRefreshToken }: { forceRefreshToken: boolean }): Promise<string | null> => {
		if (!forceRefreshToken) return this.token;
		const before = this.token;
		return await this.#exclusive(async () => {
			// Another tab refreshed while this one waited: use its token.
			const stored = this.storage.getItem(this.#keys.jwt);
			if (stored !== before) { this.token = stored; return stored; }
			const refreshToken = this.storage.getItem(this.#keys.refresh);
			if (refreshToken === null) { this.#store(null); return null; }
			for (let attempt = 0; ; attempt++) {
				try {
					const result = await this.http.action(api.auth.signIn, { refreshToken });
					this.#store(result.tokens ?? null);
					return this.token;
				} catch (error) {
					if (!isNetworkError(error) || attempt >= RETRY_BACKOFF.length) {
						// A rejected refresh token means the session ended (signed out elsewhere or expired).
						if (!isNetworkError(error)) this.#store(null);
						throw error;
					}
					await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF[attempt] + Math.random() * 100));
				}
			}
		});
	};

	async #exclusive<T>(callback: () => Promise<T>): Promise<T> {
		const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
		return locks ? await locks.request(this.#keys.refresh, callback) : await callback();
	}
}
