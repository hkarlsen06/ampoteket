// Online members of the Ampoteket Discord server. Proxied so visitors' browsers never
// contact Discord, and cached at the edge so page views never reach its rate limit.
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const WIDGET = 'https://discord.com/api/guilds/1477943923115819230/widget.json';
const AVATARS = 'https://cdn.discordapp.com/widget-avatars/';
/** Members shown on the card; the rest are counted. */
const SHOWN = 12;
/** Most reachable first; Discord's own name order is kept within each status. */
const STATUSES = ['online', 'idle', 'dnd'] as const;

type Widget = { presence_count?: unknown; members?: { username: string; status?: string; avatar_url?: string }[] };
const statusOf = (status?: string) => STATUSES.find((known) => known === status) ?? 'online';

export const GET: RequestHandler = async () => {
	const response = await fetch(WIDGET, { cf: { cacheTtl: 60, cacheEverything: true } }).catch(() => null);
	const widget: Widget | null = response?.ok ? await response.json() : null;
	if (typeof widget?.presence_count !== 'number') return json({ online: null }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
	const members = (widget.members ?? [])
		.map((member) => ({ ...member, status: statusOf(member.status) }))
		.sort((a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status))
		.slice(0, SHOWN)
		.map((member) => ({
			name: member.username,
			status: member.status,
			avatar: member.avatar_url?.startsWith(AVATARS) ? `/api/discord/avatar/${member.avatar_url.slice(AVATARS.length)}` : null
		}));
	return json({ online: widget.presence_count, members }, { headers: { 'Cache-Control': 'public, max-age=60' } });
};
