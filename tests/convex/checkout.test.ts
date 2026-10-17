// Guest checkout, registration, recovery and contact erasure (datamodell.md §7).
import { beforeEach, describe, expect, test } from 'bun:test';
import { api } from '../../convex/_generated/api';
import { enabled, freshDeployment, guest, internal, product, rejected, serverKey, staff, uuid } from './harness';

const token = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');

describe.skipIf(!enabled)('checkout', () => {
	beforeEach(freshDeployment);

	test('only the Worker key may prepare, read or confirm', async () => {
		const { client } = await staff();
		const p = await product(client);
		expect(await rejected(guest().mutation(api.checkout.prepare, { serverKey: 'x'.repeat(40), requestId: uuid(), token: token(), contact: null,
			items: [{ productId: p.id, quantity: '1' }] }))).toBe('CHECKOUT_SERVER_REQUIRED');
	});

	test('prepare freezes names and prices; confirm registers once and rounds each line', async () => {
		const { client } = await staff();
		const p = await product(client, { sale_unit_price_nok: '0.333333' });
		const secret = token(), requestId = uuid();
		const args = { serverKey, requestId, token: secret, contact: '  @buyer  ', items: [{ productId: p.id, quantity: '3' }] };
		const { checkout_id } = await guest().mutation(api.checkout.prepare, args);
		expect((await guest().mutation(api.checkout.prepare, args)).checkout_id).toBe(checkout_id);
		// Later price changes never touch the saved checkout.
		const current = await client.query(api.products.get, { id: p.id });
		const { metadata_revision, created_at, ...payload } = current!;
		await client.mutation(api.products.save, { revision: metadata_revision, payload: { ...payload, sale_unit_price_nok: '99' } });
		const before = await guest().query(api.checkout.get, { serverKey, checkoutId: checkout_id, token: secret });
		expect(before).toMatchObject({ status: 'unconfirmed', total_nok: '1.00', payment_required: true, contact_text: '@buyer', registration_method: null });
		expect(before.items[0]).toMatchObject({ unit_price_nok: '0.333333', line_total_nok: '1.00' });
		expect(await rejected(guest().query(api.checkout.get, { serverKey, checkoutId: checkout_id, token: token() }))).toBe('CHECKOUT_NOT_FOUND_OR_NOT_AUTHORISED');
		const confirmed = await guest().mutation(api.checkout.confirm, { serverKey, checkoutId: checkout_id, token: secret });
		const again = await guest().mutation(api.checkout.confirm, { serverKey, checkoutId: checkout_id, token: secret });
		expect(confirmed).toMatchObject({ status: 'confirmed', registration_method: 'buyer' });
		expect(again.confirmed_at).toBe(confirmed.confirmed_at);
		expect((await client.query(api.stock.inventory, { productIds: [p.id] }))[0].quantity).toBe('-3');
	});

	test('inactive and borrow-only products are not for sale; steps and duplicates are checked', async () => {
		const { client } = await staff();
		const inactive = await product(client, { is_active: false });
		const borrowed = await product(client, { sale_unit_price_nok: null });
		const cable = await product(client, { unit_code: 'm', stock_step: '0.001', sale_step: '0.5' });
		const prepare = (items: { productId: string; quantity: string }[]) =>
			guest().mutation(api.checkout.prepare, { serverKey, requestId: uuid(), token: token(), contact: null, items });
		expect(await rejected(prepare([{ productId: inactive.id, quantity: '1' }]))).toBe('PRODUCT_NOT_FOR_SALE');
		expect(await rejected(prepare([{ productId: borrowed.id, quantity: '1' }]))).toBe('PRODUCT_NOT_FOR_SALE');
		expect(await rejected(prepare([{ productId: cable.id, quantity: '0.3' }]))).toBe('INVALID_QUANTITY_STEP');
		expect(await rejected(prepare([{ productId: cable.id, quantity: '1' }, { productId: cable.id, quantity: '1' }]))).toBe('DUPLICATE_OR_MISSING_CART_PRODUCT');
	});

	test('staff recovery converges with a later buyer confirmation; contacts are erased without entering the audit', async () => {
		const { client } = await staff();
		const p = await product(client);
		const secret = token();
		const { checkout_id } = await guest().mutation(api.checkout.prepare, { serverKey, requestId: uuid(), token: secret, contact: 'buyer@example.no',
			items: [{ productId: p.id, quantity: '2' }] });
		const recovered = await client.mutation(api.checkout.recover, { requestId: uuid(), checkoutId: checkout_id, reason: 'Paid at the counter' });
		const confirmed = await guest().mutation(api.checkout.confirm, { serverKey, checkoutId: checkout_id, token: secret });
		expect(confirmed.registration_method).toBe('staff_recovery');
		expect((await client.query(api.checkout.staffLookup, { reference: checkout_id }))?.eventId).toBe(recovered.event_id);
		expect((await client.query(api.stock.inventory, { productIds: [p.id] }))[0].quantity).toBe('-2');
		expect(await client.query(api.checkout.staffContact, { checkoutId: checkout_id })).toBe('buyer@example.no');
		expect(await client.mutation(api.checkout.clearContact, { checkoutId: checkout_id })).toEqual({ checkout_id, contact_removed: true });
		expect(await client.mutation(api.checkout.clearContact, { checkoutId: checkout_id })).toEqual({ checkout_id, contact_removed: false });
		const page = await client.query(api.auditLog.page, {});
		const cleared = page.entries.filter((e) => e.table_name === 'checkout_contacts');
		expect(cleared).toHaveLength(1);
		expect(JSON.stringify(cleared)).not.toContain('buyer@example.no');
	});
});

describe.skipIf(!enabled)('contact retention', () => {
	beforeEach(freshDeployment);

	test('contacts on unconfirmed checkouts older than 90 days are cleared; confirmed and recent ones stay', async () => {
		const { client } = await staff();
		const p = await product(client);
		const make = async (contact: string) => {
			const secret = token();
			const { checkout_id } = await guest().mutation(api.checkout.prepare, { serverKey, requestId: uuid(), token: secret, contact, items: [{ productId: p.id, quantity: '1' }] });
			return { checkout_id, secret };
		};
		const old = await make('old@example.no'), oldConfirmed = await make('kept@example.no'), recent = await make('recent@example.no');
		await guest().mutation(api.checkout.confirm, { serverKey, checkoutId: oldConfirmed.checkout_id, token: oldConfirmed.secret });
		const longAgo = new Date(Date.now() - 91 * 86_400_000).toISOString().replace('Z', '000Z');
		for (const c of [old, oldConfirmed]) await internal('mutation', 'fixtures:patch', { table: 'checkouts', where: { id: c.checkout_id }, changes: { created_at: longAgo } });
		expect(await internal('mutation', 'retention:clearExpiredContacts')).toBe(1);
		expect(await client.query(api.checkout.staffContact, { checkoutId: old.checkout_id })).toBeNull();
		expect(await client.query(api.checkout.staffContact, { checkoutId: oldConfirmed.checkout_id })).toBe('kept@example.no');
		expect(await client.query(api.checkout.staffContact, { checkoutId: recent.checkout_id })).toBe('recent@example.no');
		expect(await internal('mutation', 'retention:clearExpiredContacts')).toBe(0);
	});
});
