import { expect, test } from 'bun:test';
import { receiptAddress, sendReceipt } from './receipt-email';
import type { CheckoutSnapshot } from '../checkout-contract';

const snapshot: CheckoutSnapshot = {
	checkout_id: '87654321-1234-4123-8123-123456789abc', created_at: '2026-09-20T12:00:00+00:00', status: 'confirmed',
	confirmed_at: '2026-09-20T12:01:00+00:00', total_nok: '1234.5', payment_required: true, registration_method: 'buyer',
	contact_text: null,
	items: [{ product_id: '11111111-1234-4123-8123-123456789abc', code: 'RES-A1234', name_nb: '<b>Motstand</b>', name_en: 'Resistor',
		unit: 'pcs', quantity: '2', unit_price_nok: '617.25', line_total_nok: '1234.5' }]
};
const config = { resendApiKey: 're_test', origin: 'https://shop.test', limit: { limit: async () => ({ success: true }) } };

test('receipt addresses, escaping, formatting and per-address idempotency', async () => {
	expect(receiptAddress(' a@b.no ')).toBe('a@b.no');
	for (const bad of ['98765432', 'ring meg a@b.no', null, 42, `${'a'.repeat(250)}@b.no`]) expect(receiptAddress(bad)).toBeNull();
	const calls: RequestInit[] = [];
	const fetcher = (async (_url: string, init: RequestInit) => { calls.push(init); return new Response('{}'); }) as unknown as typeof fetch;
	expect(await sendReceipt(snapshot, 'Buyer@example.test', config, fetcher)).toBe(true);
	expect(await sendReceipt(snapshot, 'buyer@example.test', config, fetcher)).toBe(true);
	expect(await sendReceipt(snapshot, 'other@example.test', config, fetcher)).toBe(true);
	const keys = calls.map((init) => (init.headers as Record<string, string>)['Idempotency-Key']);
	expect(keys[0]).toBe(keys[1]);
	expect(keys[2]).not.toBe(keys[0]);
	expect(keys[0]).toStartWith(`receipt/${snapshot.checkout_id}/`);
	const html = JSON.parse(String(calls[0].body)).html as string;
	expect(html).toContain('&#60;b&#62;Motstand');
	expect(html).toContain('1 234,50 kr');
	expect(html).toContain('1,234.50 NOK');
	expect(html).toContain('https://shop.test/brand/wordmark-email.png');
	expect(html).toContain('href="https://shop.test/p/RES-A1234"');
	expect(html).toContain('href="https://shop.test/en/p/RES-A1234"');
	expect(html).toContain('Hjelpereferanse: <span');
	expect(html).toContain('Support reference: <span');
	expect(html).toContain(`>${snapshot.checkout_id}</span>`);
	expect(html).toContain('href="https://shop.test/help"');
	expect(html).toContain('href="https://shop.test/en/help"');
	expect(html).toContain('Ampoteket, Pilestredet 35, Oslo');
	const body = JSON.parse(String(calls[0].body)) as { subject: string; text: string };
	expect(body.subject).toBe('Kvittering fra Ampoteket / Receipt from Ampoteket');
	expect(body.text).toContain('- <b>Motstand</b> (RES-A1234): 2 stk, ');
	expect(body.text).toContain('Hjelpereferanse: 87654321-1234-4123-8123-123456789abc');
	expect(body.text).toContain('Support reference: 87654321-1234-4123-8123-123456789abc');
	expect(body.text).toContain('Help with your purchase: https://shop.test/en/help');
	expect(await sendReceipt(snapshot, 'a@b.no', config, (async () => new Response('{}', { status: 422 })) as unknown as typeof fetch)).toBe(false);
	expect(await sendReceipt(snapshot, 'a@b.no', config, (() => Promise.reject(new Error('down'))) as unknown as typeof fetch)).toBe(false);
});
