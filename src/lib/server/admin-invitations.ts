import { ApiError, identifier, isRecord, object, requestApiJson, uuidPattern, type Fetcher } from '../api';
import { readAdminMembership } from '../admin-auth';
import { staffRequest } from '../admin-api';
import type { CheckoutRateLimit } from './checkout-gateway';
import { readJsonBody, RequestBodyError } from './request-body';

export type AdminInvitationConfig = {
	origin: string; apiUrl: string; publishableKey: string; secretKey: string; invitationLimit: CheckoutRateLimit;
};
class InvitationError extends Error {
	constructor(readonly code: string, readonly status: number) { super(code); }
}
function fail(code: string, status: number): never { throw new InvitationError(code, status); }
function response(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: {
		'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'CDN-Cache-Control': 'no-store',
		'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', ...(status === 429 ? { 'Retry-After': '60' } : {})
	} });
}
function validConfig(config: AdminInvitationConfig | null): asserts config is AdminInvitationConfig {
	if (!config) fail('UNAVAILABLE', 503);
	try {
		const origin = new URL(config.origin); const api = new URL(config.apiUrl);
		if (origin.protocol !== 'https:' || origin.origin !== config.origin || api.origin !== config.apiUrl
			|| (api.protocol !== 'https:' && !(api.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(api.hostname)))
			|| !config.publishableKey || !config.secretKey || !config.invitationLimit?.limit) fail('UNAVAILABLE', 503);
		if (!config.secretKey.startsWith('sb_secret_')) {
			const payload = JSON.parse(atob(config.secretKey.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
			if (payload.role !== 'service_role') fail('UNAVAILABLE', 503);
		}
	} catch { fail('UNAVAILABLE', 503); }
}
function accountExists(error: unknown) {
	return error instanceof ApiError && [400, 422].includes(error.status) && isRecord(error.body)
		&& ['email_exists', 'user_already_exists'].includes(String(error.body.error_code ?? error.body.code));
}

/** Auth provisioning uses the secret; membership writes always use the caller's JWT. */
export async function adminInvitation(request: Request, clientAddress: string,
	config: AdminInvitationConfig | null, fetcher: Fetcher = fetch): Promise<Response> {
	try {
		validConfig(config);
		if (request.method !== 'POST') fail('INVALID_ADMIN_INVITATION', 405);
		if (request.headers.get('Origin') !== config.origin
			|| (request.headers.has('Sec-Fetch-Site') && request.headers.get('Sec-Fetch-Site') !== 'same-origin')) fail('ORIGIN_REJECTED', 403);
		if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') fail('INVALID_ADMIN_INVITATION', 415);
		const token = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9._-]+)$/)?.[1];
		if (!token || token.length > 8192) fail('STAFF_REQUIRED', 401);
		if (!(await config.invitationLimit.limit({ key: `ip:${clientAddress}` })).success) fail('RATE_LIMITED', 429);
		const body = await readJsonBody(request, 2048);
		if (!isRecord(body) || Object.keys(body).sort().join(',') !== 'displayName,email,locale,requestId,targetActive,targetId'
			|| typeof body.requestId !== 'string' || !uuidPattern.test(body.requestId)
			|| (body.targetId !== null && (typeof body.targetId !== 'string' || !uuidPattern.test(body.targetId)))
			|| (body.targetId === null ? body.targetActive !== null : typeof body.targetActive !== 'boolean')
			|| typeof body.email !== 'string' || body.email.trim().length > 254
			|| !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()) || /\p{Cc}/u.test(body.email)
			|| typeof body.displayName !== 'string' || !body.displayName.trim() || [...body.displayName.trim()].length > 120
			|| /\p{Cc}/u.test(body.displayName) || !['nb', 'en'].includes(String(body.locale))) fail('INVALID_ADMIN_INVITATION', 400);
		const email = body.email.trim().toLowerCase(); const displayName = body.displayName.trim();
		const deadline = AbortSignal.timeout(45000);
		const boundedFetch: Fetcher = (input, init) => fetcher(input, { ...init,
			signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline });
		const publicConfig = { url: config.apiUrl, publishableKey: config.publishableKey };
		const user = object(await requestApiJson(`${config.apiUrl}/auth/v1/user`, {
			headers: { apikey: config.publishableKey, Authorization: `Bearer ${token}` }, credentials: 'omit', cache: 'no-store'
		}, boundedFetch));
		const userId = identifier(user.id);
		if (!await readAdminMembership(publicConfig, token, userId, { fetcher: boundedFetch })) fail('STAFF_REQUIRED', 403);
		if (!(await config.invitationLimit.limit({ key: `user:${userId}` })).success) fail('RATE_LIMITED', 429);
		const session = { config: publicConfig, token, userId };
		const authHeaders = { apikey: config.secretKey, 'Content-Type': 'application/json',
			...(config.secretKey.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${config.secretKey}` }) };
		// Create without a password or email confirmation, then grant before sending the link.
		// A failed email leaves a visible pending membership that can be retried.
		if (body.targetId === null) {
			try {
				await requestApiJson(`${config.apiUrl}/auth/v1/admin/users`, { method: 'POST', headers: authHeaders,
					body: JSON.stringify({ email, email_confirm: false }), credentials: 'omit', cache: 'no-store' }, boundedFetch);
			} catch (error) { if (!accountExists(error)) throw error; }
		}
		const staffId = identifier(await staffRequest(session, 'rpc/amp_grant_staff_access', {}, {
			p_request_id: body.requestId, p_email: email, p_display_name: displayName, p_expected_staff_id: body.targetId, p_expected_active: body.targetActive
		}, 'POST', boundedFetch));
		const members = await staffRequest(session, 'rpc/amp_list_staff', {}, {}, 'POST', boundedFetch);
		if (!Array.isArray(members)) fail('UNAVAILABLE', 503);
		const member = members.find(row => isRecord(row) && row.id === staffId);
		// Replaying a completed grant must not revive an account deactivated afterward.
		if (!isRecord(member) || !member.is_active || !member.auth_user_id) fail('INVITATION_SUPERSEDED', 409);
		const authId = identifier(member.auth_user_id);
		if (typeof member.email !== 'string' || member.email.toLowerCase() !== email || typeof member.email_confirmed !== 'boolean') fail('INVITATION_SUPERSEDED', 409);
		if (member.email_confirmed) return response({ status: 'existing_account', staffId });
		const redirectTo = `${config.origin}${body.locale === 'en' ? '/en' : ''}/admin/password?next=%2Fadmin`;
		try {
			const invited = object(await requestApiJson(`${config.apiUrl}/auth/v1/invite?redirect_to=${encodeURIComponent(redirectTo)}`, {
				method: 'POST', headers: authHeaders, body: JSON.stringify({ email }), credentials: 'omit', cache: 'no-store'
			}, boundedFetch));
			if (identifier(invited.id) !== authId) fail('INVITATION_SUPERSEDED', 409);
		} catch (error) {
			if (error instanceof InvitationError) throw error;
			if (accountExists(error)) return response({ status: 'existing_account', staffId });
			fail('INVITATION_EMAIL_FAILED', 502);
		}
		return response({ status: 'invited', staffId });
	} catch (error) {
		if (error instanceof InvitationError) return response({ error: error.code }, error.status);
		if (error instanceof RequestBodyError) return response({ error: 'INVALID_ADMIN_INVITATION' }, error.status);
		if (error instanceof ApiError) {
			if (error.status === 401 || error.status === 403) return response({ error: 'STAFF_REQUIRED' }, error.status);
			const code = isRecord(error.body) && typeof error.body.message === 'string' ? error.body.message.split(':')[0] : '';
			if (code === 'STAFF_REQUIRED') return response({ error: code }, 403);
			if (['STAFF_EMAIL_REQUIRED', 'STAFF_DISPLAY_NAME_REQUIRED', 'STAFF_USER_NOT_FOUND', 'INVITATION_SUPERSEDED', 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT'].includes(code)) {
				return response({ error: code }, 409);
			}
		}
		return response({ error: 'UNAVAILABLE' }, 503);
	}
}
