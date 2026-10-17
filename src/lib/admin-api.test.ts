import { expect, test } from 'bun:test';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { memory } from './test-storage';
import { adminReturnPath } from './admin-auth';
import type { ConvexCaller } from './convex';
import { clearCheckoutContact, clearRecoveryCommand, readCheckoutContact, readRecoveryCommand, recoverStaffCheckout, saveRecoveryCommand, readStaffCheckout, reorderHelpContacts } from './admin-api';
const command = { userId: '11111111-1111-4111-8111-111111111111', requestId: '22222222-2222-4222-8222-222222222222', checkoutId: '33333333-3333-4333-8333-333333333333', reason: 'Helped identify the original purchase' };

/** A Convex client stub answering by function name (`checkout:recover`). */
function stub(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
	const calls: { name: string; args: Record<string, unknown> }[] = [];
	const run = async (fn: FunctionReference<'query' | 'mutation' | 'action'>, args: Record<string, unknown>) => {
		const name = getFunctionName(fn); calls.push({ name, args });
		if (!handlers[name]) throw new Error(`Unexpected ${name}`);
		return handlers[name](args);
	};
	return { session: { client: { query: run, mutation: run, action: run } as unknown as ConvexCaller, userId: command.userId }, calls };
}

test('directory moves send the displayed prior order alongside the desired order', async () => {
	const before = [command.userId, command.requestId]; const after = [...before].reverse();
	const { session, calls } = stub({ 'help:reorder': () => null });
	await reorderHelpContacts(session, after, before);
	expect(calls).toEqual([{ name: 'help:reorder', args: { ids: after, expectedIds: before } }]);
});
test('admin returns allow only built local destinations without callback material', () => {
	for (const value of ['//evil.invalid', 'https://evil.invalid', '/en/admin', '/admin?token=secret', '/admin/password', '/admin\\evil', '/admin/%2f%2fevil', null]) expect(adminReturnPath(value)).toBe('/admin');
	expect(adminReturnPath('/admin/purchases')).toBe('/admin/purchases');
	expect(adminReturnPath('/admin/contacts')).toBe('/admin/contacts');
	for (const retired of ['/admin/privacy', '/admin/help']) expect(adminReturnPath(retired)).toBe('/admin');
	expect(adminReturnPath('/admin/admins')).toBe('/admin/admins');
	expect(adminReturnPath('/admin/statistics')).toBe('/admin/statistics');
	for (const path of ['/admin/products', '/admin/products/new', '/admin/products/labels', `/admin/products/${command.userId}`, '/admin/shelf', '/admin/stock', '/admin/audit', '/admin/counts', `/admin/counts/${command.requestId}`]) expect(adminReturnPath(path)).toBe(path);
	for (const path of ['/admin/products/bad-id', '/admin/counts/new', '/admin/shelf?token=secret', '/admin/products/../../password']) expect(adminReturnPath(path)).toBe('/admin');
});
test('recovery persists unchanged request and initiating identity, rejects replacement, and compares cleanup', () => {
	const storage = memory(); saveRecoveryCommand(storage, command);
	expect(readRecoveryCommand(storage)).toEqual(command);
	expect(() => saveRecoveryCommand(storage, { ...command, reason: 'changed' })).toThrow();
	clearRecoveryCommand(storage, { ...command, userId: command.requestId }); expect(readRecoveryCommand(storage)).toEqual(command);
	clearRecoveryCommand(storage, command); expect(readRecoveryCommand(storage)).toBeNull();
	expect(() => saveRecoveryCommand({ getItem: () => null, setItem: () => {} }, command)).toThrow();
});
test('recovery sends the exact frozen arguments, rejects a mismatched answer and prevents a changed identity', async () => {
	const { session, calls } = stub({ 'checkout:recover': (args) => ({ checkout_id: args.checkoutId, event_id: command.requestId, status: 'confirmed' }) });
	expect(await recoverStaffCheckout(session, command)).toBe(command.requestId);
	await recoverStaffCheckout(session, command);
	expect(calls.map((call) => call.args)).toEqual([0, 1].map(() => ({ requestId: command.requestId, checkoutId: command.checkoutId, reason: command.reason })));
	await expect(recoverStaffCheckout({ ...session, userId: command.requestId }, command)).rejects.toThrow('identity');
	expect(calls).toHaveLength(2);
	const pending = stub({ 'checkout:recover': () => ({ checkout_id: command.checkoutId, event_id: command.requestId, status: 'pending' }) });
	await expect(recoverStaffCheckout(pending.session, command)).rejects.toThrow('recovery');
});
test('checkout lookup and contact access go by validated identifiers only', async () => {
	const { session, calls } = stub({
		'checkout:staffLookup': () => null,
		'checkout:staffContact': () => 'Discord: buyer',
		'checkout:clearContact': () => ({ checkout_id: command.checkoutId, contact_removed: true })
	});
	expect(await readStaffCheckout(session, command.requestId)).toBeNull();
	expect(await readCheckoutContact(session, command.checkoutId)).toBe('Discord: buyer');
	expect(await clearCheckoutContact(session, command.checkoutId)).toBe(true);
	expect(calls.map((call) => call.args)).toEqual([{ reference: command.requestId }, { checkoutId: command.checkoutId }, { checkoutId: command.checkoutId }]);
	await expect(readStaffCheckout(session, 'request_id.eq.x')).rejects.toThrow();
	expect(calls).toHaveLength(3);
});
