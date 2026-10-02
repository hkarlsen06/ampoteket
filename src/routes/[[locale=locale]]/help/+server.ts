import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
// The contact page moved from /help; printed posters and sent receipts still link here.
export const GET: RequestHandler = ({ url }) => redirect(308, url.pathname.replace(/help$/, 'contact') + url.search);
