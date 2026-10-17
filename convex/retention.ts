/**
 * Optional checkout contacts on unconfirmed checkouts are cleared 90 × 24 hours
 * after the checkout was made (docs/runbook-contact-retention.md). Confirmed
 * checkouts are outside this rule; staff erase those on request. Runs daily from
 * convex/crons.ts, in batches that schedule the next one until none are left.
 * Each clearance is audited as CONTACT_CLEARED by the system, without the text.
 */
import { internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import { recordAudit, SYSTEM } from './lib/audit';
import { byUuid } from './lib/ids';
import { isoAt } from './lib/time';

const RETENTION_MS = 90 * 24 * 3_600_000;
const BATCH = 100;

export const clearExpiredContacts = internalMutation({
	args: {},
	handler: async (ctx) => {
		const cutoff = isoAt(Date.now() - RETENTION_MS);
		let cleared = 0;
		for (const contact of await ctx.db.query('checkout_contacts').collect()) {
			if (cleared >= BATCH) break;
			const checkout = await byUuid(ctx, 'checkouts', contact.checkout_id);
			if (!checkout || checkout.created_at >= cutoff) continue;
			if (await ctx.db.query('sales').withIndex('checkout_id', (q) => q.eq('checkout_id', checkout.id)).unique()) continue;
			await ctx.db.delete(contact._id);
			await recordAudit(ctx, SYSTEM, { table: 'checkout_contacts', key: { checkout_id: checkout.id }, action: 'CONTACT_CLEARED', before: null, after: null });
			cleared++;
		}
		if (cleared >= BATCH) await ctx.scheduler.runAfter(0, internal.retention.clearExpiredContacts, {});
		return cleared;
	}
});
