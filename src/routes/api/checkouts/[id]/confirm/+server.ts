import { handleCheckout } from '$lib/server/checkout-handler';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = (event) => handleCheckout('confirm', event);
