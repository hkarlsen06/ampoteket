import { handleCheckout } from '#lib/server/checkout-handler.js';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = (event) => handleCheckout('get', event);
