import { object, text, identifier } from './api';
import { api, type ConvexCaller } from './convex';

export type HelpContact = {
	id: string; display_name: string; responsibility: string | null; email: string | null; phone: string | null;
	contact_url: string | null; discord: string | null; display_order: number;
};
/** Whether the row has a way to reach the person, which publishing requires. */
export const reachable = (contact: Pick<HelpContact, 'email' | 'phone' | 'contact_url' | 'discord'>) => Boolean(contact.email || contact.phone || contact.contact_url || contact.discord);
/** The database's rule for published links: HTTPS on a DNS name, no credentials, whitespace, backslashes or control characters. */
export function isSafeHttpsUrl(value: string): boolean {
	let url: URL;
	try { url = new URL(value); } catch { return false; }
	// eslint-disable-next-line no-control-regex -- control characters are exactly what this rejects.
	return url.protocol === 'https:' && !url.username && !url.password && !/[\s\\\x00-\x1f\x7f]/.test(value) && /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(url.hostname);
}
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
	if (contact_url && !isSafeHttpsUrl(contact_url)) throw new Error('Invalid contact URL');
	const display_order = row.display_order;
	if (typeof display_order !== 'number' || !Number.isSafeInteger(display_order) || display_order < 0 || display_order > 2147483647) throw new Error('Invalid contact order');
	return { id: identifier(row.id), display_name: text(row.display_name, 120), responsibility, email, phone, contact_url, discord, display_order };
}
export function parseEditableHelpContact(value: unknown): EditableHelpContact {
	const row = object(value);
	if (typeof row.is_published !== 'boolean' || typeof row.edit_revision !== 'string' || !/^[1-9]\d*$/.test(row.edit_revision)) throw new Error('Invalid contact revision');
	const contact = parseHelpContact(value);
	if (row.is_published && !reachable(contact)) throw new Error('Missing published contact');
	return { ...contact, is_published: row.is_published, edit_revision: row.edit_revision };
}

/** Published contacts in display order (one live, complete list; never truncated). */
export async function readHelpDirectory(client: ConvexCaller): Promise<HelpContact[]> {
	const seen = new Set<string>();
	return (await client.query(api.catalog.helpDirectory, {})).map((raw) => {
		const entry = parseHelpContact(raw);
		if (!reachable(entry) || seen.has(entry.id)) throw new Error('Invalid directory entry');
		seen.add(entry.id);
		return entry;
	});
}
