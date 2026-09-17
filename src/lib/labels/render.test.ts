import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PDFDocument, PDFName, PDFDict } from 'pdf-lib';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import wasmUrl from 'zxing-wasm/writer/zxing_writer.wasm?url';
import fontUrl from './Lato-Regular.ttf?url';
import { LabelRenderError, prepareLabels, type LabelInput, type LabelSettings, type LabelRenderErrorKind } from './render';
import { proportionalLabelSettings } from './settings';
import { productCodeFromQr } from '../scanner/payload';

const settings: LabelSettings = { width: 45, height: 45, margin: 10, gap: 2, copies: 1, qrSize: 25, fontSize: 8, cutGuides: true };
const product = { id: 'one', code: 'RES-00001', lines: ['4,7 kΩ · ±1 %', 'Blå 22 µF · æøå ÆØÅ'] };
const originalFetch = globalThis.fetch;
let corruptAsset = false;
let slowAssets = false;
const pendingSignals: AbortSignal[] = [];
let assetRequests = 0;
beforeAll(async () => {
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		if (input === wasmUrl || input === fontUrl) {
			assetRequests++;
			if (slowAssets) return new Promise<Response>((_resolve, reject) => {
				const signal = init!.signal!;
				pendingSignals.push(signal);
				const abort = () => reject(new DOMException('Interrupted test asset', 'AbortError'));
				if (signal.aborted) abort();
				else signal.addEventListener('abort', abort, { once: true });
			});
			return new Response(corruptAsset ? new Uint8Array([0]) : await Bun.file(String(input)).arrayBuffer());
		}
		return originalFetch(input, init);
	}) as typeof fetch;
	await prepareZXingModule({ fireImmediately: true, overrides: { wasmBinary:
		new Uint8Array(await Bun.file('node_modules/zxing-wasm/dist/reader/zxing_reader.wasm').arrayBuffer()) } });
});
afterAll(() => { globalThis.fetch = originalFetch; });

function svgFromUrl(url: string) { return decodeURIComponent(url.slice(url.indexOf(',') + 1)); }

describe('physical label export', () => {
	test('rejects invalid geometry, empty selection and excessive workload before loading assets', async () => {
		const initial = assetRequests;
		for (const patch of [{ width: NaN }, { height: 300 }, { margin: 0 }, { copies: 1.5 },
			{ gap: -1 }, { qrSize: 13 }, { qrSize: 44 }, { fontSize: 6 }, { width: 200, margin: 50 }]) {
			await expect(prepareLabels([product], { ...settings, ...patch })).rejects.toMatchObject({ kind: 'settings' });
		}
		await expect(prepareLabels([], settings)).rejects.toMatchObject({ kind: 'empty' });
		await expect(prepareLabels(Array(21).fill(product), { ...settings, copies: 100 })).rejects.toMatchObject({ kind: 'limit' });
		await expect(prepareLabels([product], settings, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
		expect(assetRequests).toBe(initial);
	});

	test('checks local asset hashes and rejects mismatched assets', async () => {
		corruptAsset = true;
		await expect(prepareLabels([product], settings)).rejects.toBeInstanceOf(LabelRenderError);
		corruptAsset = false;
	});

	test('immediately cancels slow first-load requests and retries with fresh assets', async () => {
		const initial = assetRequests;
		slowAssets = true;
		const controller = new AbortController();
		const promise = prepareLabels([product], settings, controller.signal);
		expect(pendingSignals).toHaveLength(2);
		controller.abort();
		let timer: ReturnType<typeof setTimeout>;
		try {
			const deadline = new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error('Cancellation waited for the asset timeout')), 500);
			});
			await expect(Promise.race([promise, deadline])).rejects.toMatchObject({ name: 'AbortError' });
		} finally { clearTimeout(timer!); slowAssets = false; }
		expect(pendingSignals.every((signal) => signal.aborted)).toBe(true);
		const prepared = await prepareLabels([product], settings);
		expect(prepared.labels).toHaveLength(1);
		expect(prepared.totalLabels).toBe(1);
		expect(assetRequests - initial).toBe(4);
	});

	test('round trips the exported QR through the real decoder and preserves the compact two-module blank border', async () => {
		const settings: LabelSettings = { ...proportionalLabelSettings(45), copies: 1 };
		const prepared = await prepareLabels([{ ...product, lines: ['Resistans: 4,7 kΩ'] }], settings);
		const svg = svgFromUrl(prepared.labels[0].svgUrl);
		expect(prepared.labels[0].height).toBeLessThan(47);
		expect(svg).toContain(`width="45mm" height="${prepared.labels[0].height}mm"`);
		expect(svg).toContain('Resistans: 4,7 kΩ');
		expect(svg).not.toContain('<text'); // Actual licensed glyph outlines, no browser substitution.
		const qr = /<path id="qr" d="([^"]+)" transform="translate\([^)]*\) scale\(([^)]+)\)"\/>/.exec(svg)!;
		expect(qr).not.toBeNull();
		const modules = Math.round(settings.qrSize / Number(qr[2]));
		const pixelScale = 8;
		const width = modules * pixelScale;
		const data = new Uint8ClampedArray(width * width * 4).fill(255);
		let left = modules, right = 0, top = modules, bottom = 0;
		for (const match of qr[1].matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
			const col = Number(match[1]), row = Number(match[2]);
			left = Math.min(left, col); right = Math.max(right, col);
			top = Math.min(top, row); bottom = Math.max(bottom, row);
			for (let y = row * pixelScale; y < (row + 1) * pixelScale; y++) {
				for (let x = col * pixelScale; x < (col + 1) * pixelScale; x++) {
					const at = (y * width + x) * 4;
					data[at] = data[at + 1] = data[at + 2] = 0;
				}
			}
		}
		expect([left, top, modules - right - 1, modules - bottom - 1]).toEqual([2, 2, 2, 2]);
		const decoded = await readBarcodes({ data, width, height: width, colorSpace: 'srgb' }, { formats: ['QRCode'] });
		expect(decoded).toHaveLength(1);
		expect(decoded[0].text).toBe('ampoteket.no/p/RES-00001');
		expect(productCodeFromQr(decoded[0].text)).toBe(product.code);
	});

	test('scales the compact layout proportionally at the supported width limits', async () => {
		for (const width of [32, 45, 81]) {
			const dimensions = proportionalLabelSettings(width);
			const prepared = await prepareLabels([{ ...product, lines: ['Resistans: 2,7 MΩ'] }], { ...dimensions, copies: 1 });
			expect(prepared.labels).toHaveLength(1);
			expect(dimensions.height / width).toBeCloseTo(47 / 45);
			expect(dimensions.fontSize / width).toBeCloseTo(10 / 45);
		}
	});

	test('wraps long specifications and grows only affected labels without shrinking or truncation', async () => {
		const long = 'Package: ' + 'Wide LED package with integrated resistor '.repeat(5);
		const prepared = await prepareLabels([
			{ ...product, lines: ['Resistance: 1 kΩ'] },
			{ id: 'led', code: 'LED-00091', lines: [long, 'W'.repeat(100)] }
		], { ...proportionalLabelSettings(45), copies: 1 });
		expect(prepared.labels).toHaveLength(2);
		expect(prepared.labels[0].height).toBeLessThan(47);
		expect(prepared.labels[1].height).toBeGreaterThan(47);
		const svg = svgFromUrl(prepared.labels[1].svgUrl);
		expect(svg).toContain(long);
		expect(svg).toContain('W'.repeat(100));
		expect([...svg.matchAll(/<path/g)].length).toBeGreaterThan(4);
		const pdf = await PDFDocument.load(prepared.pdfBytes);
		expect(pdf.getPageCount()).toBe(prepared.pages);
	});

	test('builds actual A4 PDF pages with exact pagination, copies and disabled viewer print scaling', async () => {
		const labels = Array.from({ length: 21 }, (_, index) => ({ ...product, id: `id-${index}`, code: `RES-${index.toString().padStart(5, '0')}` }));
		const prepared = await prepareLabels(labels, { ...settings, copies: 2 });
		expect(prepared.labels).toHaveLength(21);
		expect(prepared.totalLabels).toBe(42);
		expect([prepared.columns, prepared.rows, prepared.pages]).toEqual([4, 5, 3]);
		const pdf = await PDFDocument.load(prepared.pdfBytes);
		expect(pdf.getPageCount()).toBe(3);
		for (const page of pdf.getPages()) {
			expect(page.getWidth()).toBeCloseTo(210 * 72 / 25.4, 8);
			expect(page.getHeight()).toBeCloseTo(297 * 72 / 25.4, 8);
			expect(page.node.Annots()?.size() ?? 0).toBe(0); // QR payload is not a PDF link.
		}
		expect(pdf.catalog.lookup(PDFName.of('ViewerPreferences'), PDFDict).get(PDFName.of('PrintScaling'))).toEqual(PDFName.of('None'));
	});

	test('rejects unsupported characters, overlong codes/specifications and insufficient physical QR or label area explicitly', async () => {
		const cases: [LabelInput, Partial<LabelSettings>, LabelRenderErrorKind][] = [
			[{ ...product, code: 'foreign/code' }, {}, 'code'],
			[{ ...product, lines: ['Unsupported 🧑'] }, {}, 'character'],
			[{ ...product, lines: ['W'.repeat(401)] }, {}, 'overflow'],
			[{ ...product, lines: Array(12).fill('Line') }, {}, 'overflow'],
			[product, { height: 25 }, 'overflow']
		];
		for (const [input, patch, kind] of cases) {
			await expect(prepareLabels([input], { ...settings, ...patch })).rejects.toMatchObject({ kind, code: input.code });
		}
		const escaped = await prepareLabels([{ ...product, lines: ['A < B & C > D'] }], settings);
		expect(svgFromUrl(escaped.labels[0].svgUrl)).toContain('A &lt; B &amp; C &gt; D');
	});

	test('cancels a large export between batches rather than handing out a partial PDF', async () => {
		const controller = new AbortController();
		const promise = prepareLabels(Array.from({ length: 1000 }, (_, i) => ({ ...product, id: `${i}` })), settings, controller.signal);
		setTimeout(() => controller.abort(), 0);
		await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
	});
});
