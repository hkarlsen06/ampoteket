import { env } from '$env/dynamic/private';
import { getCatalogConfig } from '$lib/server/catalog-config';
import { adminInvitation, type AdminInvitationConfig } from '$lib/server/admin-invitations';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = (event) => {
	const bindings = event.platform?.env as unknown as Record<string, unknown> | undefined;
	const publicConfig = getCatalogConfig(event.platform);
	const origin = bindings?.CHECKOUT_ALLOWED_ORIGIN ?? env.CHECKOUT_ALLOWED_ORIGIN;
	const secretKey = bindings?.SUPABASE_SECRET_KEY ?? env.SUPABASE_SECRET_KEY;
	const config = publicConfig && typeof origin === 'string' && typeof secretKey === 'string' ? {
		origin, apiUrl: publicConfig.url, publishableKey: publicConfig.publishableKey, secretKey,
		invitationLimit: bindings?.ADMIN_INVITATION_LIMIT
	} as AdminInvitationConfig : null;
	let clientAddress = 'unavailable';
	try { clientAddress = event.getClientAddress(); } catch { /* Missing addresses share a conservative limit. */ }
	return adminInvitation(event.request, clientAddress, config, event.fetch);
};
