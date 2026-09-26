import { ApiError, requestApiJson } from './api';
import {
	ACTIVE_ATTEMPT_KEY, CART_KEY, CHECKOUT_STORE, CartError, notifyCartChanged, openCheckoutDatabase,
	parseActiveAttempt, parseCart, readActiveAttempt, withCartLock, type ActiveAttempt, type CartLine
} from './cart';
import { parseCheckoutSnapshot, parsePrepareRequest, parsePrepareResponse, parseSessionResponse, type CheckoutSnapshot } from './checkout-contract';

export const PREPARE_PAYLOAD_PREFIX = 'ampoteket:prepare:';
export type CheckoutErrorCode = 'storage' | 'missing' | 'credentials' | 'payload' | 'unavailable' | 'conflict' | 'empty' | 'contact' | 'rejected';
export class CheckoutError extends Error {
	constructor(readonly code: CheckoutErrorCode) { super(`Checkout ${code}`); this.name = 'CheckoutError'; }
}
export function checkoutErrorCode(error: unknown): CheckoutErrorCode {
	if (error instanceof CheckoutError) return error.code;
	if (error instanceof CartError) return 'storage';
	if (error instanceof ApiError && error.body && typeof error.body === 'object') {
		const code = (error.body as { error?: unknown }).error;
		if (typeof code === 'string') {
			if (['CHECKOUT_SESSION_MISSING', 'CHECKOUT_SESSION_CHANGED', 'INVALID_CHECKOUT_SESSION', 'INVALID_CHECKOUT_ATTEMPT', 'CHECKOUT_NOT_FOUND_OR_NOT_AUTHORISED'].includes(code)) return 'credentials';
			if (['PRODUCT_NOT_FOUND', 'PRODUCT_NOT_FOR_SALE', 'INVALID_QUANTITY_STEP', 'POSITIVE_CART_QUANTITY_REQUIRED', 'INVALID_QUANTITY', 'INVALID_ITEMS', 'INVALID_CART', 'INVALID_CONTACT', 'INVALID_CHECKOUT_REQUEST', 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT'].includes(code)) return 'rejected';
		}
	}
	return 'unavailable';
}
const attemptKey = (requestId: string) => `attempt:${requestId}`;
const checkoutKey = (checkoutId: string) => `checkout:${checkoutId}`;
const payloadKey = (requestId: string) => PREPARE_PAYLOAD_PREFIX + requestId;
const binding = (attempt: ActiveAttempt) => ({ request_id: attempt.requestId, fingerprint: attempt.fingerprint });

/** No network work may be awaited inside this transaction or its shared Web Lock. */
async function transaction<T>(work: (store: IDBObjectStore, finish: (result: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
	const database = await openCheckoutDatabase();
	try {
		return await new Promise<T>((resolve, reject) => {
			const tx = database.transaction(CHECKOUT_STORE, 'readwrite');
			let result: T;
			let failure: unknown;
			const fail = (error: unknown) => { failure = error; tx.abort(); };
			tx.oncomplete = () => resolve(result);
			tx.onabort = tx.onerror = () => reject(failure ?? new CheckoutError('storage'));
			try { work(tx.objectStore(CHECKOUT_STORE), (value) => { result = value; }, fail); }
			catch (error) { fail(error); }
		});
	} finally { database.close(); }
}
function save(store: IDBObjectStore, attempt: ActiveAttempt, active: boolean) {
	store.put(attempt, attemptKey(attempt.requestId));
	if (attempt.checkoutId) store.put(attempt, checkoutKey(attempt.checkoutId));
	if (active) store.put(attempt, ACTIVE_ATTEMPT_KEY);
}
async function changeAttempt(attempt: ActiveAttempt, change: (current: ActiveAttempt, active: ActiveAttempt | null, store: IDBObjectStore) => ActiveAttempt, requireActive = true): Promise<ActiveAttempt> {
	return withCartLock(async () => transaction<ActiveAttempt>((store, finish, fail) => {
		const activeRead = store.get(ACTIVE_ATTEMPT_KEY);
		const savedRead = store.get(attemptKey(attempt.requestId));
		savedRead.onsuccess = () => {
			try {
				const active = parseActiveAttempt(activeRead.result);
				const current = parseActiveAttempt(savedRead.result) ?? (active?.requestId === attempt.requestId ? active : null);
				if (!current || current.fingerprint !== attempt.fingerprint || (attempt.checkoutId !== undefined && current.checkoutId !== attempt.checkoutId)) throw new CheckoutError('missing');
				if (requireActive && active?.requestId !== attempt.requestId) throw new CheckoutError('conflict');
				const next = change(current, active, store);
				finish(next);
			} catch (error) { fail(error); }
		};
	})).then((result) => { notifyCartChanged(); return result; });
}
export async function findCheckoutAttempt(checkoutId?: string): Promise<ActiveAttempt | null> {
	if (!checkoutId) return readActiveAttempt();
	return transaction((store, finish, fail) => {
		const read = store.get(checkoutKey(checkoutId));
		const active = store.get(ACTIVE_ATTEMPT_KEY);
		active.onsuccess = () => {
			try {
				const saved = parseActiveAttempt(read.result);
				const pointer = parseActiveAttempt(active.result);
				finish(saved ?? (pointer?.checkoutId === checkoutId ? pointer : null));
			} catch (error) { fail(error); }
		};
	});
}
async function post(path: string, body: unknown, exactBody?: string): Promise<unknown> {
	return requestApiJson(path, {
		method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', cache: 'no-store',
		body: exactBody ?? JSON.stringify(body)
	}, fetch, 25_000);
}
export function sameCart(lines: CartLine[], original: ActiveAttempt['cartLines']): boolean {
	return !!original && lines.length === original.length && lines.every((line, index) => line.product_id === original[index].product_id && line.quantity === original[index].quantity);
}

/** Explicit new-purchase action. Freeze the latest cart only after session initialization. */
export async function startCheckout(contact: string): Promise<ActiveAttempt> {
	const existing = await readActiveAttempt();
	if (existing) return existing;
	const normalizedContact = contact.trim() || null;
	if (normalizedContact && [...normalizedContact].length > 300) throw new CheckoutError('contact');
	const { fingerprint } = parseSessionResponse(await post('/api/checkouts/session', {}));
	const result = await withCartLock(async () => {
		const current = await readActiveAttempt();
		if (current) return current;
		let lines: CartLine[];
		try { lines = parseCart(localStorage.getItem(CART_KEY)); } catch { throw new CheckoutError('storage'); }
		if (!lines.length) throw new CheckoutError('empty');
		const cartLines = lines.map(({ product_id, quantity }) => ({ product_id, quantity }));
		const attempt: ActiveAttempt = { requestId: crypto.randomUUID(), fingerprint, version: 1, createdAt: new Date().toISOString(), state: 'preparing', cartLines };
		const exactPayload = JSON.stringify({ ...binding(attempt), items: cartLines, contact: normalizedContact });
		try {
			sessionStorage.setItem(payloadKey(attempt.requestId), exactPayload);
			if (sessionStorage.getItem(payloadKey(attempt.requestId)) !== exactPayload) throw new CheckoutError('storage');
		} catch { throw new CheckoutError('storage'); }
		return transaction<ActiveAttempt>((store, finish, fail) => {
			const read = store.get(ACTIVE_ATTEMPT_KEY);
			read.onsuccess = () => {
				try {
					const winner = parseActiveAttempt(read.result);
					if (winner) { sessionStorage.removeItem(payloadKey(attempt.requestId)); finish(winner); }
					else { save(store, attempt, true); finish(attempt); }
				} catch (error) { fail(error); }
			};
		});
	});
	notifyCartChanged(); return result;
}

export async function prepareCheckout(attempt: ActiveAttempt): Promise<ActiveAttempt> {
	const current = await readActiveAttempt();
	if (!current || current.requestId !== attempt.requestId) throw new CheckoutError('conflict');
	if (current.checkoutId) return current;
	let payload: string;
	try {
		const saved = sessionStorage.getItem(payloadKey(current.requestId));
		if (!saved) throw new CheckoutError('payload');
		const parsed = parsePrepareRequest(JSON.parse(saved));
		if (parsed.request_id !== current.requestId || parsed.fingerprint !== current.fingerprint || !sameCart(parseCart(JSON.stringify(parsed.items)), current.cartLines)) throw new CheckoutError('payload');
		payload = saved;
	} catch (error) { throw error instanceof CheckoutError ? error : new CheckoutError('payload'); }
	const { checkout_id } = parsePrepareResponse(await post('/api/checkouts/prepare', null, payload));
	const saved = await changeAttempt(current, (latest, _active, store) => {
		if (latest.checkoutId && latest.checkoutId !== checkout_id) throw new CheckoutError('conflict');
		const next = { ...latest, checkoutId: checkout_id, state: latest.state === 'preparing' ? 'prepared' as const : latest.state };
		save(store, next, true); return next;
	});
	// Read after transaction completion, independently of the successful put callback.
	const verified = await findCheckoutAttempt(checkout_id);
	if (!verified || verified.requestId !== saved.requestId || verified.checkoutId !== checkout_id) throw new CheckoutError('storage');
	return verified;
}

export async function readCheckout(attempt: ActiveAttempt): Promise<CheckoutSnapshot> {
	if (!attempt.checkoutId) throw new CheckoutError('missing');
	const verified = await findCheckoutAttempt(attempt.checkoutId);
	if (!verified || verified.requestId !== attempt.requestId || verified.checkoutId !== attempt.checkoutId || verified.fingerprint !== attempt.fingerprint) throw new CheckoutError('storage');
	const snapshot = parseCheckoutSnapshot(await post(`/api/checkouts/${attempt.checkoutId}`, binding(attempt)));
	if (snapshot.checkout_id !== attempt.checkoutId) throw new CheckoutError('unavailable');
	// Contact never goes into persistent state; reads need only the binding now.
	try { sessionStorage.removeItem(payloadKey(attempt.requestId)); } catch { throw new CheckoutError('storage'); }
	return snapshot;
}

export async function confirmCheckout(attempt: ActiveAttempt): Promise<CheckoutSnapshot> {
	if (!attempt.checkoutId) throw new CheckoutError('missing');
	const confirming = await changeAttempt(attempt, (current, _active, store) => {
		if (current.state === 'registered') return current;
		if (current.state !== 'prepared' && current.state !== 'confirming') throw new CheckoutError('conflict');
		const next: ActiveAttempt = { ...current, state: 'confirming' };
		save(store, next, true); return next;
	});
	if (confirming.state === 'registered') return readCheckout(confirming);
	// Persisted confirming survives response loss/reload and prohibits re-payment/set-aside.
	const snapshot = parseCheckoutSnapshot(await post(`/api/checkouts/${attempt.checkoutId}/confirm`, binding(attempt)));
	if (snapshot.checkout_id !== attempt.checkoutId || snapshot.status !== 'confirmed') throw new CheckoutError('unavailable');
	return snapshot;
}

/** Apply only a validated confirmed snapshot for this identity. Clear cart before pointer. */
export async function finishRegistration(attempt: ActiveAttempt, snapshot: CheckoutSnapshot): Promise<ActiveAttempt> {
	if (snapshot.status !== 'confirmed' || snapshot.checkout_id !== attempt.checkoutId) throw new CheckoutError('conflict');
	const registered = await changeAttempt(attempt, (current, active, store) => {
		const next: ActiveAttempt = { ...current, state: 'registered' };
		save(store, next, active?.requestId === current.requestId); return next;
	}, false);
	return changeAttempt(registered, (current, active, store) => {
		if (active?.requestId === current.requestId) {
			let lines: CartLine[];
			try { lines = parseCart(localStorage.getItem(CART_KEY)); } catch { throw new CheckoutError('storage'); }
			if (!current.cartLines && lines.length) throw new CheckoutError('storage');
			if (sameCart(lines, current.cartLines)) {
				localStorage.setItem(CART_KEY, '[]');
				if (localStorage.getItem(CART_KEY) !== '[]') throw new CheckoutError('storage');
			}
			store.delete(ACTIVE_ATTEMPT_KEY);
		}
		try { sessionStorage.removeItem(payloadKey(current.requestId)); } catch { throw new CheckoutError('storage'); }
		return current;
	}, false);
}

export async function setAsideCheckout(attempt: ActiveAttempt): Promise<void> {
	await changeAttempt(attempt, (current, _active, store) => {
		if (current.state !== 'prepared') throw new CheckoutError('conflict');
		const next = { ...current, setAside: true };
		save(store, next, false); store.delete(ACTIVE_ATTEMPT_KEY); return next;
	});
}
export async function resumeCheckout(attempt: ActiveAttempt): Promise<ActiveAttempt> {
	return changeAttempt(attempt, (current, active, store) => {
		if (active && active.requestId !== current.requestId) throw new CheckoutError('conflict');
		if (current.state !== 'prepared') throw new CheckoutError('conflict');
		const next = { ...current, setAside: false };
		save(store, next, true); return next;
	}, false);
}
export async function canOpenPayment(attempt: ActiveAttempt): Promise<boolean> {
	return withCartLock(async () => {
		const current = await readActiveAttempt();
		return current?.requestId === attempt.requestId && current.checkoutId === attempt.checkoutId && current.state === 'prepared';
	});
}
