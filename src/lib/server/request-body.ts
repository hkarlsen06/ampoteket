export class RequestBodyError extends Error {
	constructor(readonly code: 'BODY_TOO_LARGE' | 'INVALID_REQUEST' | 'REQUEST_TIMEOUT', readonly status: number) { super(code); }
}

/** Bound actual bytes and reading time, including requests without Content-Length. */
export async function readJsonBody(request: Request, maximum: number): Promise<unknown> {
	const length = request.headers.get('Content-Length');
	if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) throw new RequestBodyError('BODY_TOO_LARGE', 413);
	if (!request.body) throw new RequestBodyError('INVALID_REQUEST', 400);
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new RequestBodyError('REQUEST_TIMEOUT', 408)), 10000);
		});
		for (;;) {
			const { done, value } = await Promise.race([reader.read(), timeout]);
			if (done) break;
			size += value.byteLength;
			if (size > maximum) throw new RequestBodyError('BODY_TOO_LARGE', 413);
			chunks.push(value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
		try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
		catch { throw new RequestBodyError('INVALID_REQUEST', 400); }
	} finally {
		clearTimeout(timer);
		void reader.cancel().catch(() => {});
	}
}
