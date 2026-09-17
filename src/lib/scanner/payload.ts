const codePattern = /^[A-Z0-9][A-Z0-9-]{0,39}$/;
const labelOrigin = 'https://ampoteket.no';

/** QR data is an identifier, never a fetch/navigation destination. The printed
 * label contract uses one path parameter, not a query-string parameter. */
export function productCodeFromQr(payload: string): string | null {
	if (payload.length > 128 || /[\s\\%?#]/u.test(payload)) return null;
	try {
		const canonical = payload.startsWith('ampoteket.no/p/') ? `https://${payload}` : payload;
		const url = new URL(canonical);
		if (url.origin !== labelOrigin || url.protocol !== 'https:' || url.username || url.password
			|| url.search || url.hash || url.href !== canonical) return null;
		const match = /^\/p\/([^/]+)$/.exec(url.pathname);
		return match && codePattern.test(match[1]) ? match[1] : null;
	} catch { return null; }
}

/** Typing/pasting is deliberate; bare codes may be entered in either case. */
export function productCodeFromEntry(input: string): string | null {
	const value = input.trim();
	return codePattern.test(value.toUpperCase()) ? value.toUpperCase() : productCodeFromQr(value);
}
