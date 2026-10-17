import { getContext, setContext } from 'svelte';
import type { ConvexClient } from 'convex/browser';
import { api, errorCode, type ConvexConfig, type StaffSession } from './convex';
import { mayHaveSession, type ConvexAuthClient } from './convex-auth.svelte';

export type AdminStatus = 'loading' | 'signedOut' | 'ready' | 'noAccess' | 'revoked' | 'unavailable';
export type AdminMembership = { id: string; authUserId: string; displayName: string };
type Me = { authUserId: string | null; email: string | null; membership: AdminMembership | null } | null;

/**
 * The signed-in staff member, kept live: a subscription to `members.me` reports
 * sign-in, sign-out and revocation as they happen, in every open tab. Only
 * `ready` grants credentials; the backend checks staff access on every call
 * independently, so cached membership is never authorization.
 */
export class AdminContext {
	productBreadcrumb = $state<{ routeId: string; code: string } | null>(null);
	#phase = $state<'idle' | 'signedOut' | 'started' | 'failed'>('idle');
	#me = $state<Me | undefined>(undefined);
	/** The last user this tab saw as active staff: losing membership then reads as revoked. */
	#admittedUser = $state<string | null>(null);
	#unsubscribe: (() => void) | null = null;
	#stopAuth: (() => void) | null = null;

	constructor(readonly config: ConvexConfig | null,
		readonly client: ConvexClient | null, readonly auth: ConvexAuthClient | null,
		/** Server-confirmed auth from convex-svelte's `useAuth()`. */
		private readonly serverAuth: { readonly isLoading: boolean; readonly isAuthenticated: boolean } | null) {}

	get status(): AdminStatus {
		if (!this.config || !this.client || !this.auth || this.#phase === 'failed') return 'unavailable';
		if (this.#phase === 'idle') return 'loading';
		if (this.#phase === 'signedOut' || !this.auth.isAuthenticated) return 'signedOut';
		// A token is stored but the backend has not confirmed it, or `me` has not caught up.
		if (this.serverAuth?.isLoading || !this.serverAuth?.isAuthenticated || !this.#me) return 'loading';
		if (this.#me.membership) return 'ready';
		return this.#admittedUser !== null && this.#admittedUser === this.#me.authUserId ? 'revoked' : 'noAccess';
	}
	get membership(): AdminMembership | null { return this.status === 'ready' ? this.#me!.membership : null; }
	/** The signed-in user's Auth UUID, also while their membership is missing. */
	get userId(): string | null { return this.auth?.isAuthenticated ? this.#me?.authUserId ?? null : null; }
	get email(): string | null { return this.auth?.isAuthenticated ? this.#me?.email ?? null : null; }
	// Cached membership keeps this identity's editor mounted while a read is pending.
	get retainsEditor() { return Boolean(this.#me?.membership && this.#me.membership.authUserId === this.userId); }

	/**
	 * Load the session once. Public pages skip it while no session is stored, so
	 * guests never subscribe; admin routes pass `required`. Idempotent.
	 */
	start(required = false) {
		if (!this.config || !this.client || !this.auth || this.#unsubscribe) return;
		if (!required && !mayHaveSession(this.config.url)) { this.#phase = 'signedOut'; return; }
		this.#stopAuth = this.auth.start();
		this.#phase = 'started';
		this.#unsubscribe = this.client.onUpdate(api.members.me, {}, (me) => {
			// A result after a failure ends it: on a retry the client may first replay the
			// cached failure, and the backend's answer follows on the same subscription.
			if (this.#phase === 'failed') this.#phase = 'started';
			this.#me = me;
			if (me?.membership) this.#admittedUser = me.authUserId;
		}, () => { this.#phase = 'failed'; });
	}

	/** Retry after a failed subscription, or start one a public page skipped. */
	async refresh() {
		if (this.#phase === 'failed') { this.#unsubscribe?.(); this.#unsubscribe = null; this.#stopAuth?.(); this.#phase = 'idle'; }
		this.start(true);
	}

	credentials(): StaffSession {
		const userId = this.userId;
		if (!this.client || this.status !== 'ready' || !userId) throw new Error('Staff session unavailable');
		return { client: this.client, userId };
	}

	/** STAFF_REQUIRED means access changed; the live membership already shows it. */
	async permissionFailure(error: unknown) {
		if (errorCode(error) === 'STAFF_REQUIRED') await this.refresh();
	}

	async signIn(email: string, password: string) {
		this.start(true);
		await this.auth!.signIn(email, password);
	}

	async signOut() {
		await this.auth?.signOut(this.client ?? undefined);
		this.#me = undefined;
	}
}
const key = Symbol('admin');
export function setAdminContext(value: AdminContext) { return setContext(key, value); }
export function getAdminContext(): AdminContext { return getContext(key); }

export { adminReturnPath } from './admin-auth';
