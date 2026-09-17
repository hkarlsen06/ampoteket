import { BarcodeDetector, prepareZXingModule, ZXING_WASM_SHA256 } from 'barcode-detector/ponyfill';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

let detector: BarcodeDetector | undefined;
// Both imports resolve from exact pins in package.json/bun.lock. Vite emits the
// reader binary as an immutable same-origin asset; no CDN fallback is allowed.
async function initialize() {
	const response = await fetch(wasmUrl, { credentials: 'omit', redirect: 'error' });
	if (!response.ok) throw new Error('Decoder asset unavailable');
	const binary = await response.arrayBuffer();
	const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', binary)),
		(byte) => byte.toString(16).padStart(2, '0')).join('');
	if (digest !== ZXING_WASM_SHA256) throw new Error('Decoder asset mismatch');
	await prepareZXingModule({ overrides: { wasmBinary: binary,
		locateFile: (path: string) => {
			if (path === 'zxing_reader.wasm') return wasmUrl;
			throw new Error('Unexpected decoder asset');
		} }, fireImmediately: true });
	detector = new BarcodeDetector({ formats: ['qr_code'] });
}

self.onmessage = async (event: MessageEvent<{ initialize?: boolean; frame?: ImageData }>) => {
	try {
		if (event.data.initialize) { await initialize(); self.postMessage({ ready: true }); return; }
		const frame = event.data.frame;
		if (!detector || !frame) throw new Error('Decoder not initialized');
		const results = await detector.detect(frame);
		self.postMessage({ results: results.map((result) => ({ value: result.rawValue,
			corners: result.cornerPoints.map(({ x, y }) => ({ x: x / frame.width, y: y / frame.height })) })) });
	} catch { self.postMessage({ failed: true }); }
};
