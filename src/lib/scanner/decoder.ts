import type { QrDetection } from './selection';

/** Camera/UI/basket code depends on this interface, never on a decoder vendor. */
export interface QrDecoder {
	decode(frame: ImageData): Promise<QrDetection[]>;
	dispose(): void;
}

/** Loaded only through the client camera-session import, after activation. */
export async function createQrDecoder(signal: AbortSignal): Promise<QrDecoder> {
	const worker = new Worker(new URL('./decoder.worker.ts', import.meta.url), { type: 'module' });
	let pending: { resolve: (value: QrDetection[]) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
	let disposed = false;
	const failure = () => new Error('QR decoder unavailable');
	function dispose() {
		if (disposed) return;
		disposed = true; worker.terminate(); signal.removeEventListener('abort', dispose);
		if (pending) { clearTimeout(pending.timer); pending.reject(failure()); pending = null; }
	}
	function request(frame?: ImageData): Promise<QrDetection[]> {
		if (disposed || pending) return Promise.reject(failure());
		return new Promise((resolve, reject) => {
			pending = { resolve, reject, timer: setTimeout(dispose, 15000) };
			if (frame) worker.postMessage({ frame }, [frame.data.buffer]);
			else worker.postMessage({ initialize: true });
		});
	}
	worker.onmessage = (event: MessageEvent<{ results?: QrDetection[]; ready?: boolean; failed?: boolean }>) => {
		if (!pending) return;
		const current = pending; pending = null; clearTimeout(current.timer);
		if (event.data.failed) { current.reject(failure()); dispose(); }
		else current.resolve(event.data.results ?? []);
	};
	worker.onerror = (event) => { event.preventDefault(); dispose(); };
	worker.onmessageerror = dispose;
	signal.addEventListener('abort', dispose, { once: true });
	if (signal.aborted) dispose();
	try { await request(); }
	catch { dispose(); throw failure(); }
	return { decode: request, dispose };
}
