import { describe, expect, test } from 'bun:test';
import { get } from 'svelte/store';
import { createCartStore, parseCart, parseActiveAttempt, CartError, type ActiveAttempt, type CartEnvironment } from './cart';
import type { CatalogProduct } from './catalog';

const id = '10000000-0000-4000-8000-000000000001';
const product = { product_id: id, code: 'RES-A0001', name_nb: 'Testmotstand', name_en: 'Test resistor', unit_symbol: 'pcs', sale_step: '0.25' } as CatalogProduct;
const attempt: ActiveAttempt = {
	requestId: '20000000-0000-4000-8000-000000000001', fingerprint: 'a'.repeat(64), version: 1,
	createdAt: '2026-09-19T12:00:00.000Z', state: 'preparing'
};

function environment(raw: string | null = null) {
	const saved = { raw, active: null as ActiveAttempt | null, writeFails: false, writeIgnored: false, idbFails: false };
	let queue: Promise<unknown> = Promise.resolve();
	const env: CartEnvironment = {
		read: () => saved.raw,
		write(value) { if (saved.writeFails) throw new Error('Denied storage'); if (!saved.writeIgnored) saved.raw = value; },
		async readAttempt() { if (saved.idbFails) throw new Error('Denied IDB'); return saved.active; },
		lock<T>(operation: () => Promise<T>) {
			const next = queue.then(operation); queue = next.catch(() => {}); return next;
		},
		listen: () => () => {}, notify() {}
	};
	return { saved, env };
}

describe('browser cart persistence boundary', () => {
	test('validates old minimal lines without rounding and rejects corrupt data without treating it as empty', () => {
		expect(parseCart(JSON.stringify([{ product_id: id, quantity: '999999999998.999999' }]))[0].quantity).toBe('999999999998.999999');
		for (const raw of ['{', '{}', 'null', JSON.stringify([{ product_id: id, quantity: 1 }]), JSON.stringify([{ product_id: id, quantity: '0' }]), JSON.stringify([{ product_id: id, quantity: '0.0000001' }]), JSON.stringify([{ product_id: id, quantity: '1000000000000' }]), JSON.stringify([{ product_id: id, quantity: '1' }, { product_id: id, quantity: '1' }])]) {
			expect(() => parseCart(raw)).toThrow(CartError);
		}
	});

	test('two tabs merge concurrent additions from fresh persisted state', async () => {
		const { saved, env } = environment();
		const first = createCartStore(env), second = createCartStore(env);
		await Promise.all([first.refresh(), second.refresh()]);
		await Promise.all([first.add(product, '0.25'), second.add(product, '0,50', 'nb')]);
		expect(parseCart(saved.raw)).toEqual([{ product_id: id, quantity: '0.75', code: product.code, name_nb: product.name_nb, name_en: product.name_en, unit_symbol: 'pcs' }]);
		await first.refresh();
		expect(get(first).lines[0].quantity).toBe('0.75');
	});

	test('stale quantity edits and removals cannot silently replace another tab’s work', async () => {
		const { saved, env } = environment();
		const first = createCartStore(env), second = createCartStore(env);
		await first.add(product, '1');
		await second.refresh();
		await first.add(product, '0.25');
		await expect(second.setQuantity(id, '2', '0.25', 'en', '1')).rejects.toMatchObject({ code: 'changed' });
		await expect(second.remove(id, '1')).rejects.toMatchObject({ code: 'changed' });
		expect(parseCart(saved.raw)[0].quantity).toBe('1.25');
		expect(get(second).lines[0].quantity).toBe('1.25');
	});

	test('an overlapping active-attempt claim wins the common lock and freezes every mutation', async () => {
		const { saved, env } = environment();
		const cart = createCartStore(env);
		await cart.add(product, '1');
		const original = saved.raw;
		const claim = env.lock(async () => { saved.active = attempt; });
		await expect(cart.add(product, '1')).rejects.toMatchObject({ code: 'locked' });
		await claim;
		await expect(cart.setQuantity(id, '2', '0.25')).rejects.toMatchObject({ code: 'locked' });
		await expect(cart.remove(id)).rejects.toMatchObject({ code: 'locked' });
		await expect(cart.resetInvalid()).rejects.toMatchObject({ code: 'locked' });
		expect(saved.raw).toBe(original);
		expect(get(cart).activeAttempt?.requestId).toBe(attempt.requestId);
	});

	test('registered pointers stay locked until identity-checked checkout cleanup', async () => {
		const { saved, env } = environment();
		saved.active = { ...attempt, state: 'registered', checkoutId: id };
		await expect(createCartStore(env).add(product, '1')).rejects.toMatchObject({ code: 'locked' });
		expect(() => parseActiveAttempt({ ...attempt, state: 'prepared' })).toThrow(CartError);
		expect(() => parseActiveAttempt({ ...attempt, fingerprint: 'invalid' })).toThrow(CartError);
	});

	test('write denial and read-back mismatch never report success or publish optimistic quantities', async () => {
		for (const mode of ['writeFails', 'writeIgnored'] as const) {
			const { saved, env } = environment();
			const cart = createCartStore(env);
			await cart.add(product, '1');
			saved[mode] = true;
			await expect(cart.add(product, '1')).rejects.toMatchObject({ code: 'storage' });
			expect(get(cart).status).toBe('unavailable');
			expect(get(cart).lines[0].quantity).toBe('1');
		}
	});

	test('unavailable IDB disables storage even when localStorage could work', async () => {
		const { saved, env } = environment();
		saved.idbFails = true;
		const cart = createCartStore(env);
		await cart.refresh();
		expect(get(cart).status).toBe('unavailable');
		await expect(cart.add(product, '1')).rejects.toMatchObject({ code: 'storage' });
		expect(saved.raw).toBe(null);
	});

	test('notification failure after verified persistence still reports one successful addition', async () => {
		const { saved, env } = environment();
		env.notify = () => { throw new DOMException('BroadcastChannel unavailable', 'SecurityError'); };
		const cart = createCartStore(env);
		await expect(cart.add(product, '0.25')).resolves.toBeUndefined();
		expect(get(cart).status).toBe('ready');
		expect(get(cart).lines[0].quantity).toBe('0.25');
		expect(parseCart(saved.raw)[0].quantity).toBe('0.25');
		await cart.refresh();
		expect(get(cart).lines[0].quantity).toBe('0.25');
	});

	test('keeps malformed data and known checkout references; explicit reset rechecks shared state', async () => {
		const { saved, env } = environment('invalid');
		const cart = createCartStore(env);
		saved.active = attempt;
		await cart.refresh();
		expect(get(cart).status).toBe('invalid');
		expect(get(cart).activeAttempt?.requestId).toBe(attempt.requestId);
		expect(saved.raw).toBe('invalid');
		saved.active = null;
		await cart.resetInvalid();
		expect(saved.raw).toBe('[]');
		await cart.add(product, '1');
		await expect(cart.resetInvalid()).rejects.toMatchObject({ code: 'changed' });
		expect(parseCart(saved.raw)[0].quantity).toBe('1');
	});

	test('validates combined exact quantities and prevents the 201st distinct line', async () => {
		const { saved, env } = environment();
		const cart = createCartStore(env);
		await cart.add(product, '999999999998.75');
		await cart.add(product, '0.25');
		await expect(cart.add(product, '0.25')).rejects.toMatchObject({ code: 'quantity' });
		expect(parseCart(saved.raw)[0].quantity).toBe('999999999999');
		saved.raw = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ product_id: `30000000-0000-4000-8000-${String(i).padStart(12, '0')}`, quantity: '1' })));
		await expect(cart.add(product, '1')).rejects.toMatchObject({ code: 'limit' });
		expect(parseCart(saved.raw)).toHaveLength(200);
	});
});
