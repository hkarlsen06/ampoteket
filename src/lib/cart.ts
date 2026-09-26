import { getContext, setContext } from 'svelte';
import { writable, type Readable } from 'svelte/store';
import { isRecord } from './api';
import type { CatalogProduct } from './catalog';
import { addDecimals, validQuantity } from './decimal';
import type { Locale } from './i18n';

export const CART_KEY = 'ampoteket:cart';
export const CART_LOCK = 'ampoteket:cart-and-checkout:v1';
/** Tells other tabs to reload the cart; focus/storage refresh covers any failure here. */
export function notifyCartChanged() {
	try {
		const channel = new BroadcastChannel(CART_LOCK);
		try { channel.postMessage('changed'); } finally { channel.close(); }
	} catch { /* Not durable state. */ }
}
export const CHECKOUT_DATABASE = 'ampoteket:checkout';
export const CHECKOUT_STORE = 'attempts';
export const ACTIVE_ATTEMPT_KEY = 'active';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const requestUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type CartLine = {
	product_id: string;
	quantity: string;
	/** Saved hints never establish present availability, price or sale step. */
	code?: string;
	name_nb?: string;
	name_en?: string;
	unit_symbol?: string;
};
export type ActiveAttempt = {
	requestId: string;
	fingerprint: string;
	version: 1;
	createdAt: string;
	state: 'preparing' | 'prepared' | 'confirming' | 'registered';
	checkoutId?: string;
	/** Non-sensitive original lines let registration preserve a newer basket. */
	cartLines?: { product_id: string; quantity: string }[];
	setAside?: boolean;
};
export type CartState = {
	status: 'initializing' | 'ready' | 'invalid' | 'unavailable';
	lines: CartLine[];
	activeAttempt: ActiveAttempt | null;
};
export type CartErrorCode = 'storage' | 'invalid' | 'locked' | 'quantity' | 'limit' | 'changed';
export class CartError extends Error {
	constructor(readonly code: CartErrorCode) { super(`Cart ${code}`); this.name = 'CartError'; }
}

export function parseCart(raw: string | null): CartLine[] {
	if (raw === null) return [];
	let value: unknown;
	try { value = JSON.parse(raw); } catch { throw new CartError('invalid'); }
	if (!Array.isArray(value) || value.length > 200) throw new CartError('invalid');
	const ids = new Set<string>();
	return value.map((item: unknown) => {
		if (!item || typeof item !== 'object' || Array.isArray(item)) throw new CartError('invalid');
		const row = item as Record<string, unknown>;
		if (typeof row.product_id !== 'string' || !uuid.test(row.product_id) || ids.has(row.product_id)
			|| typeof row.quantity !== 'string' || !/^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(row.quantity)) throw new CartError('invalid');
		try { validQuantity(row.quantity, '0.000001'); } catch { throw new CartError('invalid'); }
		ids.add(row.product_id);
		const line: CartLine = { product_id: row.product_id, quantity: row.quantity };
		for (const key of ['code', 'name_nb', 'name_en', 'unit_symbol'] as const) {
			if (row[key] !== undefined) {
				if (typeof row[key] !== 'string' || row[key].length > 1000) throw new CartError('invalid');
				line[key] = row[key];
			}
		}
		if (line.code !== undefined && !/^[A-Z0-9][A-Z0-9-]{0,39}$/.test(line.code)) throw new CartError('invalid');
		return line;
	});
}

export function parseActiveAttempt(value: unknown): ActiveAttempt | null {
	if (value === undefined || value === null) return null;
	if (!isRecord(value)) throw new CartError('storage');
	const item = value;
	if (typeof item.requestId !== 'string' || !requestUuid.test(item.requestId)
		|| typeof item.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(item.fingerprint)
		|| item.version !== 1 || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))
		|| !['preparing', 'prepared', 'confirming', 'registered'].includes(item.state as string)
		|| (item.checkoutId !== undefined && (typeof item.checkoutId !== 'string' || !uuid.test(item.checkoutId)))
		|| (item.state !== 'preparing' && item.checkoutId === undefined)) throw new CartError('storage');
	if (item.cartLines !== undefined && parseCart(JSON.stringify(item.cartLines)).length === 0) throw new CartError('storage');
	if (item.setAside !== undefined && typeof item.setAside !== 'boolean') throw new CartError('storage');
	return item as ActiveAttempt;
}

/** Checkout transitions take this same Web Lock before their IDB transaction.
 * No network request belongs inside this callback. */
export function withCartLock<T>(operation: () => Promise<T>): Promise<T> {
	if (!globalThis.navigator?.locks) return Promise.reject(new CartError('storage'));
	return navigator.locks.request(CART_LOCK, operation);
}

/** Close every connection so another tab can upgrade the database without being blocked. */
export function openCheckoutDatabase(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		let blocked = false;
		let request: IDBOpenDBRequest;
		try { request = indexedDB.open(CHECKOUT_DATABASE, 1); } catch { reject(new CartError('storage')); return; }
		request.onupgradeneeded = () => request.result.createObjectStore(CHECKOUT_STORE);
		request.onerror = () => reject(new CartError('storage'));
		request.onblocked = () => { blocked = true; reject(new CartError('storage')); };
		request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
	});
}

export async function readActiveAttempt(): Promise<ActiveAttempt | null> {
	const database = await openCheckoutDatabase();
	try {
		return await new Promise<ActiveAttempt | null>((resolve, reject) => {
			// A write/read-back probe establishes that IDB is writable before cart actions.
			const transaction = database.transaction(CHECKOUT_STORE, 'readwrite');
			const store = transaction.objectStore(CHECKOUT_STORE);
			store.put(1, 'storage-probe');
			const probe = store.get('storage-probe');
			const request = store.get(ACTIVE_ATTEMPT_KEY);
			store.delete('storage-probe');
			transaction.oncomplete = () => {
				try {
					if (probe.result !== 1) throw new CartError('storage');
					resolve(parseActiveAttempt(request.result));
				} catch { reject(new CartError('storage')); }
			};
			transaction.onabort = transaction.onerror = () => reject(new CartError('storage'));
		});
	} finally { database.close(); }
}

/** Injected only in focused tests; browser setup touches no storage during SSR. */
export type CartEnvironment = {
	read(): string | null;
	write(value: string): void;
	readAttempt(): Promise<ActiveAttempt | null>;
	lock<T>(operation: () => Promise<T>): Promise<T>;
	listen(refresh: () => void): () => void;
	notify(): void;
	probe?(): void;
};
function browserEnvironment(): CartEnvironment {
	return {
		probe() {
			const key = 'ampoteket:storage-probe';
			localStorage.setItem(key, '1');
			if (localStorage.getItem(key) !== '1') throw new CartError('storage');
			localStorage.removeItem(key);
		},
		read: () => localStorage.getItem(CART_KEY),
		write: (value) => localStorage.setItem(CART_KEY, value),
		readAttempt: readActiveAttempt,
		lock: withCartLock,
		listen(refresh) {
			const storage = (event: StorageEvent) => { if (event.key === CART_KEY || event.key === null) refresh(); };
			const visibility = () => { if (document.visibilityState === 'visible') refresh(); };
			window.addEventListener('storage', storage);
			window.addEventListener('focus', refresh);
			document.addEventListener('visibilitychange', visibility);
			let channel: BroadcastChannel | null = null;
			try {
				if (typeof BroadcastChannel === 'function') {
					channel = new BroadcastChannel(CART_LOCK);
					channel.addEventListener('message', refresh);
				}
			} catch { /* Optional notifications; storage/focus listeners still refresh the cart. */ }
			return () => {
				try { channel?.close(); } catch { /* No persisted state depends on this channel. */ }
				window.removeEventListener('storage', storage);
				window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', visibility);
			};
		},
		notify: notifyCartChanged
	};
}

export type CartStore = Readable<CartState> & {
	start(): () => void;
	refresh(): Promise<void>;
	add(product: CatalogProduct, quantity: string, locale?: Locale): Promise<void>;
	setQuantity(productId: string, quantity: string, saleStep: string, locale?: Locale, expectedQuantity?: string): Promise<void>;
	remove(productId: string, expectedQuantity?: string): Promise<void>;
	resetInvalid(): Promise<void>;
};

export function createCartStore(environment?: CartEnvironment): CartStore {
	const env = environment ?? browserEnvironment();
	let state: CartState = { status: 'initializing', lines: [], activeAttempt: null };
	const store = writable<CartState>(state);
	const publish = (next: CartState) => { state = next; store.set(next); };
	const failure = (error: unknown) => {
		publish({ ...state, status: error instanceof CartError && error.code === 'invalid' ? 'invalid' : 'unavailable' });
	};
	async function readLatest(): Promise<CartState> {
		env.probe?.();
		// Read the pointer even if the cart is malformed, so recovery keeps its reference.
		const activeAttempt = await env.readAttempt();
		publish({ ...state, activeAttempt });
		return { status: 'ready', lines: parseCart(env.read()), activeAttempt };
	}
	async function refresh(): Promise<void> {
		try { await env.lock(async () => { publish(await readLatest()); }); } catch (error) { failure(error); }
	}
	async function mutate(change: (lines: CartLine[]) => CartLine[], reset = false): Promise<void> {
		try {
			await env.lock(async () => {
				const activeAttempt = await env.readAttempt();
				publish({ ...state, activeAttempt });
				if (activeAttempt) throw new CartError('locked');
				const raw = env.read();
				if (reset) {
					let malformed = false;
					try { parseCart(raw); } catch (error) { malformed = error instanceof CartError && error.code === 'invalid'; }
					if (!malformed) throw new CartError('changed');
				}
				const lines = reset ? [] : parseCart(raw);
				// Publish the current shared contents even if a stale edit is then rejected.
				if (!reset) publish({ status: 'ready', lines, activeAttempt });
				const next = change(lines);
				if (next.length > 200) throw new CartError('limit');
				const serialized = JSON.stringify(next);
				env.write(serialized);
				if (env.read() !== serialized) throw new CartError('storage');
				publish({ status: 'ready', lines: next, activeAttempt: null });
			});
		} catch (error) {
			if (!(error instanceof CartError) || error.code === 'storage' || error.code === 'invalid') failure(error);
			throw error instanceof CartError ? error : new CartError('storage');
		}
		// A notification failure cannot turn a verified write into a failed action:
		// asking the buyer to retry an already-saved addition could double it.
		try { env.notify(); } catch { /* Other tabs also refresh on storage/focus. */ }
	}
	function quantity(input: string, step: string, locale?: Locale): string {
		try { return validQuantity(input, step, locale); } catch { throw new CartError('quantity'); }
	}
	return {
		subscribe: store.subscribe,
		start() {
			try { const stop = env.listen(() => { void refresh(); }); void refresh(); return stop; }
			catch (error) { failure(error); return () => {}; }
		},
		refresh,
		add(product, input, locale) {
			return mutate((lines) => {
				const amount = quantity(input, product.sale_step, locale);
				const index = lines.findIndex((line) => line.product_id === product.product_id);
				const next = index < 0 ? amount : quantity(addDecimals(lines[index].quantity, amount), product.sale_step);
				const line: CartLine = { product_id: product.product_id, quantity: next, code: product.code, name_nb: product.name_nb, name_en: product.name_en, unit_symbol: product.unit_symbol };
				return index < 0 ? [...lines, line] : lines.map((current, i) => i === index ? line : current);
			});
		},
		setQuantity(productId, input, saleStep, locale, expectedQuantity) {
			return mutate((lines) => {
				const current = lines.find((line) => line.product_id === productId);
				if (!current || (expectedQuantity !== undefined && current.quantity !== expectedQuantity)) throw new CartError('changed');
				return lines.map((line) => line.product_id === productId ? { ...line, quantity: quantity(input, saleStep, locale) } : line);
			});
		},
		remove(productId, expectedQuantity) {
			return mutate((lines) => {
				const current = lines.find((line) => line.product_id === productId);
				if (!current || (expectedQuantity !== undefined && current.quantity !== expectedQuantity)) throw new CartError('changed');
				return lines.filter((line) => line.product_id !== productId);
			});
		},
		resetInvalid: () => mutate(() => [], true)
	};
}

const CONTEXT = Symbol('ampoteket:cart');
export const setCartContext = (store: CartStore): CartStore => setContext(CONTEXT, store);
export function getCartContext(): CartStore {
	const store = getContext<CartStore | undefined>(CONTEXT);
	if (!store) throw new Error('Cart context is missing');
	return store;
}
