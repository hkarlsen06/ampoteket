// Online members of the Ampoteket Discord server. Proxied so visitors' browsers never
// contact Discord. Each cache cools down between bounded refreshes, including
// failures, and answers from its last good copy when Discord still refuses.
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const WIDGET = 'https://discord.com/api/guilds/1477943923115819230/widget.json';
const AVATARS = 'https://cdn.discordapp.com/widget-avatars/';
/** Members shown on the card; the rest are counted. */
const SHOWN = 12;
/** Most reachable first; Discord's own name order is kept within each status. */
const STATUSES = ['online', 'idle', 'dnd'] as const;
const FRESH_MS = 60_000;
/** The oldest answer shown while Discord keeps refusing. */
const KEEP_SECONDS = 3600;

type Widget = { presence_count?: unknown; members?: { username: string; status?: string; avatar_url?: string }[] };
const statusOf = (status?: string) => STATUSES.find((known) => known === status) ?? 'online';

// Discord refuses about half of Cloudflare's requests with a global 429 and a 0.3 s
// retry_after (measured 2026-10-01); each retry leaves from another shared address.
async function fetchWidget(): Promise<Widget | null> {
	const signal = AbortSignal.timeout(5000);
	for (let attempt = 1; ; attempt++) {
		if (signal.aborted) return null;
		const response = await fetch(WIDGET, { signal }).catch(() => null);
		if (response?.ok) return await response.json().catch(() => null) as Widget | null;
		void response?.body?.cancel().catch(() => {});
		if (response?.status !== 429 || attempt === 5) return null;
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
}

export const GET: RequestHandler = async ({ platform, url }) => {
	// Cache API key for the last good answer, on this zone; never routed.
	const lastGood = new URL('/api/discord/last-good', url).href;
	const lastAttempt = new URL('/api/discord/last-attempt', url).href;
	// Absent in plain `vite dev`, where every request asks Discord.
	const cache = platform?.caches?.default;
	const [kept, attempted] = await Promise.all([cache?.match(lastGood), cache?.match(lastAttempt)]);
	const age = Date.now() - Number(kept?.headers.get('X-Fetched-At'));
	if (kept && age < FRESH_MS) return reply(await kept.text());

	let widget: Widget | null = null;
	if (!attempted || Date.now() - Number(attempted.headers.get('X-Fetched-At')) >= FRESH_MS) {
		// Store before the request so failures and in-flight refreshes also cool down.
		// Cache API is shared but not an atomic lock across Worker isolates.
		await cache?.put(lastAttempt, new Response(null, {
			headers: { 'Cache-Control': 'max-age=60', 'X-Fetched-At': String(Date.now()) }
		}));
		widget = await fetchWidget();
	}
	if (typeof widget?.presence_count !== 'number') {
		if (kept) return reply(await kept.text());
		return json({ online: null }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
	}
	const members = (widget.members ?? [])
		.map((member) => ({ ...member, status: statusOf(member.status) }))
		.sort((a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status))
		.slice(0, SHOWN)
		.map((member) => ({
			name: member.username,
			status: member.status,
			avatar: member.avatar_url?.startsWith(AVATARS) ? `/api/discord/avatar/${member.avatar_url.slice(AVATARS.length)}` : null
		}));
	const body = JSON.stringify({ online: widget.presence_count, members });
	platform?.ctx?.waitUntil(cache?.put(lastGood, new Response(body, {
		headers: { 'Cache-Control': `max-age=${KEEP_SECONDS}`, 'X-Fetched-At': String(Date.now()) }
	})) ?? Promise.resolve());
	return reply(body);
};

const reply = (body: string) =>
	new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' } });
