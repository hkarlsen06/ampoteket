import { defineEnvVars } from '@sveltejs/kit/env';

// All optional: a missing value reads as undefined and its feature reports itself unavailable.
// Production values come from wrangler.jsonc vars and secrets; development from the shell or .env.
const optional = (value: string | undefined) => value;

export const variables = defineEnvVars({
	PUBLIC_SUPABASE_URL: { public: true, schema: optional },
	PUBLIC_SUPABASE_PUBLISHABLE_KEY: { public: true, schema: optional },
	SUPABASE_SECRET_KEY: { schema: optional },
	SUPABASE_API_PROXY: { schema: optional },
	CHECKOUT_ALLOWED_ORIGIN: { schema: optional },
	RESEND_API_KEY: { schema: optional },
	SALES_OPEN: { schema: optional }
});
