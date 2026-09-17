import { describe, expect, test } from 'bun:test';
import {
	checkoutSessionFingerprint, checkoutTokenForAttempt, newCheckoutSessionSecret
} from './checkout-credentials';

const secret = 'ab'.repeat(32);
const requestId = '81000000-0000-4000-8000-000000000001';
const fingerprint = '7fe7b7dea7968fcc9888f07b871ff5b8933e38e9fd9f1f092bd7f4f44e5d99d6';

describe('checkout credential protocol primitives', () => {
	test('matches independently calculated SHA-256 and HMAC-SHA-256 vectors', async () => {
		expect(await checkoutSessionFingerprint(secret)).toBe(fingerprint);
		expect(await checkoutTokenForAttempt(secret, requestId, fingerprint))
			.toBe('24757bd200c81c4386e229f62dea47fc67ffa979097b8be0a794d1ec2036ded0');
	});

	test('lost-response retries derive the identical token without Worker state', async () => {
		const first = await checkoutTokenForAttempt(secret, requestId, fingerprint);
		const retried = await checkoutTokenForAttempt(secret, requestId, fingerprint);
		expect(retried).toBe(first);
		expect(first).toMatch(/^[0-9a-f]{64}$/);
	});

	test('binds every attempt to both its ID and its cookie session', async () => {
		const first = await checkoutTokenForAttempt(secret, requestId, fingerprint);
		const otherAttempt = await checkoutTokenForAttempt(secret,
			'81000000-0000-4000-8000-000000000002', fingerprint);
		const otherSecret = 'cd'.repeat(32);
		const otherSession = await checkoutTokenForAttempt(otherSecret, requestId,
			await checkoutSessionFingerprint(otherSecret));
		expect(new Set([first, otherAttempt, otherSession]).size).toBe(3);
	});

	test('a raced, cleared or malformed cookie fails instead of generating a replacement token', async () => {
		await expect(checkoutTokenForAttempt('cd'.repeat(32), requestId, fingerprint))
			.rejects.toThrow('CHECKOUT_SESSION_CHANGED');
		await expect(checkoutTokenForAttempt(undefined, requestId, fingerprint))
			.rejects.toThrow('CHECKOUT_SESSION_MISSING');
		await expect(checkoutTokenForAttempt('not-a-cookie-secret', requestId, fingerprint))
			.rejects.toThrow('INVALID_CHECKOUT_SESSION');
		await expect(checkoutTokenForAttempt(secret, requestId, 'changed-fingerprint'))
			.rejects.toThrow('CHECKOUT_SESSION_CHANGED');
	});

	test('rejects noncanonical attempt IDs before deriving credentials', async () => {
		for (const id of ['', 'not-a-uuid', requestId.toUpperCase().replace('8100', 'AB00'),
			'81000000-0000-1000-8000-000000000001']) {
			await expect(checkoutTokenForAttempt(secret, id, fingerprint))
				.rejects.toThrow('INVALID_CHECKOUT_ATTEMPT');
		}
	});

	test('new sessions contain 256 random bits in the cookie format', () => {
		const values = Array.from({ length: 8 }, () => newCheckoutSessionSecret());
		for (const value of values) expect(value).toMatch(/^[0-9a-f]{64}$/);
		expect(new Set(values).size).toBe(values.length);
	});
});
