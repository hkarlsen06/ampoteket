import { getContext, setContext } from 'svelte';
import type { Session } from '@supabase/supabase-js';
import { ApiError } from './api';
import { createBrowserAdminAuth, mayHaveAdminSession, readAdminMembership, type AdminAuthConfig, type AdminMembership } from './admin-auth';
import type { StaffSession } from './admin-api';

export type AdminStatus = 'loading' | 'signedOut' | 'ready' | 'noAccess' | 'revoked' | 'unavailable';
export class AdminContext {
	productBreadcrumb = $state<{ routeId: string; code: string } | null>(null);
	status = $state<AdminStatus>('loading');
	membership = $state<AdminMembership | null>(null);
	session = $state<Session | null>(null);
	auth = $state<Awaited<ReturnType<typeof createBrowserAdminAuth>> | null>(null);
	private generation = 0;
	private starting = false;
	private admittedUser: string | null = null;
	// Cached membership keeps this identity's editor mounted; only `ready`
	// grants credentials. A failed read is not an authoritative revocation.
	get retainsEditor() { return Boolean(this.membership && this.membership.authUserId === this.session?.user.id); }
	constructor(readonly config: AdminAuthConfig | null, readonly callbackOrigin: string | null) {}
	/**
	 * Load Auth once. Public pages skip it while no session is stored, so guests
	 * never download the Auth client; admin routes pass `required`. Idempotent.
	 */
	async start(required = false) {
		if (!this.config) { this.status = 'unavailable'; return; }
		if (this.auth || this.starting) return;
		if (!required && !mayHaveAdminSession(this.config)) { this.status = 'signedOut'; return; }
		this.starting = true;
		try { this.auth = await createBrowserAdminAuth(this.config); }
		catch { this.status = 'unavailable'; return; }
		finally { this.starting = false; }
		this.auth.onAuthStateChange((_event, session) => {
			if (session?.user.id !== this.session?.user.id) { this.membership = null; this.status = 'loading'; }
			// Do not await an Auth method while the Auth event holds its lock.
			queueMicrotask(() => { void this.refresh(); });
		});
		void this.refresh();
	}
	async refresh() {
		// Without a client yet, look again for a session (e.g. signed in from another tab).
		if (!this.auth) return this.start();
		const generation = ++this.generation;
		if (!this.config) { this.status = 'unavailable'; return; }
		try {
			const { data, error } = await this.auth.getSession();
			if (generation !== this.generation) return;
			if (error) throw error;
			if (data.session?.user.id !== this.session?.user.id) this.membership = null;
			this.session = data.session;
			if (!data.session) { this.membership = null; this.status = 'signedOut'; return; }
			const membership = await readAdminMembership(this.config, data.session.access_token, data.session.user.id);
			if (generation !== this.generation) return;
			this.membership = membership;
			if (membership) { this.admittedUser = data.session.user.id; this.status = 'ready'; }
			else this.status = this.admittedUser === data.session.user.id ? 'revoked' : 'noAccess';
		} catch {
			if (generation === this.generation) this.status = 'unavailable';
		}
	}
	credentials(): StaffSession {
		if (!this.config || !this.session || this.status !== 'ready') throw new Error('Staff session unavailable');
		return { config: this.config, token: this.session.access_token, userId: this.session.user.id };
	}
	async permissionFailure(error: unknown) {
		if (error instanceof ApiError && (error.status === 401 || error.status === 403
			|| (error.body && typeof error.body === 'object' && 'code' in error.body && error.body.code === '42501'))) {
			this.status = 'loading'; await this.refresh();
		}
	}
	async signOut() {
		this.generation++; this.membership = null; this.status = 'loading';
		const result = await this.auth?.signOut({ scope: 'local' });
		if (result?.error) this.status = 'unavailable';
		else { this.session = null; this.status = 'signedOut'; }
	}
}
const key = Symbol('admin');
export function setAdminContext(value: AdminContext) { return setContext(key, value); }
export function getAdminContext(): AdminContext { return getContext(key); }

export { adminReturnPath } from './admin-auth';
