/**
 * Idempotent commands (`command_requests`). A client sends a fresh request ID
 * per intention and reuses it after an uncertain result. The first completion
 * stores its result; a retry with the same ID returns that result unchanged.
 * Reusing an ID with other input or another actor is rejected.
 *
 * Convex mutations are serializable, so two concurrent duplicates cannot both
 * run the command: the loser is retried by Convex and then finds the result.
 */
import type { MutationCtx } from '../_generated/server';
import { fail } from './errors';
import { isoNow } from './time';
import { isUuid } from './ids';

export async function sha256Hex(text: string): Promise<string> {
	const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Stable JSON: object keys sorted, so equal input always digests equally. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (value && typeof value === 'object') {
		return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
	}
	return JSON.stringify(value ?? null);
}

export type CommandStart<R> = { done: true; result: R } | { done: false; finish: (result: R) => Promise<R> };

export async function beginCommand<R>(ctx: MutationCtx, requestId: string, name: string, actorId: string | null, body: unknown): Promise<CommandStart<R>> {
	if (!isUuid(requestId)) fail('REQUEST_ID_REQUIRED');
	const digest = await sha256Hex(canonicalJson(body));
	const existing = await ctx.db.query('command_requests').withIndex('uuid', (q) => q.eq('id', requestId)).unique();
	if (existing) {
		if (existing.command_name !== name || existing.actor_id !== actorId || existing.request_digest !== digest) {
			fail('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT');
		}
		return { done: true, result: existing.result as R };
	}
	const _id = await ctx.db.insert('command_requests', { id: requestId, command_name: name, actor_id: actorId, request_digest: digest, result: null, created_at: isoNow() });
	return { done: false, finish: async (result: R) => { await ctx.db.patch(_id, { result }); return result; } };
}
