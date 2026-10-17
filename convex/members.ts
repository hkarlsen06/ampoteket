/**
 * Staff membership (datamodell.md §9 "Staff provisioning", api-contract.md
 * "Staff membership and invitations"). One operational role: every active
 * member may invite, reactivate or deactivate another. Nobody can deactivate
 * themselves, so mutual revocation cannot remove every account.
 *
 * Mutations are serializable: an access change re-reads the actor's own
 * membership in its transaction, so a member deactivated meanwhile cannot finish one.
 */
import { v } from 'convex/values';
import { getAuthUserId } from '@convex-dev/auth/server';
import { action, internalMutation, mutation, query } from './_generated/server';
import { internal } from './_generated/api';
import { insertAudited, patchAudited, SYSTEM } from './lib/audit';
import { beginCommand } from './lib/commands';
import { passwordLink, sendPasswordEmail } from './lib/email';
import { fail } from './lib/errors';
import { byUuid, newUuid } from './lib/ids';
import { rateLimit } from './lib/rateLimit';
import { currentUser, requireStaff } from './lib/staff';
import { isoNow } from './lib/time';
import { newToken } from './passwords';

const nullableString = v.union(v.string(), v.null());
const DAY = 86_400_000;
// eslint-disable-next-line no-control-regex -- control characters are exactly what this rejects.
const control = /[\u0000-\u001f\u007f]/;

/** The signed-in user and their membership; null when signed out. */
export const me = query({
	args: {},
	handler: async (ctx) => {
		const user = await currentUser(ctx);
		if (!user) return null;
		const staff = user.auth_user_id
			? await ctx.db.query('staff_members').withIndex('auth_user_id', (q) => q.eq('auth_user_id', user.auth_user_id!)).unique() : null;
		return { authUserId: user.auth_user_id ?? null, email: user.email ?? null,
			membership: staff?.is_active ? { id: staff.id, authUserId: staff.auth_user_id!, displayName: staff.display_name } : null };
	}
});

/** Every membership with its account email and whether the invitation was accepted. */
export const list = query({
	args: {},
	handler: async (ctx) => {
		await requireStaff(ctx);
		const rows = [];
		for (const staff of await ctx.db.query('staff_members').collect()) {
			const user = staff.auth_user_id ? await ctx.db.query('users').withIndex('auth_user_id', (q) => q.eq('auth_user_id', staff.auth_user_id!)).unique() : null;
			rows.push({ id: staff.id, authUserId: user ? staff.auth_user_id : null, displayName: staff.display_name, email: user?.email ?? null,
				isActive: staff.is_active, emailConfirmed: user?.emailVerificationTime !== undefined });
		}
		return rows.sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()) || a.id.localeCompare(b.id));
	}
});

/**
 * Create the account if needed and grant or reactivate membership (amp_grant_staff_access).
 * A resend binds `expectedStaffId`/`expectedActive` to the row the inviter saw;
 * a changed identity or access state raises INVITATION_SUPERSEDED before any write.
 */
export const grantAccess = internalMutation({
	args: { actorUserId: v.id('users'), requestId: v.string(), email: v.string(), displayName: v.string(),
		expectedStaffId: nullableString, expectedActive: v.union(v.boolean(), v.null()) },
	handler: async (ctx, args) => {
		const actorUser = await ctx.db.get(args.actorUserId);
		const actorStaff = actorUser?.auth_user_id ? await ctx.db.query('staff_members').withIndex('auth_user_id', (q) => q.eq('auth_user_id', actorUser.auth_user_id!)).unique() : null;
		if (!actorStaff?.is_active) fail('STAFF_REQUIRED');
		const actor = { staffId: actorStaff.id, role: 'authenticated' as const };
		await rateLimit(ctx, `invite:${actorStaff.id}`, 10);
		const email = args.email.trim().toLowerCase(), name = args.displayName.trim();
		if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || control.test(email)) fail('STAFF_EMAIL_REQUIRED');
		if (!name || [...name].length > 120 || control.test(name)) fail('STAFF_DISPLAY_NAME_REQUIRED');
		if ((args.expectedStaffId === null) !== (args.expectedActive === null)) fail('INVALID_ADMIN_INVITATION');
		const command = await beginCommand<{ staff_id: string }>(ctx, args.requestId, 'grant_staff_access', actor.staffId,
			{ email, display_name: name, expected_staff_id: args.expectedStaffId, expected_active: args.expectedActive });
		let staffId: string;
		if (command.done) staffId = command.result.staff_id;
		else {
			let user = await ctx.db.query('users').withIndex('email', (q) => q.eq('email', email)).unique();
			if (!user) {
				if (args.expectedStaffId !== null) fail('STAFF_USER_NOT_FOUND');
				// Created without a password: the invitation link sets it.
				const userId = await ctx.db.insert('users', { email, auth_user_id: newUuid() });
				await ctx.db.insert('authAccounts', { userId, provider: 'password', providerAccountId: email });
				user = (await ctx.db.get(userId))!;
			}
			if (!user.auth_user_id) await ctx.db.patch(user._id, { auth_user_id: newUuid() });
			const authUserId = (await ctx.db.get(user._id))!.auth_user_id!;
			const staff = await ctx.db.query('staff_members').withIndex('auth_user_id', (q) => q.eq('auth_user_id', authUserId)).unique();
			if (args.expectedStaffId !== null && (staff?.id !== args.expectedStaffId || staff.is_active !== args.expectedActive)) fail('INVITATION_SUPERSEDED');
			if (!staff) staffId = (await insertAudited(ctx, actor, 'staff_members', { id: newUuid(), auth_user_id: authUserId, display_name: name, is_active: true, created_at: isoNow() })).id;
			else {
				if (!staff.is_active) await patchAudited(ctx, actor, 'staff_members', staff, { display_name: name, is_active: true });
				staffId = staff.id;
			}
			await command.finish({ staff_id: staffId });
		}
		// Replaying a completed grant must not revive an account deactivated afterwards.
		const member = (await byUuid(ctx, 'staff_members', staffId))!;
		const user = member.auth_user_id ? await ctx.db.query('users').withIndex('auth_user_id', (q) => q.eq('auth_user_id', member.auth_user_id!)).unique() : null;
		if (!member.is_active || !user || user.email !== email) fail('INVITATION_SUPERSEDED');
		return { staffId, userId: user._id, emailConfirmed: user.emailVerificationTime !== undefined };
	}
});

/**
 * Invite (or resend to, or reactivate) a member. Membership is saved before the
 * email: INVITATION_EMAIL_FAILED means access exists and the same request can be
 * retried to send again. A confirmed account keeps its password: `existing_account`.
 */
export const invite = action({
	args: { requestId: v.string(), email: v.string(), displayName: v.string(), locale: v.union(v.literal('nb'), v.literal('en')),
		targetId: nullableString, targetActive: v.union(v.boolean(), v.null()) },
	handler: async (ctx, args): Promise<{ status: 'invited' | 'existing_account'; staffId: string }> => {
		const actorUserId = await getAuthUserId(ctx);
		if (!actorUserId) fail('STAFF_REQUIRED');
		const grant = await ctx.runMutation(internal.members.grantAccess, { actorUserId, requestId: args.requestId, email: args.email,
			displayName: args.displayName, expectedStaffId: args.targetId, expectedActive: args.targetActive });
		if (grant.emailConfirmed) return { status: 'existing_account', staffId: grant.staffId };
		const { token, digest } = await newToken();
		await ctx.runMutation(internal.passwords.storeToken, { userId: grant.userId, digest, purpose: 'invite', ttlMs: 7 * DAY });
		if (!await sendPasswordEmail('invite', args.email.trim().toLowerCase(), passwordLink(args.locale, token, 'invite'))) fail('INVITATION_EMAIL_FAILED');
		return { status: 'invited', staffId: grant.staffId };
	}
});

export const deactivate = mutation({
	args: { requestId: v.string(), staffId: v.string() },
	handler: async (ctx, args) => {
		const { actor } = await requireStaff(ctx);
		const command = await beginCommand<{ staff_id: string }>(ctx, args.requestId, 'deactivate_staff', actor.staffId, { staff_id: args.staffId });
		if (command.done) return command.result.staff_id;
		if (args.staffId === actor.staffId) fail('STAFF_SELF_DEACTIVATION');
		const staff = (await byUuid(ctx, 'staff_members', args.staffId)) ?? fail('STAFF_NOT_FOUND');
		if (staff.is_active) await patchAudited(ctx, actor, 'staff_members', staff, { is_active: false });
		return (await command.finish({ staff_id: staff.id })).staff_id;
	}
});

/**
 * Maintainer recovery (datamodell.md §9), for the first member or when no active
 * member remains: `bunx convex run members:grantStaffAccess '{"email":…,"displayName":…}'`
 * with the deployment's admin key. Creates the account if needed (the person then
 * sets a password with "Forgot password"), grants or reactivates membership, and is
 * audited as a system action. An already active member raises STAFF_ALREADY_ACTIVE.
 */
export const grantStaffAccess = internalMutation({
	args: { email: v.string(), displayName: v.string() },
	handler: async (ctx, args) => {
		const email = args.email.trim().toLowerCase(), name = args.displayName.trim();
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('STAFF_EMAIL_REQUIRED');
		if (!name || [...name].length > 120 || control.test(name)) fail('STAFF_DISPLAY_NAME_REQUIRED');
		let user = await ctx.db.query('users').withIndex('email', (q) => q.eq('email', email)).unique();
		if (!user) {
			const userId = await ctx.db.insert('users', { email, auth_user_id: newUuid() });
			await ctx.db.insert('authAccounts', { userId, provider: 'password', providerAccountId: email });
			user = (await ctx.db.get(userId))!;
		}
		if (!user.auth_user_id) { await ctx.db.patch(user._id, { auth_user_id: newUuid() }); user = (await ctx.db.get(user._id))!; }
		const authUserId = user.auth_user_id!;
		const staff = await ctx.db.query('staff_members').withIndex('auth_user_id', (q) => q.eq('auth_user_id', authUserId)).unique();
		if (staff?.is_active) fail('STAFF_ALREADY_ACTIVE', email);
		if (staff) return (await patchAudited(ctx, SYSTEM, 'staff_members', staff, { display_name: name, is_active: true })).id;
		return (await insertAudited(ctx, SYSTEM, 'staff_members', { id: newUuid(), auth_user_id: authUserId, display_name: name, is_active: true, created_at: isoNow() })).id;
	}
});

/** Maintainer recovery: deactivate a member by email. It can remove the last one, so use it only with a recovery plan. */
export const revokeStaffAccess = internalMutation({
	args: { email: v.string() },
	handler: async (ctx, args) => {
		const email = args.email.trim().toLowerCase();
		const user = await ctx.db.query('users').withIndex('email', (q) => q.eq('email', email)).unique();
		const staff = user?.auth_user_id ? await ctx.db.query('staff_members').withIndex('auth_user_id', (q) => q.eq('auth_user_id', user.auth_user_id!)).unique() : null;
		if (!staff?.is_active) fail('STAFF_NOT_ACTIVE', email);
		return (await patchAudited(ctx, SYSTEM, 'staff_members', staff, { is_active: false })).id;
	}
});
