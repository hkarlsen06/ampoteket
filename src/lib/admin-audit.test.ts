import { expect, test } from 'bun:test';
import { readAuditPage, readAuditUpdates } from './admin-audit';

const session = { config: { url: 'https://fixture.invalid', publishableKey: 'sb_publishable_fixture' }, token: 'staff-jwt', userId: '11111111-1111-4111-8111-111111111111' };
const entry = (id: string) => ({ id, table_name: 'products', row_key: { id: session.userId }, action: 'UPDATE', before_data: { sale_unit_price_nok: '9007199254740993.123456' }, after_data: { sale_unit_price_nok: '9007199254740994.123456' }, actor_id: session.userId, database_role: 'authenticated', recorded_at: '2026-09-23T10:00:00Z' });

test('audit refresh reads every new entry across capped pages without repeating the visible head', async () => {
	const newest = 9007199254740994n;
	const fetcher = async (input: RequestInfo | URL) => {
		const url = new URL(String(input));
		const cursor = BigInt(url.searchParams.get('id')?.slice(3) ?? String(newest + 46n));
		const count = Math.min(Number(url.searchParams.get('limit')), 7);
		return new Response(JSON.stringify(Array.from({ length: count }, (_, index) => entry(String(cursor - BigInt(index + 1))))));
	};
	const updates = await readAuditUpdates(session, String(newest), fetcher);
	expect(updates.map(row => row.id)).toEqual(Array.from({ length: 45 }, (_, index) => String(newest + 45n - BigInt(index))));
	expect(await readAuditUpdates(session, String(newest + 45n), fetcher)).toEqual([]);
});

test('audit paging retains exact nested values and fills capped responses without skipping an ID', async () => {
	const calls: string[] = [];
	const fetcher = async (input: RequestInfo | URL) => {
		const url = new URL(String(input));
		calls.push(url.searchParams.get('id') ?? '');
		const cursor = url.searchParams.get('id')?.slice(3) ?? '9007199254741024';
		const count = Math.min(Number(url.searchParams.get('limit')), 7);
		const rows = Array.from({ length: count }, (_, index) => entry((BigInt(cursor) - BigInt(index + 1)).toString()));
		return new Response(JSON.stringify(rows).replaceAll('"9007199254740993.123456"', '9007199254740993.123456'));
	};
	const first = await readAuditPage(session, null, fetcher);
	expect(first.entries).toHaveLength(30);
	expect(first.more).toBe(true);
	expect(first.entries[0].before?.sale_unit_price_nok).toBe('9007199254740993.123456');
	expect(first.entries.at(-1)?.id).toBe('9007199254740994');
	expect(calls.length).toBeGreaterThan(4);
	let read = false;
	const next = await readAuditPage(session, first.entries.at(-1)!.id, async (input) => {
		const url = new URL(String(input));
		if (!read) expect(url.searchParams.get('id')).toBe('lt.9007199254740994');
		read = true;
		return new Response(JSON.stringify(read && url.searchParams.get('id') === 'lt.9007199254740994' ? [entry('9007199254740993')] : []));
	});
	expect(next.entries[0].id).toBe('9007199254740993');
});
