/** Brother PT-P700 over WebUSB (Chromium desktop only). Command sequence per
 * Brother's "Raster Command Reference PT-H500/P700/E500" §2.1, sent one command or
 * raster line per transfer as ptouch-print does; see docs/page-labels.md. */
import type { TapeBitmap } from './render';

export const ptouchFilter = { vendorId: 0x04f9, productId: 0x2061 };
const headPins = 128;
// Printable dots across each TZe width (reference §2.3.5); the rest is unprinted edge.
const printPins: Record<number, number> = { 4: 24, 6: 32, 9: 50, 12: 70, 18: 112, 24: 128 };

export type PtouchErrorKind = 'unsupported' | 'cancelled' | 'busy' | 'cover' | 'tape' | 'unconfirmed' | 'failed';
export class PtouchError extends Error {
	constructor(public kind: PtouchErrorKind) { super(`P-touch: ${kind}`); this.name = 'PtouchError'; }
}

export type PtouchStatus = { tapeMm: number; type: number; error: PtouchErrorKind | null };
export function parseStatus(bytes: Uint8Array): PtouchStatus | null {
	if (bytes.length !== 32 || bytes[0] !== 0x80 || bytes[1] !== 0x20) return null;
	// Error 1 bit 0 = no media; error 2 bit 0 = wrong media, bit 4 = cover open.
	const error = bytes[9] & 0x10 ? 'cover' : bytes[8] & 0x01 || bytes[9] & 0x01 ? 'tape'
		: bytes[8] || bytes[9] || bytes[18] === 0x02 ? 'failed' : null;
	return { tapeMm: bytes[10], type: bytes[18], error };
}

export function tapePins(tapeMm: number): number {
	const pins = printPins[tapeMm];
	if (!pins) throw new PtouchError('tape');
	return pins;
}

/** Everything after the status request for one label: raster mode, print
 * information, auto cut, chain printing, 2 mm margins, TIFF mode, one
 * uncompressed-run line per bitmap row, then print. Chain printing leaves the
 * label under the cutter; the next print (or the printer's cut button) feeds it
 * out and cuts, so no blank leader is cut off per label. */
export function rasterJob(bitmap: TapeBitmap, tapeMm: number): Uint8Array[] {
	const offset = headPins / 2 - bitmap.width / 2;
	const rows = bitmap.height;
	const job = [
		[0x1b, 0x69, 0x61, 0x01],
		[0x1b, 0x69, 0x7a, 0x84, 0x00, tapeMm, 0x00, rows & 0xff, rows >> 8 & 0xff, rows >> 16 & 0xff, rows >>> 24, 0x00, 0x00],
		[0x1b, 0x69, 0x4d, 0x40],
		[0x1b, 0x69, 0x4b, 0x00],
		[0x1b, 0x69, 0x64, 0x0e, 0x00],
		[0x4d, 0x02]
	].map(bytes => Uint8Array.from(bytes));
	for (let row = 0; row < rows; row++) {
		// 'G', length 17, then a packbits literal run (15 = 16 bytes follow).
		const line = new Uint8Array(4 + headPins / 8);
		line.set([0x47, headPins / 8 + 1, 0x00, headPins / 8 - 1]);
		for (let x = 0; x < bitmap.width; x++) if (bitmap.ink[row * bitmap.width + x]) {
			const pin = offset + x;
			line[4 + headPins / 8 - 1 - (pin >> 3)] |= 1 << (pin & 7);
		}
		job.push(line);
	}
	job.push(Uint8Array.of(0x1a));
	return job;
}

// Minimal WebUSB surface; the DOM library does not ship these types.
type UsbEndpoint = { endpointNumber: number; direction: 'in' | 'out' };
type UsbDevice = {
	vendorId: number; productId: number; opened: boolean;
	configuration: { interfaces: { interfaceNumber: number; alternate: { endpoints: UsbEndpoint[] } }[] } | null;
	open(): Promise<void>; close(): Promise<void>; selectConfiguration(value: number): Promise<void>;
	claimInterface(value: number): Promise<void>; releaseInterface(value: number): Promise<void>;
	transferOut(endpoint: number, data: Uint8Array): Promise<unknown>;
	transferIn(endpoint: number, length: number): Promise<{ data?: DataView }>;
};
type Usb = { getDevices(): Promise<UsbDevice[]>; requestDevice(options: { filters: typeof ptouchFilter[] }): Promise<UsbDevice> };
function usb(): Usb | undefined { return (navigator as Navigator & { usb?: Usb }).usb; }

const granted = async (api: Usb) => (await api.getDevices()).find(item => item.vendorId === ptouchFilter.vendorId && item.productId === ptouchFilter.productId);

async function device(): Promise<UsbDevice> {
	const api = usb();
	if (!api) throw new PtouchError('unsupported');
	const known = await granted(api);
	if (known) return known;
	// Must run inside the click that started printing (transient user activation).
	try { return await api.requestDevice({ filters: [ptouchFilter] }); }
	catch (error) { throw new PtouchError(error instanceof DOMException && error.name === 'NotFoundError' ? 'cancelled' : 'failed'); }
}

/** Grants the printer during a click, so a later print needs no user gesture. */
export async function choosePrinter(): Promise<void> { await device(); }
export const printerSupported = () => Boolean(usb());

/** Prints one label. `render` receives the printable dots for the loaded tape;
 * its errors propagate unchanged. Resolves after the printer reports completion. */
export async function printTapeLabel(render: (pins: number) => Promise<TapeBitmap>): Promise<void> {
	const printer = await device();
	try { await printer.open(); if (!printer.configuration) await printer.selectConfiguration(1); await printer.claimInterface(0); }
	catch { if (printer.opened) await printer.close().catch(() => {}); throw new PtouchError('busy'); }
	const endpoints = printer.configuration!.interfaces[0].alternate.endpoints;
	const output = endpoints.find(endpoint => endpoint.direction === 'out')!.endpointNumber;
	const input = endpoints.find(endpoint => endpoint.direction === 'in')!.endpointNumber;
	// One reader drains every status, so the printer never stalls on an unread reply.
	const statuses: PtouchStatus[] = [];
	let wake = () => {};
	let open = true;
	const reader = (async () => {
		while (open) {
			const result = await printer.transferIn(input, 32).catch(() => null);
			if (!result) return;
			const status = result.data && parseStatus(new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength));
			if (status) { statuses.push(status); wake(); }
		}
	})();
	async function next(timeout: number, match: (status: PtouchStatus) => boolean): Promise<PtouchStatus | null> {
		const deadline = Date.now() + timeout;
		for (;;) {
			const found = statuses.splice(0).find(status => status.error || match(status));
			if (found) return found;
			const left = deadline - Date.now();
			if (left <= 0) return null;
			await new Promise<void>(resolve => { wake = resolve; setTimeout(resolve, left); });
		}
	}
	const send = (bytes: Uint8Array) => printer.transferOut(output, bytes);
	try {
		await send(Uint8Array.from([...new Array(100).fill(0), 0x1b, 0x40]));
		await send(Uint8Array.of(0x1b, 0x69, 0x53));
		const status = await next(3000, item => item.type === 0x00);
		if (!status) throw new PtouchError('failed');
		if (status.error) throw new PtouchError(status.error);
		const tapeMm = status.tapeMm;
		const bitmap = await render(tapePins(tapeMm));
		for (const bytes of rasterJob(bitmap, tapeMm)) await send(bytes);
		const done = await next(20000, item => item.type === 0x01);
		if (!done) throw new PtouchError('unconfirmed');
		if (done.error) throw new PtouchError(done.error);
	} finally {
		open = false;
		await printer.releaseInterface(0).catch(() => {});
		await printer.close().catch(() => {});
		await reader;
	}
}
