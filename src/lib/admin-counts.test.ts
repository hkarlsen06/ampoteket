import { expect, test } from 'bun:test';
import { memory } from './test-storage';
import { ApiError } from './api';
import { clearCountCommand, countBatchAccess, countCommandPath, countDifference, countRejection, countStorageKey, readCountBatches, readCountDetail, readCountCommand, readCountHistory, readCountInventory, runCountCommand, saveCountCommand, validCountQuantity, type CountBatch, type CountCommand } from './admin-counts';

const userId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const batchId = '33333333-3333-4333-8333-333333333333';
const eventId = '44444444-4444-4444-8444-444444444444';
const requestId = '55555555-5555-4555-8555-555555555555';
const session = { config: { url: 'https://fixture.invalid', publishableKey: 'sb_publishable_fixture' }, token: 'real-staff-token', userId };
const command: CountCommand = { kind: 'count', userId, requestId, productId, batchId: null, revision: '9007199254740993', expected: '1999999999998.999999', quantity: '1999999999998.999999', note: 'Bin paused and checked' };

test('physical counts preserve accumulated stock precision, allow explicit zero and reject wrong steps', () => {
	expect(validCountQuantity('1999999999998.999999', '0.000001')).toBe('1999999999998.999999');
	expect(validCountQuantity('0', '1')).toBe('0');
	expect(validCountQuantity('1,125', '0.001', 'nb')).toBe('1.125');
	expect(validCountQuantity('0.25', '0.125')).toBe('0.25');
	for (const value of ['-1', '', 'NaN', '1e3', '0.0000001', '0.01']) expect(() => validCountQuantity(value, '0.125')).toThrow();
	expect(() => validCountQuantity('1', '0')).toThrow();
	expect(countDifference('1999999999998.999999', '1999999999998.999998')).toBe('0.000001');
	expect(countDifference('0', '-2.5')).toBe('2.5');
});

test('pending count persists its exact actor and original observation, refusing replacement and unsafe cleanup', () => {
	const storage = memory(); saveCountCommand(storage, command);
	expect(readCountCommand(storage)).toEqual(command);
	for (const change of [{ userId: productId }, { quantity: '1' }, { revision: '9007199254740994' }, { requestId: eventId }]) {
		expect(() => saveCountCommand(storage, { ...command, ...change })).toThrow();
		expect(() => clearCountCommand(storage, { ...command, ...change })).toThrow();
	}
	expect(readCountCommand(storage)).toEqual(command);
	clearCountCommand(storage, command); expect(readCountCommand(storage)).toBeNull();
	expect(() => saveCountCommand({ getItem: () => null, setItem: () => {} }, command)).toThrow();
	storage.setItem(countStorageKey, JSON.stringify({ ...command, revision: 9007199254740992 }));
	expect(() => readCountCommand(storage)).toThrow();
	expect(countCommandPath(command)).toBe(`/admin/products/${productId}`);
	expect(countCommandPath({ ...command, batchId })).toBe(`/admin/counts/${batchId}`);
});

test('single count retries send identical lossless payload and retain zero-difference success', async () => {
	const bodies: string[] = [];
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		expect(new URL(String(input)).pathname).toBe('/rest/v1/rpc/amp_record_single_count');
		expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${session.token}`);
		bodies.push(String(init?.body));
		expect(JSON.parse(String(init?.body))).toEqual({ p_request_id: requestId, p_product_id: productId, p_expected_revision: command.revision, p_counted_quantity: command.quantity, p_note: command.note });
		return Response.json({ batch_id: batchId, event_id: eventId, quantity: command.quantity, difference: '0' });
	};
	const result = await runCountCommand(session, command, fetcher);
	expect(result).toEqual({ batchId, eventId, quantity: command.quantity, difference: '0' });
	expect(await runCountCommand(session, command, fetcher)).toEqual(result);
	expect(bodies[0]).toBe(bodies[1]);
	await expect(runCountCommand({ ...session, userId: eventId }, command, fetcher)).rejects.toThrow('identity');
	expect(bodies).toHaveLength(2);
	await expect(runCountCommand(session, command, async () => Response.json({ batch_id: batchId, event_id: eventId, quantity: '0', difference: '0' }))).rejects.toThrow();
});

test('batch counts, start and both closing operations keep their original identities', async () => {
	const calls: Array<{ path: string; body: unknown }> = [];
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		const path = new URL(String(input)).pathname; calls.push({ path, body: JSON.parse(String(init?.body)) });
		return Response.json(path.endsWith('amp_record_count') ? { event_id: eventId, quantity: command.quantity, difference: '0' } : { batch_id: batchId, finished: true });
	};
	await runCountCommand(session, { ...command, batchId }, fetcher);
	await runCountCommand(session, { kind: 'start', userId, requestId, title: 'Lower drawers' }, fetcher);
	await runCountCommand(session, { kind: 'finish', userId, requestId, batchId }, fetcher);
	await runCountCommand(session, { kind: 'close', userId, requestId, batchId, reason: 'Owner left the workshop' }, fetcher);
	expect(calls[0].body).toEqual({ p_request_id: requestId, p_batch_id: batchId, p_product_id: productId, p_expected_revision: command.revision, p_counted_quantity: command.quantity, p_note: command.note });
	expect(calls[1].body).toEqual({ p_request_id: requestId, p_title: 'Lower drawers' });
	expect(calls[2].body).toEqual({ p_batch_id: batchId });
	expect(calls[3].body).toEqual({ p_request_id: requestId, p_batch_id: batchId, p_reason: 'Owner left the workshop' });
});

test('inventory keeps stock revision lossless and refuses a missing or mismatched product', async () => {
	const fetcher = async () => new Response(`[{"product_id":"${productId}","quantity":1999999999998.999999,"revision":9007199254740993,"last_counted_at":null}]`);
	expect(await readCountInventory(session, productId, fetcher)).toEqual({ productId, quantity: command.quantity, revision: command.revision, lastCountedAt: null });
	await expect(readCountInventory(session, batchId, fetcher)).rejects.toThrow('binding');
	await expect(readCountInventory(session, productId, async () => Response.json([]))).rejects.toThrow('unavailable');
});

test('only explicit rolled-back count rejections allow a fresh observation', () => {
	expect(countRejection(new ApiError(400, { message: 'STALE_STOCK_COUNT' }))).toBe('stale');
	expect(countRejection(new ApiError(400, { message: 'COUNT_BATCH_FINISHED' }))).toBe('closed');
	expect(countRejection(new ApiError(400, { message: 'COUNT_BATCH_OWNER_STILL_ACTIVE' }))).toBe('owner');
	for (const error of [new Error('Timeout'), new ApiError(500, null), new ApiError(401, { message: 'Expired JWT' }), new ApiError(400, { message: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT' })]) expect(countRejection(error)).toBeNull();
});

test('batch reads traverse capped pages, and ownership permits abandoned closure only when eligible', async () => {
	const calls = new Map<string, number>();
	const data = await readCountBatches(session, async (input) => {
		const url = new URL(String(input)); const count = calls.get(url.pathname) ?? 0; calls.set(url.pathname, count + 1);
		if (count) { expect(url.searchParams.get('and')).toBe(`(id.gt.${url.pathname.endsWith('amp_count_batches') ? batchId : userId})`); return Response.json([]); }
		return Response.json(url.pathname.endsWith('amp_count_batches') ? [{ id: batchId, owner_id: userId, title: 'A1', started_at: '2026-09-20T10:00:00Z', finished_at: null, finished_by: null, finish_reason: null }] : [{ id: userId, auth_user_id: userId, display_name: 'First admin', is_active: true }]);
	});
	expect([...calls.values()]).toEqual([2, 2]);
	const batch = data.batches[0]; const owner = data.owners[0];
	expect(countBatchAccess(batch, owner, userId)).toBe('owner');
	expect(countBatchAccess(batch, owner, productId)).toBe('other');
	expect(countBatchAccess(batch, { ...owner, active: false }, productId)).toBe('abandoned');
	expect(countBatchAccess(batch, { ...owner, authUserId: null }, productId)).toBe('abandoned');
	expect(countBatchAccess({ ...batch, finishedAt: '2026-09-20T11:00:00Z' } as CountBatch, owner, userId)).toBe('finished');
});

test('history continues through an empty page and preserves matching observations without a movement', async () => {
	const calls = new Map<string, number>();
	const result = await readCountHistory(session, batchId, async (input) => {
		const url = new URL(String(input)); const count = calls.get(url.pathname) ?? 0; calls.set(url.pathname, count + 1);
		if (url.pathname.endsWith('amp_stock_counts')) {
			expect(url.searchParams.get('batch_id')).toBe(`eq.${batchId}`);
			return Response.json(count ? [] : [{ event_id: eventId, batch_id: batchId, product_id: productId, expected_quantity: command.quantity, counted_quantity: command.quantity, expected_revision: command.revision }]);
		}
		expect(url.searchParams.get('id')).toBe(`in.(${eventId})`);
		if (count) expect(url.searchParams.get('and')).toBe(`(id.gt.${eventId})`);
		return Response.json(count ? [] : [{ id: eventId, kind: 'count', recorded_at: '2026-09-20T10:00:00Z', actor_id: userId, note: null }]);
	});
	expect([...calls.values()]).toEqual([2, 2]);
	expect(result[0]).toEqual({ eventId, batchId, productId, expected: command.quantity, counted: command.quantity, revision: command.revision, recordedAt: '2026-09-20T10:00:00Z', actorId: userId, note: null });
	expect(countDifference(result[0].counted, result[0].expected)).toBe('0');
});


test('count detail limits batches and actors and fetches narrow search/history products through capped pages', async () => {
	for (const finished of [false, true]) {
		const requests: URL[] = [];
		const result = await readCountDetail(session, batchId, userId, {
			productId: finished ? requestId : undefined,
			fetcher: async input => {
				const url = new URL(String(input)); requests.push(url);
				const view = url.pathname.split('/').at(-1);
				if (view === 'amp_count_batches') {
					expect(url.searchParams.get('id')).toBe(`eq.${batchId}`);
					return Response.json([{ id: batchId, owner_id: userId, title: 'One batch', started_at: '2026-09-20T10:00:00Z',
						finished_at: finished ? '2026-09-20T11:00:00Z' : null, finished_by: finished ? userId : null, finish_reason: null }]);
				}
				if (view === 'amp_products') {
					expect(url.searchParams.get('select')).toBe('id,code,name_nb,name_en,unit_code,stock_step,bin_id,is_active');
					expect(url.searchParams.get('id')).toBe(finished ? `in.(${productId},${requestId})` : null);
					const after = url.searchParams.get('and')?.match(/id\.gt\.([a-f0-9-]+)/)?.[1] ?? '';
					const id = [productId, requestId].find(id => id > after);
					return Response.json(id ? [{ id, code: id === productId ? 'RES-12345' : 'CAP-12345', name_nb: 'Del', name_en: 'Part',
						unit_code: 'pcs', stock_step: '1', bin_id: null, is_active: false }] : []);
				}
				if (view === 'amp_staff_members') expect(url.searchParams.get('id')).toBe(`in.(${userId})`);
				if (view === 'amp_stock_counts') expect(url.searchParams.get('batch_id')).toBe(`eq.${batchId}`);
				if (view === 'amp_inventory_events') expect(url.searchParams.get('id')).toBe(`in.(${eventId})`);
				if (url.searchParams.has('and')) return Response.json([]);
				if (view === 'amp_staff_members') return Response.json([{ id: userId, auth_user_id: userId, display_name: 'Operator', is_active: true }]);
				if (view === 'amp_stock_counts') return Response.json([{ event_id: eventId, batch_id: batchId, product_id: productId,
					expected_quantity: '5', counted_quantity: '6', expected_revision: '9007199254740993' }]);
				if (view === 'amp_inventory_events') return Response.json([{ id: eventId, kind: 'count', recorded_at: '2026-09-20T10:00:00Z', actor_id: userId, note: null }]);
				throw new Error(`Unexpected detail read: ${view}`);
			}
		});
		expect(result.batch?.id).toBe(batchId);
		expect(result.owners.map(owner => owner.id)).toEqual([userId]);
		expect(result.products.map(product => product.id)).toEqual([productId, requestId]);
		expect(result.observations[0].revision).toBe('9007199254740993');
		expect(requests.filter(url => url.pathname.endsWith('amp_count_batches'))).toHaveLength(1);
		expect(requests.filter(url => url.pathname.endsWith('amp_products'))).toHaveLength(3);
	}
});
