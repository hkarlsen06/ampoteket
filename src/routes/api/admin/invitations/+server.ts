import { CHECKOUT_ALLOWED_ORIGIN as origin, SUPABASE_SECRET_KEY as secretKey } from '$app/env/private';
import { env } from 'cloudflare:workers';
import { getCatalogConfig } from '#lib/server/catalog-config.js';
import { adminInvitation, type AdminInvitationConfig } from '#lib/server/admin-invitations.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = (event) => {
	const publicConfig = getCatalogConfig();
	const config = publicConfig && typeof origin === 'string' && typeof secretKey === 'string' ? {
		origin, apiUrl: publicConfig.url, publishableKey: publicConfig.publishableKey, secretKey,
		invitationLimit: env.ADMIN_INVITATION_LIMIT
	} as AdminInvitationConfig : null;
	let clientAddress = 'unavailable';
	try { clientAddress = event.getClientAddress(); } catch { /* Missing addresses share a conservative limit. */ }
	return adminInvitation(event.request, clientAddress, config, event.fetch);
};
