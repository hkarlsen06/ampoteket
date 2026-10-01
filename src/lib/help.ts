import { requestApiJson, object, text, identifier, type Fetcher } from './api';
import type { AdminAuthConfig } from './admin-auth';

export type HelpContact = {
	id: string; display_name: string; responsibility: string | null; email: string | null; phone: string | null;
	contact_url: string | null; discord: string | null; display_order: number;
};
/** Whether the row has a way to reach the person, which publishing requires. */
export const reachable = (contact: HelpContact) => Boolean(contact.email || contact.phone || contact.contact_url || contact.discord);
export type EditableHelpContact = HelpContact & { is_published: boolean; edit_revision: string };
export function parseHelpContact(value: unknown): HelpContact {
	const row = object(value);
	const email = row.email === null ? null : text(row.email, 254);
	const phone = row.phone === null ? null : text(row.phone, 40);
	const contact_url = row.contact_url === null ? null : text(row.contact_url, 500);
	const responsibility = row.responsibility === null ? null : text(row.responsibility, 80);
	const discord = row.discord === null ? null : text(row.discord, 32);
	if (discord && (!/^[a-z0-9_.]{2,32}$/.test(discord) || discord.includes('..'))) throw new Error('Invalid contact Discord');
	if (email && !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/.test(email)) throw new Error('Invalid contact email');
	if (phone && (!/^\+?[0-9 ()-]+$/.test(phone) || phone.replace(/\D/g, '').length < 3)) throw new Error('Invalid contact phone');
	if (contact_url) {
		const url = new URL(contact_url);
		// eslint-disable-next-line no-control-regex -- control characters are exactly what this rejects.
		if (url.protocol !== 'https:' || url.username || url.password || /[\s\\\x00-\x1f\x7f]/.test(contact_url) || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(url.hostname)) throw new Error('Invalid contact URL');
	}
	if (typeof row.display_order !== 'string' || !/^\d+$/.test(row.display_order)) throw new Error('Invalid contact order');
	const display_order = Number(row.display_order);
	if (!Number.isSafeInteger(display_order) || display_order > 2147483647) throw new Error('Invalid contact order');
	return { id: identifier(row.id), display_name: text(row.display_name, 120), responsibility, email, phone, contact_url, discord, display_order };
}
export function parseEditableHelpContact(value: unknown): EditableHelpContact {
	const row = object(value);
	if (typeof row.is_published !== 'boolean' || typeof row.edit_revision !== 'string' || !/^[1-9]\d*$/.test(row.edit_revision)) throw new Error('Invalid contact revision');
	const contact = parseHelpContact(value);
	if (row.is_published && !reachable(contact)) throw new Error('Missing published contact');
	return { ...contact, is_published: row.is_published, edit_revision: row.edit_revision };
}

/** Public-only read; a short API page is never evidence that traversal finished. */
export async function readHelpDirectory(config: AdminAuthConfig, fetcher: Fetcher = fetch): Promise<HelpContact[]> {
	const result: HelpContact[] = [];
	const seen = new Set<string>();
	let cursor: HelpContact | undefined;
	for (;;) {
		const rows = await requestApiJson(new URL('/rest/v1/rpc/amp_help_directory', config.url), {
			method: 'POST', cache: 'no-store', credentials: 'omit',
			headers: { apikey: config.publishableKey, 'Content-Type': 'application/json' },
			body: JSON.stringify({ p_limit: 100, ...(cursor ? { p_after_order: cursor.display_order, p_after_id: cursor.id } : {}) })
		}, fetcher);
		if (!Array.isArray(rows) || rows.length > 100) throw new Error('Invalid directory page');
		if (!rows.length) return result;
		for (const raw of rows) {
			const entry = parseHelpContact(raw);
			if (!reachable(entry) || seen.has(entry.id)
				|| (cursor && (entry.display_order < cursor.display_order || (entry.display_order === cursor.display_order && entry.id <= cursor.id)))) throw new Error('Invalid directory cursor');
			seen.add(entry.id); result.push(entry); cursor = entry;
		}
	}
}
