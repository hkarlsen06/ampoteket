import { requestApiJson, type Fetcher } from './api';

/** Public configuration only; the service credential never enters the browser. */
export type AdminAuthConfig = { url: string; publishableKey: string };
export type AdminMembership = { id: string; authUserId: string; displayName: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function baseUrl(config: AdminAuthConfig): URL {
	const url = new URL(config.url);
	if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
		|| url.pathname !== '/' || url.search || url.hash || !config.publishableKey.trim()
		|| config.publishableKey.startsWith('sb_secret_')) {
		throw new TypeError('Invalid public Auth configuration');
	}
	return url;
}

/**
 * Create once per browser layout, never in SSR or a module-level singleton.
 * Expose Auth only: application data must use the lossless API boundary.
 * Recovery callbacks will explicitly exchange their allowlisted code; merely
 * visiting a URL must not consume credentials from an arbitrary fragment.
 */
export async function createBrowserAdminAuth(config: AdminAuthConfig) {
	if (typeof window === 'undefined') throw new Error('Admin Auth requires a browser');
	baseUrl(config);
	// supabase-js is most of a public page's script, so only staff download it.
	const { createClient } = await import('@supabase/supabase-js');
	return createClient(config.url, config.publishableKey, {
		auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, flowType: 'pkce', storageKey: adminStorageKey(config) }
	}).auth;
}

/** supabase-js's own default key, named here so guests can be told apart without loading it. */
function adminStorageKey(config: AdminAuthConfig) {
	return `sb-${baseUrl(config).hostname.split('.')[0]}-auth-token`;
}

/** True when this browser may hold a staff session (or storage cannot be read). */
export function mayHaveAdminSession(config: AdminAuthConfig) {
	try { return localStorage.getItem(adminStorageKey(config)) !== null; } catch { return true; }
}

/**
 * Read only the signed-in user's membership. Null means a successful read with
 * no active membership; transport/auth failures remain errors. Recheck after
 * sign-in/refresh and permission failures. RLS protects every staff operation
 * independently; cached membership is never authorization.
 */
export async function readAdminMembership(
	config: AdminAuthConfig,
	accessToken: string,
	authUserId: string,
	options: { fetcher?: Fetcher; signal?: AbortSignal } = {}
): Promise<AdminMembership | null> {
	if (!uuid.test(authUserId) || !accessToken.trim()) throw new TypeError('Invalid Auth session');
	const url = baseUrl(config);
	url.pathname = '/rest/v1/amp_staff_members';
	url.search = new URLSearchParams({
		select: 'id,auth_user_id,display_name,is_active',
		auth_user_id: `eq.${authUserId}`,
		limit: '2'
	}).toString();
	const rows = await requestApiJson(url, {
		headers: { apikey: config.publishableKey, Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
		credentials: 'omit', cache: 'no-store', signal: options.signal
	}, options.fetcher);
	const invalid = () => { throw new Error('Invalid membership response'); };
	if (!Array.isArray(rows) || rows.length > 1) return invalid();
	if (!rows.length) return null;
	const row = rows[0];
	if (!row || typeof row !== 'object' || Array.isArray(row)
		|| typeof row.id !== 'string' || !uuid.test(row.id) || row.auth_user_id !== authUserId
		|| typeof row.display_name !== 'string' || !row.display_name.trim()
		|| [...row.display_name.trim()].length > 120 || typeof row.is_active !== 'boolean') return invalid();
	return row.is_active ? { id: row.id, authUserId, displayName: row.display_name } : null;
}

/** A return path never carries credentials, another origin or an unbuilt screen. */
export function adminReturnPath(value: string | null): string {
	return value && /^\/admin(?:\/(?:privacy|help|admins|shelf|stock|audit|products(?:\/(?:new|labels|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?|(?:counts|orders)(?:\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?))?$/.test(value) ? value : '/admin';
}
