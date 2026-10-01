import type { CheckoutSnapshot } from '../checkout-contract';
import { formatDecimal, formatMoney, unitLabel } from '../format';
import { localizeHref, messagesFor, type Locale } from '../i18n';

export type ReceiptConfig = { resendApiKey: string; limit: { limit(options: { key: string }): Promise<{ success: boolean }> } };
/** Staff archive: every buyer-registered checkout sends it a copy of the receipt. */
export const STAFF_RECEIPT_COPY = 'ampoteket.kvittering@outlook.com';
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function receiptAddress(value: unknown): string | null {
	const address = typeof value === 'string' ? value.trim() : '';
	return address.length <= 254 && emailPattern.test(address) && !/\p{Cc}/u.test(address) ? address : null;
}

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const monospace = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";
const locales: Locale[] = ['nb', 'en'];
const receiptDate = (snapshot: CheckoutSnapshot, locale: Locale) => new Intl.DateTimeFormat(locale === 'nb' ? 'nb-NO' : 'en-GB',
	{ dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Oslo' }).format(new Date(snapshot.confirmed_at ?? snapshot.created_at));

function section(snapshot: CheckoutSnapshot, locale: Locale, origin: string) {
	const m = messagesFor(locale).receipt;
	const date = receiptDate(snapshot, locale);
	const rows = snapshot.items.map((item) => `<tr>
    <td class="text rule" style="padding:12px 0;border-bottom:1px solid #c9d1db;font-size:16px;line-height:1.4;color:#0f141b;"><a class="text" href="${origin}${localizeHref(`/p/${encodeURIComponent(item.code)}`, locale)}" style="color:#0f141b;text-decoration:underline;">${escape(locale === 'nb' ? item.name_nb : item.name_en)}</a><br><span class="muted" style="font-size:14px;color:#4b586a;">${escape(item.code)} · ${formatDecimal(item.quantity, locale)} ${escape(unitLabel(item.unit, locale, item.quantity))}</span></td>
    <td class="text rule" align="right" style="padding:12px 0 12px 12px;border-bottom:1px solid #c9d1db;font-size:16px;white-space:nowrap;font-variant-numeric:tabular-nums;color:#0f141b;">${formatMoney(item.line_total_nok, locale)}</td>
  </tr>`).join('\n  ');
	return `<h${locale === 'nb' ? 1 : 2} class="text" style="margin:0 0 12px;font-size:24px;line-height:1.2;font-weight:700;color:#0f141b;">${m.heading}</h${locale === 'nb' ? 1 : 2}>
  <p class="text" style="margin:0 0 24px;font-size:16px;line-height:1.55;color:#0f141b;">${m.lead(date)}</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  ${rows}
  <tr>
    <td class="text" style="padding:12px 0 0;font-size:16px;font-weight:700;color:#0f141b;">${m.total}</td>
    <td class="text" align="right" style="padding:12px 0 0 12px;font-size:18px;font-weight:700;white-space:nowrap;font-variant-numeric:tabular-nums;color:#0f141b;">${formatMoney(snapshot.total_nok, locale)}</td>
  </tr>
  </table>
  <p class="muted" style="margin:24px 0 0;font-size:14px;line-height:1.55;color:#4b586a;">${m.note}</p>
  <p class="muted" style="margin:16px 0 0;font-size:14px;line-height:1.55;color:#4b586a;">${m.referenceHelp}<br>${m.reference}: <span class="text" style="font-family:${monospace};font-size:13px;word-break:break-all;color:#0f141b;">${escape(snapshot.checkout_id)}</span></p>
  <p style="margin:16px 0 0;font-size:14px;line-height:1.55;"><a class="text" href="${origin}${localizeHref('/help', locale)}" style="color:#0f141b;text-decoration:underline;">${m.help}</a></p>`;
}

export function receiptHtml(snapshot: CheckoutSnapshot, origin: string): string {
	const { nb, en } = { nb: messagesFor('nb').receipt, en: messagesFor('en').receipt };
	return `<!doctype html>
<html lang="nb">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${nb.heading}</title>
<style>
  body { margin: 0; padding: 0; }
  @media (prefers-color-scheme: dark) {
    .page { background: #000000 !important; }
    .card { background: #0d0d0e !important; border-color: #2a2a2d !important; }
    .text { color: #edf1f6 !important; }
    .muted { color: #a1a1a8 !important; }
    .rule { border-color: #2a2a2d !important; }
  }
</style>
</head>
<body class="page" style="margin:0;padding:0;background:#f2f4f7;">
<div style="display:none;max-height:0;overflow:hidden;">${nb.preheader} ${en.preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="page" style="background:#f2f4f7;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card" style="max-width:560px;background:#ffffff;border:1px solid #c9d1db;border-radius:4px;border-collapse:separate;overflow:hidden;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<tr><td style="padding:24px 24px 0;">
  <img src="${origin}/brand/wordmark-email.png" width="216" height="56" alt="Ampoteket" style="display:block;border:0;background:#000000;color:#ff3c33;font-size:20px;font-weight:800;">
</td></tr>
<tr><td style="padding:24px;">
  ${section(snapshot, 'nb', origin)}

  <div lang="en" class="rule" style="margin-top:32px;padding-top:32px;border-top:1px solid #c9d1db;">
  ${section(snapshot, 'en', origin)}
  </div>

  <p class="muted" style="margin:32px 0 0;font-size:14px;line-height:1.55;color:#4b586a;">${escape(nb.address)}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** Plain-text alternative with the same content, for clients and filters that ignore HTML. */
export function receiptText(snapshot: CheckoutSnapshot, origin: string): string {
	const parts = locales.map((locale) => {
		const m = messagesFor(locale).receipt;
		const lines = snapshot.items.map((item) => `- ${locale === 'nb' ? item.name_nb : item.name_en} (${item.code}): ${formatDecimal(item.quantity, locale)} ${unitLabel(item.unit, locale, item.quantity)}, ${formatMoney(item.line_total_nok, locale)}`);
		return [m.heading, m.lead(receiptDate(snapshot, locale)), '', ...lines, `${m.total}: ${formatMoney(snapshot.total_nok, locale)}`, '', m.note, '',
			m.referenceHelp, `${m.reference}: ${snapshot.checkout_id}`, `${m.help}: ${origin}${localizeHref('/help', locale)}`].join('\n');
	});
	return `${parts.join('\n\n----\n\n')}\n\n${messagesFor('nb').receipt.address}\n`;
}

/**
 * The address is used for this one send and never stored or logged. The key makes a
 * repeated send to the same address within Resend's 24 h window deliver one email.
 */
export async function sendReceipt(snapshot: CheckoutSnapshot, to: string, config: ReceiptConfig & { origin: string },
	fetcher: typeof fetch = fetch): Promise<boolean> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(to.toLowerCase())));
	const addressKey = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
	try {
		const result = await fetcher('https://api.resend.com/emails', {
			method: 'POST', signal: AbortSignal.timeout(15000),
			headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json',
				'Idempotency-Key': `receipt/${snapshot.checkout_id}/${addressKey}` },
			body: JSON.stringify({ from: 'Ampoteket <noreply@notify.ampoteket.no>', to: [to],
				subject: `${messagesFor('nb').receipt.subject} / ${messagesFor('en').receipt.subject}`,
				html: receiptHtml(snapshot, config.origin), text: receiptText(snapshot, config.origin) })
		});
		return result.ok;
	} catch { return false; }
}
