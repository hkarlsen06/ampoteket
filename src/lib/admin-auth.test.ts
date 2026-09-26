import { describe, expect, test } from 'bun:test';
import { ApiError } from './api';
import { createBrowserAdminAuth, readAdminMembership } from './admin-auth';

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
});
