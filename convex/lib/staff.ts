/**
 * Staff identity. The actor always comes from the signed-in Convex Auth user,
 * never from an argument (datamodell.md §9).
 */
import { getAuthUserId } from '@convex-dev/auth/server';
import type { QueryCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import type { Actor } from './audit';
import { fail } from './errors';

export async function currentUser(ctx: QueryCtx): Promise<Doc<'users'> | null> {
	const userId = await getAuthUserId(ctx);
	return userId ? await ctx.db.get(userId) : null;
}

/** The caller's active membership, or null for guests, non-staff and revoked staff. */
export async function currentStaff(ctx: QueryCtx): Promise<Doc<'staff_members'> | null> {
	const user = await currentUser(ctx);
	if (!user?.auth_user_id) return null;
	const staff = await ctx.db.query('staff_members').withIndex('auth_user_id', (q) => q.eq('auth_user_id', user.auth_user_id!)).unique();
	return staff?.is_active ? staff : null;
}

export async function requireStaff(ctx: QueryCtx): Promise<{ staff: Doc<'staff_members'>; actor: Actor }> {
	const staff = await currentStaff(ctx);
	if (!staff) fail('STAFF_REQUIRED');
	return { staff, actor: { staffId: staff.id, role: 'authenticated' } };
}
