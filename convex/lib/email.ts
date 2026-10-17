/**
 * Invitation and reset email through Resend's API (actions only). Needs the
 * Convex environment variables RESEND_API_KEY and SITE_URL (the public origin,
 * https://ampoteket.no in production). The sender domain is verified in Resend.
 */
import { inviteHtml, recoveryHtml } from './emailTemplates';

const FROM = 'Ampoteket <noreply@notify.ampoteket.no>';
const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function siteOrigin(): string {
	const origin = process.env.SITE_URL;
	if (!origin) throw new Error('SITE_URL is not configured');
	return new URL(origin).origin;
}

/** The fixed localized password page; the token travels in the query, as the Supabase links did. */
export function passwordLink(locale: 'nb' | 'en', token: string, type: 'invite' | 'recovery'): string {
	const url = new URL(`${locale === 'en' ? '/en' : ''}/admin/password`, siteOrigin());
	url.searchParams.set('next', '/admin');
	url.searchParams.set('token_hash', token);
	url.searchParams.set('type', type);
	return url.href;
}

/** True when Resend accepted the message. Never logs the address or link. */
export async function sendPasswordEmail(kind: 'invite' | 'recovery', to: string, link: string): Promise<boolean> {
	const key = process.env.RESEND_API_KEY;
	if (!key) return false;
	const origin = siteOrigin();
	const html = (kind === 'invite' ? inviteHtml : recoveryHtml)(origin, escape(to), escape(link));
	const subject = kind === 'invite' ? 'Ampoteket: Invitasjon / Invitation' : 'Ampoteket: Velg passord / Choose password';
	try {
		const response = await fetch('https://api.resend.com/emails', {
			method: 'POST', signal: AbortSignal.timeout(15_000),
			headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ from: FROM, to: [to], subject, html, text: `${subject}\n\n${link}\n` })
		});
		return response.ok;
	} catch {
		return false;
	}
}
