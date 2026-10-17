import { api, type StaffSession } from './convex';
import { identifier, object, text } from './api';
import { parseEditableHelpContact, type EditableHelpContact } from './help';

export type { StaffSession } from './convex';

export type StaffCheckout = {
	id: string; requestId: string; createdAt: string; total: string;
	registered: boolean; eventId: string | null; registeredAt: string | null;
	items: { productId: string; name_nb: string; name_en: string; code: string; unit: string; quantity: string; unitPrice: string }[];
};
/** A checkout by its ID or by its prepare request ID; null when neither matches. */
export async function readStaffCheckout(session: StaffSession, reference: string): Promise<StaffCheckout | null> {
	identifier(reference);
	return await session.client.query(api.checkout.staffLookup, { reference });
}

export type RecoveryCommand = { userId: string; requestId: string; checkoutId: string; reason: string };
const recoveryKey = 'ampoteket:admin-recovery:v1';
export function readRecoveryCommand(storage: Pick<Storage, 'getItem'>): RecoveryCommand | null {
	const raw = storage.getItem(recoveryKey);
	if (!raw) return null;
	const row = object(JSON.parse(raw));
	return { userId: identifier(row.userId), requestId: identifier(row.requestId), checkoutId: identifier(row.checkoutId), reason: text(row.reason, 2000) };
}
export function saveRecoveryCommand(storage: Pick<Storage, 'getItem' | 'setItem'>, command: RecoveryCommand): RecoveryCommand {
	const existing = readRecoveryCommand(storage);
	if (existing && JSON.stringify(existing) !== JSON.stringify(command)) throw new Error('Unresolved recovery command');
	storage.setItem(recoveryKey, JSON.stringify(command));
	const saved = readRecoveryCommand(storage);
	if (!saved || JSON.stringify(saved) !== JSON.stringify(command)) throw new Error('Recovery persistence unavailable');
	return saved;
}
export function clearRecoveryCommand(storage: Pick<Storage, 'getItem' | 'removeItem'>, command: RecoveryCommand): void {
	const saved = readRecoveryCommand(storage);
	if (saved?.requestId === command.requestId && saved.userId === command.userId) storage.removeItem(recoveryKey);
}
/** Register the original checkout for the buyer; repeat-safe with the same request ID. */
export async function recoverStaffCheckout(session: StaffSession, command: RecoveryCommand): Promise<string> {
	if (session.userId !== command.userId) throw new Error('Recovery identity changed');
	const result = await session.client.mutation(api.checkout.recover, { requestId: command.requestId, checkoutId: command.checkoutId, reason: command.reason });
	if (result.checkout_id !== command.checkoutId || result.status !== 'confirmed') throw new Error('Invalid recovery response');
	return identifier(result.event_id);
}
/** The optional, unverified contact; read only when staff choose to show it. */
export async function readCheckoutContact(session: StaffSession, checkoutId: string): Promise<string | null> {
	return await session.client.query(api.checkout.staffContact, { checkoutId: identifier(checkoutId) });
}
/** Remove the optional contact; repeat-safe. */
export async function clearCheckoutContact(session: StaffSession, checkoutId: string): Promise<boolean> {
	return (await session.client.mutation(api.checkout.clearContact, { checkoutId: identifier(checkoutId) })).contact_removed;
}

/** Every contact, drafts included, in display order. */
export async function readAdminHelp(session: StaffSession): Promise<EditableHelpContact[]> {
	return (await session.client.query(api.help.list, {})).map(parseEditableHelpContact);
}
/** Both lists include drafts; a stale prior order must be re-read before another move. */
export async function reorderHelpContacts(session: StaffSession, ids: string[], expectedIds: string[]) {
	await session.client.mutation(api.help.reorder, { ids, expectedIds });
}
