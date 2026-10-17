/**
 * The reactive face of ConvexAuthSession (src/lib/convex-auth.ts) for the root
 * layout: wire it into the Convex client with convex-svelte's
 * `setupAuth(() => auth.provider)`.
 */
import { ConvexHttpClient } from 'convex/browser';
import type { ConvexCaller } from './convex';
import { ConvexAuthSession } from './convex-auth';
export { mayHaveSession } from './convex-auth';

export class ConvexAuthClient {
	token = $state<string | null>(null);
	/** Guests never wait on auth: false from the start. */
	readonly isLoading = false;
	readonly #session: ConvexAuthSession;
	#started = false;

	constructor(readonly url: string) {
		this.#session = new ConvexAuthSession(url, new ConvexHttpClient(url, { logger: false }));
		this.#session.subscribe((token) => { this.token = token; });
	}

	/**
	 * Derived, so a token refresh that keeps the user signed in changes nothing here.
	 * The `provider` getter feeds convex-svelte's `setAuth` effect; if it tracked the
	 * token itself, each refresh would re-run `setAuth`, whose confirmation fetches
	 * a fresh token again: an endless refresh loop that re-runs every query.
	 */
	readonly isAuthenticated = $derived(this.token !== null);
	/** What convex-svelte's `setupAuth` reads. */
	get provider() {
		return { isLoading: this.isLoading, isAuthenticated: this.isAuthenticated, fetchAccessToken: this.#session.fetchAccessToken };
	}

	/** Read the stored session and follow other tabs. Idempotent; returns a cleanup. */
	start(): () => void {
		if (this.#started) return () => {};
		this.#started = true;
		this.#session.load();
		const listener = (event: StorageEvent) => { if (this.#session.isTokenEvent(event.key)) this.#session.load(); };
		window.addEventListener('storage', listener);
		return () => { window.removeEventListener('storage', listener); this.#started = false; };
	}

	signIn(email: string, password: string) { return this.#session.signIn(email, password); }
	signOut(client?: Pick<ConvexCaller, 'action'>) { return this.#session.signOut(client); }
}
