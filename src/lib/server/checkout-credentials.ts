/**
 * Credential primitives for the Worker checkout gateway.
 * The root stays in a Secure HttpOnly cookie; neither it nor derived tokens are
 * returned to browser JS. See docs/checkout-recovery.md for the required protocol.
 */
const hexSecret = /^[0-9a-f]{64}$/;
const attemptId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer | Uint8Array): string {
	return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function sessionKey(secret: string): Uint8Array<ArrayBuffer> {
	if (!hexSecret.test(secret)) throw new Error('INVALID_CHECKOUT_SESSION');
	return Uint8Array.from(secret.match(/../g)!, (byte) => parseInt(byte, 16));
}

/** Call only on explicit initial session setup, never while resuming an attempt. */
export function newCheckoutSessionSecret(): string {
	return hex(crypto.getRandomValues(new Uint8Array(32)));
}

/** A public binding value, not authorization and not a recoverable copy of the key. */
export async function checkoutSessionFingerprint(secret: string): Promise<string> {
	const prefix = encoder.encode('ampoteket:checkout-session:v1:');
	const key = sessionKey(secret);
	const bytes = new Uint8Array(prefix.length + key.length);
	bytes.set(prefix);
	bytes.set(key, prefix.length);
	return hex(await crypto.subtle.digest('SHA-256', bytes));
}

/**
 * Same cookie + attempt always recovers the same DB token, including after a lost
 * prepare response or Worker restart. A missing/replaced cookie fails closed.
 */
export async function checkoutTokenForAttempt(
	secret: string | undefined,
	requestId: string,
	expectedFingerprint: string
): Promise<string> {
	if (secret === undefined) throw new Error('CHECKOUT_SESSION_MISSING');
	if (!attemptId.test(requestId)) throw new Error('INVALID_CHECKOUT_ATTEMPT');
	const keyBytes = sessionKey(secret);
	if (!hexSecret.test(expectedFingerprint)
		|| await checkoutSessionFingerprint(secret) !== expectedFingerprint) {
		throw new Error('CHECKOUT_SESSION_CHANGED');
	}
	const key = await crypto.subtle.importKey('raw', keyBytes,
		{ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	return hex(await crypto.subtle.sign('HMAC', key,
		encoder.encode(`ampoteket:checkout-token:v1:${requestId}`)));
}
