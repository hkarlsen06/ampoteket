import { expect, test } from 'bun:test';
import { memory } from './test-storage';
import { adminReturnPath } from './admin-auth';
import { clearRecoveryCommand, readRecoveryCommand, recoverStaffCheckout, saveRecoveryCommand, readStaffCheckout, staffRequest, allStaffRows, reorderHelpContacts } from './admin-api';
const command = { userId: '11111111-1111-4111-8111-111111111111', requestId: '22222222-2222-4222-8222-222222222222', checkoutId: '33333333-3333-4333-8333-333333333333', reason: 'Helped identify the original purchase' };
const session = { config: { url: 'https://fixture.invalid', publishableKey: 'sb_publishable_fixture' }, token: 'staff-jwt', userId: command.userId };
test('directory moves send the displayed prior order alongside the desired order', async () => {
	const before = [command.userId, command.requestId]; const after = [...before].reverse();
	await reorderHelpContacts(session, after, before, async (_input, init) => {
		expect(JSON.parse(String(init?.body))).toEqual({ p_ids: after, p_expected_ids: before });
		return new Response(null, { status: 204 });
	});
});
test('admin returns allow only built local destinations without callback material', () => {
	for (const value of ['//evil.invalid', 'https://evil.invalid', '/en/admin', '/admin?token=secret', '/admin/password', '/admin\\evil', '/admin/%2f%2fevil', null]) expect(adminReturnPath(value)).toBe('/admin');
	expect(adminReturnPath('/admin/privacy')).toBe('/admin/privacy');
	expect(adminReturnPath('/admin/admins')).toBe('/admin/admins');
	expect(adminReturnPath('/admin/statistics')).toBe('/admin/statistics');
	for (const path of ['/admin/products', '/admin/products/new', '/admin/products/labels', `/admin/products/${command.userId}`, '/admin/shelf', '/admin/stock', '/admin/audit', '/admin/counts', `/admin/counts/${command.requestId}`]) expect(adminReturnPath(path)).toBe(path);
	for (const path of ['/admin/products/bad-id', '/admin/counts/new', '/admin/shelf?token=secret', '/admin/products/../../password']) expect(adminReturnPath(path)).toBe('/admin');
});
test('staff deletion retains its verb and uses the bounded authenticated transport', async () => {
	await staffRequest(session, 'amp_product_attributes', { product_id: `eq.${command.userId}` }, undefined, 'DELETE', async (_input, init) => {
		expect(init?.method).toBe('DELETE'); expect(init?.signal).toBeInstanceOf(AbortSignal);
		expect(init?.credentials).toBe('omit'); expect(init?.redirect).toBe('manual');
		return new Response('[]');
	});
});
test('complete staff pagination retains key filters and existing conjunctions after a capped page', async () => {
	const filters = { id: `in.(${command.userId},${command.requestId})`, and: '(is_active.eq.true)' };
	let calls = 0;
	const rows = await allStaffRows(session, 'amp_products', 'id', 'id', filters, async (input) => {
		const query = new URL(String(input)).searchParams;
		expect(query.get('id')).toBe(filters.id);
		expect(query.get('and')).toBe(calls ? `(id.gt.${command.userId},and(is_active.eq.true))` : filters.and);
		return Response.json(calls++ ? [] : [{ id: command.userId }]);
	});
	expect(calls).toBe(2); expect(rows).toEqual([{ id: command.userId }]);
});
test('recovery persists unchanged request and initiating identity, rejects replacement, and compares cleanup', () => {
	const storage = memory(); saveRecoveryCommand(storage, command);
	expect(readRecoveryCommand(storage)).toEqual(command);
	expect(() => saveRecoveryCommand(storage, { ...command, reason: 'changed' })).toThrow();
	clearRecoveryCommand(storage, { ...command, userId: command.requestId }); expect(readRecoveryCommand(storage)).toEqual(command);
	clearRecoveryCommand(storage, command); expect(readRecoveryCommand(storage)).toBeNull();
	expect(() => saveRecoveryCommand({ getItem: () => null, setItem: () => {} }, command)).toThrow();
});
test('recovery sends exact frozen payload with staff JWT and prevents a changed identity', async () => {
	let sent = 0;
	const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
		sent++; expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer staff-jwt');
		expect(JSON.parse(String(init?.body))).toEqual({ p_request_id: command.requestId, p_checkout_id: command.checkoutId, p_reason: command.reason });
		return Response.json({ checkout_id: command.checkoutId, event_id: command.requestId, status: 'confirmed' });
	};
	await recoverStaffCheckout(session, command, fetcher); await recoverStaffCheckout(session, command, fetcher);
	await expect(recoverStaffCheckout({ ...session, userId: command.requestId }, command, fetcher)).rejects.toThrow('identity');
	expect(sent).toBe(2);
});
test('original checkout lookup traverses capped immutable lines and uses the exact database total', async () => {
	const productId = '44444444-4444-4444-8444-444444444444'; let linePages = 0; let productPages = 0;
	const snapshot = await readStaffCheckout(session, command.requestId, async (input) => {
		const url = new URL(String(input));
		switch (url.pathname) {
			case '/rest/v1/amp_checkouts': expect(url.searchParams.get('or')).toContain(`request_id.eq.${command.requestId}`); return Response.json([{ id: command.checkoutId, request_id: command.requestId, created_at: '2026-09-20T10:00:00Z' }]);
			case '/rest/v1/amp_checkout_lines': return Response.json(linePages++ ? [] : [{ checkout_id: command.checkoutId, product_id: productId, product_name_nb_snapshot: 'Lagret', product_name_en_snapshot: 'Saved', quantity: '999999999998.999999', unit_price_nok: '0.000001' }]);
			case '/rest/v1/amp_checkout_totals': return new Response(`[{"checkout_id":"${command.checkoutId}","total_nok":999999999998.99}]`);
			case '/rest/v1/amp_sales': return Response.json([]);
			case '/rest/v1/amp_products': return Response.json(productPages++ ? [] : [{ id: productId, code: 'RES-00123', unit_code: 'pcs' }]);
			default: throw new Error('Unexpected request');
		}
	});
	expect(linePages).toBe(2); expect(productPages).toBe(2);
	expect(snapshot?.items[0].quantity).toBe('999999999998.999999'); expect(snapshot?.total).toBe('999999999998.99');
});
