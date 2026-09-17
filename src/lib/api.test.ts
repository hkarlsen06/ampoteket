import { describe, expect, test } from 'bun:test';
import { ApiError, parseApiJson, requestApiJson } from './api';

describe('lossless API boundary', () => {
	test('preserves exact money, quantities, bigint IDs and nested audit facts', () => {
		const body = '{"price":999999999998.999999,"quantity":-0.000001,"revision":9007199254740993,"before_data":{"price":0.005,"coordinate":2},"quoted":"1.20","active":true,"missing":null}';
		expect(parseApiJson(body)).toEqual({
			price: '999999999998.999999', quantity: '-0.000001', revision: '9007199254740993',
			before_data: { price: '0.005', coordinate: '2' }, quoted: '1.20', active: true, missing: null
		});
	});

	test('handles arrays, exponent notation and escaping without converting string contents', () => {
		expect(parseApiJson('[1e100,0,-0,1.2300,"a\\"12",true,null]')).toEqual([
			'1e100', '0', '-0', '1.2300', 'a"12', true, null
		]);
	});

	test('rejects malformed JSON and ambiguous duplicate fields', () => {
		for (const body of ['{"x":01}', '{"x":NaN}', '{"x":Infinity}', '[1,]', '{"x":1,"x":2}']) {
			expect(() => parseApiJson(body)).toThrow();
		}
	});

	test('fetches raw response text, preserving values through an edit round trip', async () => {
		const fetcher = (async () => new Response('{"unit_cost_nok":999999999998.999999,"id":9007199254740993}'));
		const data = await requestApiJson('https://example.invalid/rest/v1/amp_purchase_order_lines', undefined, fetcher);
		expect(JSON.stringify(data)).toBe('{"unit_cost_nok":"999999999998.999999","id":"9007199254740993"}');
	});

	test('propagates HTTP failures without turning them into empty data', async () => {
		const fetcher = (async () => new Response('{"code":"STAFF_REQUIRED"}', { status: 403 }));
		try {
			await requestApiJson('https://example.invalid/', undefined, fetcher);
			throw new Error('request unexpectedly succeeded');
		} catch (error) {
			expect(error).toBeInstanceOf(ApiError);
			expect((error as ApiError).status).toBe(403);
			expect((error as ApiError).body).toEqual({ code: 'STAFF_REQUIRED' });
		}
	});

	test('accepts successful empty mutation responses', async () => {
		const fetcher = (async () => new Response(null, { status: 204 }));
		expect(await requestApiJson('https://example.invalid/', undefined, fetcher)).toBeNull();
	});

	test('rejects redirects before decoding and never follows with credentials', async () => {
		await expect(requestApiJson('https://example.invalid/', { redirect: 'follow' }, async (_input, init) => {
			expect(init?.redirect).toBe('manual');
			return new Response('<html>Redirect</html>', { status: 302, headers: { Location: 'https://other.invalid/' } });
		})).rejects.toBeInstanceOf(ApiError);
	});

	test('bounds stalled requests and preserves navigation cancellation', async () => {
		const stalled = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const signal = init!.signal!;
			signal.throwIfAborted();
			return new Promise((_resolve, reject) => {
				signal.addEventListener('abort', () => reject(signal.reason), { once: true });
			});
		};
		const navigation = new AbortController();
		await expect(requestApiJson('https://example.invalid/', { signal: navigation.signal }, stalled, 10))
			.rejects.toMatchObject({ name: 'TimeoutError' });
		const request = requestApiJson('https://example.invalid/', { signal: navigation.signal }, stalled);
		navigation.abort();
		await expect(request).rejects.toMatchObject({ name: 'AbortError' });
	});
});
