/**
 * Staff side of the public volunteer directory (datamodell.md §9, api-contract.md
 * "Public volunteer directory"). Entries are unpublished, never deleted.
 */
import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { insertAudited, patchAudited } from './lib/audit';
import { fail } from './lib/errors';
import { byUuid, isUuid } from './lib/ids';
import { requireStaff } from './lib/staff';
import { isoNow } from './lib/time';

const nullableString = v.union(v.string(), v.null());
const contactFields = v.object({
	display_name: v.string(), responsibility: nullableString, email: nullableString, phone: nullableString,
	contact_url: nullableString, discord: nullableString, is_published: v.boolean()
});
type ContactFields = typeof contactFields.type;
// eslint-disable-next-line no-control-regex -- control characters are exactly what this rejects.
const control = /[\u0000-\u001f\u007f]/;

/** The help_contacts table checks. */
function checkContact(c: ContactFields) {
	const name = c.display_name.trim();
	if (!name || [...name].length > 120 || control.test(c.display_name)) fail('INVALID_HELP_CONTACT', 'display_name');
	if (c.responsibility !== null && (!c.responsibility.trim() || [...c.responsibility.trim()].length > 80 || control.test(c.responsibility))) fail('INVALID_HELP_CONTACT', 'responsibility');
	if (c.email !== null && (c.email.length > 254 || !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(c.email))) fail('INVALID_HELP_CONTACT', 'email');
	if (c.phone !== null && (c.phone.length < 3 || c.phone.length > 40 || !/^\+?[0-9][0-9 ()-]*[0-9]$/.test(c.phone) || c.phone.replace(/\D/g, '').length < 3)) fail('INVALID_HELP_CONTACT', 'phone');
	if (c.contact_url !== null) {
		const port = /^https:\/\/[^/:?#]+:([0-9]+)/.exec(c.contact_url)?.[1];
		if (c.contact_url.length > 500 || control.test(c.contact_url) || (port !== undefined && Number(port) > 65535)
			|| !/^https:\/\/([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}(:[0-9]{1,5})?([/?#][^\s\\]*)?$/.test(c.contact_url)) fail('INVALID_HELP_CONTACT', 'contact_url');
	}
	if (c.discord !== null && (!/^[a-z0-9_.]{2,32}$/.test(c.discord) || c.discord.includes('..'))) fail('INVALID_HELP_CONTACT', 'discord');
	if (c.is_published && !(c.email || c.phone || c.contact_url || c.discord)) fail('HELP_CONTACT_NOT_REACHABLE');
}

function editableRow(c: Doc<'help_contacts'>) {
	return { id: c.id, display_name: c.display_name, responsibility: c.responsibility, email: c.email, phone: c.phone, contact_url: c.contact_url,
		discord: c.discord, display_order: c.display_order, is_published: c.is_published, edit_revision: String(c.edit_revision) };
}

/** Every contact, drafts included, in display order. */
export const list = query({
	args: {},
	handler: async (ctx) => {
		await requireStaff(ctx);
		return (await ctx.db.query('help_contacts').withIndex('display_order').collect()).map(editableRow);
	}
});

/**
 * Create (revision null, client-chosen UUID) or edit a contact. An edit
 * compares `revision` with the stored `edit_revision`: STALE_HELP_CONTACT means
 * someone else saved first, so the editor keeps its draft for review.
 */
export const save = mutation({
	args: { id: v.string(), revision: nullableString, fields: contactFields },
	handler: async (ctx, { id, revision, fields }) => {
		const { actor } = await requireStaff(ctx);
		if (!isUuid(id)) fail('INVALID_HELP_CONTACT', 'id');
		const current = await byUuid(ctx, 'help_contacts', id);
		const same = (c: Doc<'help_contacts'>) => (Object.keys(fields) as (keyof ContactFields)[]).every((key) => c[key] === fields[key]);
		if (current && same(current)) return editableRow(current);
		if (revision === null ? current !== null : !current || String(current.edit_revision) !== revision) fail('STALE_HELP_CONTACT');
		checkContact(fields);
		const now = isoNow();
		if (!current) {
			const last = await ctx.db.query('help_contacts').withIndex('display_order').order('desc').first();
			return editableRow(await insertAudited(ctx, actor, 'help_contacts', { id, ...fields, display_order: last ? last.display_order + 1 : 0,
				edit_revision: 1, created_at: now, updated_at: now }));
		}
		return editableRow(await patchAudited(ctx, actor, 'help_contacts', current, { ...fields, edit_revision: current.edit_revision + 1, updated_at: now }));
	}
});

/**
 * Rearrange the whole list. `ids` is every contact in the new order and
 * `expectedIds` the order the user saw; STALE_HELP_ORDER if they no longer
 * match. A retry whose order is already current changes nothing. Moves do not
 * advance `edit_revision`, so an open editor stays current.
 */
export const reorder = mutation({
	args: { ids: v.array(v.string()), expectedIds: v.array(v.string()) },
	handler: async (ctx, { ids, expectedIds }) => {
		const { actor } = await requireStaff(ctx);
		const contacts = await ctx.db.query('help_contacts').withIndex('display_order').collect();
		const current = contacts.map((c) => c.id);
		if (ids.length !== current.length || new Set(ids.filter((id) => current.includes(id))).size !== ids.length) fail('STALE_HELP_ORDER');
		if (ids.every((id, i) => id === current[i])) return null;
		if (expectedIds.length !== current.length || expectedIds.some((id, i) => id !== current[i])) fail('STALE_HELP_ORDER');
		for (const [position, id] of ids.entries()) {
			const contact = contacts.find((c) => c.id === id)!;
			if (contact.display_order !== position) await patchAudited(ctx, actor, 'help_contacts', contact, { display_order: position });
		}
		return null;
	}
});
