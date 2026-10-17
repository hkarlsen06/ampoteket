import { defineEnvVars } from '@sveltejs/kit/env';

// All optional: a missing value reads as undefined and its feature reports itself unavailable.
// Production values come from wrangler.jsonc vars and secrets; development from the shell or .env.
const optional = (value: string | undefined) => value;

export const variables = defineEnvVars({
	// The Convex deployment URL (https://<name>.convex.cloud), used by browser and server.
	PUBLIC_CONVEX_URL: { public: true, schema: optional },
	// Shared with the Convex deployment's CHECKOUT_SERVER_KEY; proves checkout calls come from this Worker.
	CHECKOUT_SERVER_KEY: { schema: optional },
	CHECKOUT_ALLOWED_ORIGIN: { schema: optional },
	RESEND_API_KEY: { schema: optional },
	SALES_OPEN: { schema: optional }
});
