import { expect, test } from 'bun:test';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { memory } from './test-storage';
import { rejection, type ConvexCaller } from './convex';
import { clearCountCommand, countBatchAccess, countCommandPath, countDifference, countRejection, formatSignedDifference, countStorageKey, readCountCommand, readCountInventory, runCountCommand, saveCountCommand, validCountQuantity, type CountBatch, type CountCommand } from './admin-counts';

const userId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const batchId = '33333333-3333-4333-8333-333333333333';
const eventId = '44444444-4444-4444-8444-444444444444';
const requestId = '55555555-5555-4555-8555-555555555555';
const command: CountCommand = { kind: 'count', userId, requestId, productId, batchId: null, revision: '9007199254740993', expected: '1999999999998.999999', quantity: '1999999999998.999999', note: 'Bin paused and checked' };

/** A Convex client stub answering by function name (`stock:recordCount`). */
function stub(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
	const calls: { name: string; args: Record<string, unknown> }[] = [];
	const run = async (fn: FunctionReference<'query' | 'mutation' | 'action'>, args: Record<string, unknown>) => {
		const name = getFunctionName(fn); calls.push({ name, args });
		if (!handlers[name]) throw new Error(`Unexpected ${name}`);
		return handlers[name](args);
	};
	return { session: { client: { query: run, mutation: run, action: run } as unknown as ConvexCaller, userId }, calls };
}

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

test('single count retries send identical lossless arguments and retain zero-difference success', async () => {
	const { session, calls } = stub({ 'stock:recordSingleCount': () => ({ batch_id: batchId, event_id: eventId, quantity: command.quantity, difference: '0' }) });
	const result = await runCountCommand(session, command);
	expect(result).toEqual({ batchId, eventId, quantity: command.quantity, difference: '0' });
	expect(await runCountCommand(session, command)).toEqual(result);
	expect(calls[0]).toEqual({ name: 'stock:recordSingleCount', args: { requestId, productId, expectedRevision: command.revision, counted: command.quantity, note: command.note } });
	expect(calls[1]).toEqual(calls[0]);
	await expect(runCountCommand({ ...session, userId: eventId }, command)).rejects.toThrow('identity');
	expect(calls).toHaveLength(2);
	const changed = stub({ 'stock:recordSingleCount': () => ({ batch_id: batchId, event_id: eventId, quantity: '0', difference: '0' }) });
	await expect(runCountCommand(changed.session, command)).rejects.toThrow();
});

test('batch counts, start and both closing operations keep their original identities', async () => {
	const { session, calls } = stub({
		'stock:recordCount': () => ({ batch_id: batchId, event_id: eventId, quantity: command.quantity, difference: '0' }),
		'stock:startCountBatch': () => ({ batch_id: batchId }),
		'stock:finishCountBatch': () => ({ batch_id: batchId, finished: true }),
		'stock:closeAbandonedCountBatch': () => ({ batch_id: batchId, finished: true })
	});
	await runCountCommand(session, { ...command, batchId });
	expect((await runCountCommand(session, { kind: 'start', userId, requestId, title: 'Lower drawers' })).batchId).toBe(batchId);
	await runCountCommand(session, { kind: 'finish', userId, requestId, batchId });
	await runCountCommand(session, { kind: 'close', userId, requestId, batchId, reason: 'Owner left the workshop' });
	expect(calls.map((call) => call.args)).toEqual([
		{ requestId, batchId, productId, expectedRevision: command.revision, counted: command.quantity, note: command.note },
		{ requestId, title: 'Lower drawers' },
		{ batchId },
		{ requestId, batchId, reason: 'Owner left the workshop' }
	]);
	await expect(runCountCommand(session, { kind: 'finish', userId, requestId, batchId: eventId })).rejects.toThrow('closure');
});

test('inventory turns the revision into a string and refuses a mismatched product', async () => {
	const { session, calls } = stub({ 'stock:inventory': (args) => (args.productIds as string[]).map((id) => ({ product_id: id === batchId ? productId : id, quantity: command.quantity, revision: 41, last_counted_at: null })) });
	expect(await readCountInventory(session, productId)).toEqual({ productId, quantity: command.quantity, revision: '41', lastCountedAt: null });
	expect(calls[0].args).toEqual({ productIds: [productId] });
	await expect(readCountInventory(session, batchId)).rejects.toThrow('unavailable');
});

test('only explicit rolled-back count rejections allow a fresh observation', () => {
	expect(countRejection(rejection('STALE_STOCK_COUNT'))).toBe('stale');
	expect(countRejection(rejection('COUNT_BATCH_FINISHED'))).toBe('closed');
	expect(countRejection(rejection('COUNT_BATCH_OWNER_STILL_ACTIVE'))).toBe('owner');
	expect(countRejection(rejection('PRODUCT_NOT_FOUND', `PRODUCT_NOT_FOUND: ${productId}`))).toBe('invalid');
	for (const error of [new Error('Timeout'), new TypeError('Failed to fetch'), rejection('STAFF_REQUIRED'), rejection('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT')]) expect(countRejection(error)).toBeNull();
});

test('ownership permits abandoned closure only when eligible', () => {
	const batch: CountBatch = { id: batchId, ownerId: userId, title: 'A1', productId: null, startedAt: '2026-09-20T10:00:00Z', finishedAt: null, finishedBy: null, finishReason: null };
	const owner = { id: userId, name: 'First admin', active: true, authUserId: userId };
	expect(countBatchAccess(batch, owner, userId)).toBe('owner');
	expect(countBatchAccess(batch, owner, productId)).toBe('other');
	expect(countBatchAccess(batch, { ...owner, active: false }, productId)).toBe('abandoned');
	expect(countBatchAccess(batch, { ...owner, authUserId: null }, productId)).toBe('abandoned');
	expect(countBatchAccess({ ...batch, finishedAt: '2026-09-20T11:00:00Z', finishedBy: userId }, owner, userId)).toBe('finished');
	expect(countBatchAccess(batch, undefined, productId)).toBe('other');
	expect(() => countBatchAccess(batch, { ...owner, id: productId }, userId)).toThrow('binding');
});

test('a difference carries an explicit sign in both locales', () => {
	expect(formatSignedDifference('2', 'nb')).toBe('+2');
	expect(formatSignedDifference('-1500.5', 'en')).toBe('-1,500.5');
	expect(formatSignedDifference('0', 'nb')).toBe('0');
});
