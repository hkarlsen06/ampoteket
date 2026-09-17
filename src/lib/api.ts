import { parse } from 'lossless-json';

export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid API object');
	return value as Record<string, unknown>;
}
export function text(value: unknown, max: number): string {
	if (typeof value !== 'string' || !value.trim() || [...value].length > max) throw new Error('Invalid API text');
	return value;
}
export function identifier(value: unknown): string {
	if (typeof value !== 'string' || !uuidPattern.test(value)) throw new Error('Invalid API identifier');
	return value;
}

/**
 * The one JSON boundary for database/Worker responses, including audit images.
 * All numeric tokens become strings before JS can round them. Quantities, money,
 * IDs and revisions stay strings throughout the client. Only explicitly bounded
 * structural integers (for example shelf coordinates) may become JS numbers.
 */
export function parseApiJson(text: string): unknown {
	return parse(text, undefined, { parseNumber: (value) => value });
}

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly body: unknown
	) {
		// Do not interpolate the body, URL, token, or contact into error logs.
		super(`API request failed (${status})`);
		this.name = 'ApiError';
	}
}

/** Never use response.json() or an SDK's already-parsed data for these reads. */
export async function requestApiJson(
	input: RequestInfo | URL,
	init?: RequestInit,
	fetcher: Fetcher = fetch,
	timeoutMs = 15_000
): Promise<unknown> {
	// Workers supports manual, not the browser's redirect: 'error'. Never follow
	// an API redirect with an apikey/JWT or checkout-bearing request body.
	const deadline = AbortSignal.timeout(timeoutMs);
	const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
	const response = await fetcher(input, { ...init, signal, redirect: 'manual' });
	if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
		throw new ApiError(response.status, null);
	}
	const text = await response.text();
	const body = text === '' ? null : parseApiJson(text);
	if (!response.ok) throw new ApiError(response.status, body);
	return body;
}
