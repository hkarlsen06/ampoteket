import { describe, expect, test } from 'bun:test';
import { ApiError } from './api';
import { createClient, type Session } from '@supabase/supabase-js';
import { memory } from './test-storage';
import { createBrowserAdminAuth, readAdminMembership, signInFailure, updateAdminPassword } from './admin-auth';

const config = { url: 'https://example.invalid', publishableKey: 'sb_publishable_fixture' };
const userId = 'df5aa780-0f36-44d4-a05f-d61206cc8bc9';
const member = { id: '11111111-1111-4111-8111-111111111111', auth_user_id: userId, display_name: 'Volunteer', is_active: true };

describe('admin Auth boundary', () => {
	test('requires browser ownership, never a shared SSR Auth client', async () => {
		await expect(createBrowserAdminAuth(config)).rejects.toThrow('requires a browser');
	});

	test('uses the current user JWT and an explicit own-membership projection', async () => {
		const membership = await readAdminMembership(config, 'fixture-token', userId, {
			fetcher: async (input, init) => {
				const url = new URL(String(input));
				expect(url.pathname).toBe('/rest/v1/amp_staff_members');
				expect(url.searchParams.get('auth_user_id')).toBe(`eq.${userId}`);
				expect(url.searchParams.get('select')).toBe('id,auth_user_id,display_name,is_active');
				expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-token');
				expect(init?.cache).toBe('no-store');
				expect(init?.redirect).toBe('manual');
				return Response.json([member]);
			}
		});
		expect(membership).toEqual({ id: member.id, authUserId: userId, displayName: 'Volunteer' });
	});

	test('distinguishes absent/revoked membership from unavailable or unauthorized reads', async () => {
		for (const rows of [[], [{ ...member, is_active: false }]]) {
			expect(await readAdminMembership(config, 'token', userId, { fetcher: async () => Response.json(rows) })).toBeNull();
		}
		for (const status of [401, 403, 503]) {
			await expect(readAdminMembership(config, 'token', userId, {
				fetcher: async () => Response.json({ code: 'unavailable' }, { status })
			})).rejects.toBeInstanceOf(ApiError);
		}
	});

	test('rejects wrong identities, duplicate and malformed responses', async () => {
		for (const rows of [null, {}, [member, member], [{ ...member, auth_user_id: member.id }],
			[{ ...member, is_active: 'true' }], [{ ...member, id: null }], [{ ...member, display_name: '' }]]) {
			await expect(readAdminMembership(config, 'token', userId, {
				fetcher: async () => Response.json(rows)
			})).rejects.toThrow('Invalid membership response');
		}
	});

	test('password updates reject a changed identity and retain the checked token across a later account switch', async () => {
		const otherId = member.id, storageKey = 'password-identity-test', storage = memory();
		const session = (id: string): Session => ({ access_token: `token-${id}`, refresh_token: `refresh-${id}`,
			expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: 'bearer',
			user: { id, app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-10-02T00:00:00Z' } });
		const setUser = (id: string) => storage.setItem(storageKey, JSON.stringify(session(id)));
		setUser(userId);
		const client = createClient(config.url, config.publishableKey, { auth: {
			persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, storageKey, storage
		} });
		await client.auth.getSession();
		let switchAfterRead = false, calls = 0;
		const auth = { getSession: async () => {
			const result = await client.auth.getSession();
			if (switchAfterRead) setUser(otherId);
			return result;
		} };
		const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
			calls++;
			expect(new URL(String(input)).pathname).toBe('/auth/v1/user');
			expect(init?.method).toBe('PUT');
			expect(init?.redirect).toBe('manual');
			expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer token-${userId}`);
			expect(JSON.parse(String(init?.body))).toEqual({ password: 'new-password' });
			return Response.json(session(userId).user);
		};
		setUser(otherId);
		await expect(updateAdminPassword(config, auth, userId, 'new-password', fetcher)).rejects.toThrow('identity');
		expect(calls).toBe(0);
		setUser(userId); switchAfterRead = true;
		await updateAdminPassword(config, auth, userId, 'new-password', fetcher);
		expect(calls).toBe(1);
		expect((await client.auth.getSession()).data.session?.user.id).toBe(otherId);
	});
});

test('sign-in failures separate a refused login from an unreachable service', () => {
	expect(signInFailure({ status: 400, code: 'invalid_credentials' })).toBe('invalid');
	expect(signInFailure({ status: 429, code: 'over_request_rate_limit' })).toBe('rateLimited');
	expect(signInFailure({ status: 0, name: 'AuthRetryableFetchError' })).toBe('unavailable');
	expect(signInFailure({ status: 503 })).toBe('unavailable');
	expect(signInFailure(new TypeError('Failed to fetch'))).toBe('unavailable');
	expect(signInFailure(null)).toBe('unavailable');
});
