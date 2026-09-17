/** Client-only, lazy-loaded label export. All geometry is in millimetres;
 * fontSize is points. Preview and PDF consume the very same vector paths. */
import fontkit, { type Font, type Path } from '@pdf-lib/fontkit';
import { PDFDocument, rgb } from 'pdf-lib';
import { prepareZXingModule, writeBarcode, ZXING_WASM_SHA256 } from 'zxing-wasm/writer';
import wasmUrl from 'zxing-wasm/writer/zxing_writer.wasm?url';
import fontUrl from './Lato-Regular.ttf?url';
import { productCodeFromQr } from '../scanner/payload';

export type LabelInput = { id: string; code: string; lines: string[] };
export type LabelSettings = {
	width: number; height: number; margin: number; gap: number; copies: number;
	qrSize: number; fontSize: number; cutGuides?: boolean; autoHeight?: boolean;
};
export type PreparedLabels = {
	labels: { id: string; code: string; svgUrl: string; height: number }[];
	totalLabels: number; pages: number; columns: number; rows: number;
	pdfBytes: Uint8Array<ArrayBuffer>;
};
export type LabelRenderErrorKind = 'settings' | 'empty' | 'limit' | 'code' | 'overflow' | 'character' | 'asset' | 'qr';
export class LabelRenderError extends Error {
	constructor(public kind: LabelRenderErrorKind, public code?: string, public characters?: string) {
		super(`Label export: ${kind}`); this.name = 'LabelRenderError';
	}
}

const pointsPerMm = 72 / 25.4;
const fontSha256 = '6f6940be0835c3ddec9199e5fc42be4cbc61ebcfd58c623fdf719366253f1780';
const padding = 0.75;
const sectionGap = 0.25;
const textQrGap = 0.75;
const quietModules = 2;
const maxLabels = 2000;
let resources: Font | undefined;

function cancelled(signal?: AbortSignal) {
	if (signal?.aborted) throw new DOMException('Label export cancelled', 'AbortError');
}

async function asset(url: string, expectedDigest: string, signal: AbortSignal): Promise<ArrayBuffer> {
	const response = await fetch(url, { credentials: 'omit', redirect: 'error', signal });
	if (!response.ok) throw new LabelRenderError('asset');
	const binary = await response.arrayBuffer();
	const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', binary)),
		(byte) => byte.toString(16).padStart(2, '0')).join('');
	if (digest !== expectedDigest) throw new LabelRenderError('asset');
	return binary;
}

async function loadResources(signal?: AbortSignal): Promise<Font> {
	if (resources) return resources;
	// Cache only completed initialization. A cancelled first attempt must not
	// leave its rejected/pending promise attached to an immediate retry.
	const controller = new AbortController();
	const abort = () => controller.abort();
	signal?.addEventListener('abort', abort, { once: true });
	if (signal?.aborted) abort();
	// Both requests start together and each remains bounded by 15 seconds.
	const timer = setTimeout(abort, 15000);
	try {
		const [wasm, font] = await Promise.all([
			asset(wasmUrl, ZXING_WASM_SHA256, controller.signal), asset(fontUrl, fontSha256, controller.signal)
		]);
		cancelled(controller.signal);
		await prepareZXingModule({ fireImmediately: true, overrides: {
			wasmBinary: wasm,
			locateFile: (path: string) => {
				if (path === 'zxing_writer.wasm') return wasmUrl;
				throw new LabelRenderError('asset');
			}
		} });
		cancelled(controller.signal);
		resources = fontkit.create(new Uint8Array(font));
		return resources;
	} catch {
		cancelled(signal);
		throw new LabelRenderError('asset');
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', abort);
		abort(); // Also cancels the sibling request if one asset failed early.
	}
}

function sheet(settings: LabelSettings, count: number) {
	const { width, height, margin, gap, copies, qrSize, fontSize } = settings;
	if (![width, height, margin, gap, copies, qrSize, fontSize].every(Number.isFinite)
		|| width < 15 || width > 200 || height < 20 || height > 287
		|| margin < 5 || margin > 50 || gap < 0 || gap > 20
		|| !Number.isInteger(copies) || copies < 1 || copies > 100
		|| qrSize < 14 || qrSize > 100 || qrSize > width - 2 * padding * width / 45
		|| fontSize < 7 || fontSize > 18) throw new LabelRenderError('settings');
	if (!count) throw new LabelRenderError('empty');
	if (count * copies > maxLabels) throw new LabelRenderError('limit');
	const columns = Math.floor((210 - 2 * margin + gap) / (width + gap));
	const rows = Math.floor((297 - 2 * margin + gap) / (height + gap));
	if (columns < 1 || rows < 1) throw new LabelRenderError('settings');
	return { columns, rows, totalLabels: count * copies, pages: Math.ceil(count * copies / (columns * rows)) };
}

// Fontkit's transform method creates a new path; it does not mutate cached
// glyph outlines. Its runtime API is missing this method in the shipped types.
type TransformablePath = Path & { transform(a: number, b: number, c: number, d: number, x: number, y: number): Path };
type Ink = { path: string; width: number; height: number };

function textInk(font: Font, text: string, fontSize: number, code: string): Ink {
	const missing = [...new Set([...text].filter((character) =>
		!font.hasGlyphForCodePoint(character.codePointAt(0)!)))].join('');
	if (missing) throw new LabelRenderError('character', code, missing);
	const run = font.layout(text);
	const scale = fontSize / pointsPerMm / font.unitsPerEm;
	const bounds = run.bbox;
	// Whitespace-only lines have no ink. They remain blank, occupying one line.
	if (!Number.isFinite(bounds.minX)) return { path: '', width: 0, height: fontSize / pointsPerMm };
	let x = 0, y = 0;
	const paths = run.glyphs.map((glyph, index) => {
		const position = run.positions[index];
		const path = (glyph.path as TransformablePath).transform(scale, 0, 0, -scale,
			(x + position.xOffset - bounds.minX) * scale,
			(bounds.maxY - y - position.yOffset) * scale).toSVG();
		x += position.xAdvance; y += position.yAdvance;
		return path;
	});
	return { path: paths.join(''), width: bounds.width * scale, height: bounds.height * scale };
}

function escapeXml(value: string) {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/** Wrap at whitespace where possible, and split oversized words without
 * dropping characters or shrinking the chosen font. */
function wrapped(font: Font, value: string, fontSize: number, width: number, code: string): string[] {
	const lines: string[] = [];
	let remaining = value.normalize('NFC');
	while (remaining) {
		const characters = [...remaining];
		let low = 1, high = characters.length, fit = 0;
		while (low <= high) {
			const middle = Math.floor((low + high) / 2);
			if (textInk(font, characters.slice(0, middle).join(''), fontSize, code).width <= width) {
				fit = middle; low = middle + 1;
			} else high = middle - 1;
		}
		if (!fit) throw new LabelRenderError('overflow', code);
		if (fit < characters.length) {
			const space = characters.slice(0, fit + 1).findLastIndex(character => /\s/u.test(character));
			if (space > 0) fit = space;
		}
		lines.push(characters.slice(0, fit).join(''));
		remaining = characters.slice(fit).join('').trimStart();
	}
	return lines;
}

type Vector = { path: string; x: number; y: number; scale: number; qr?: boolean };

async function labelVectors(label: LabelInput, settings: LabelSettings, font: Font): Promise<{ vectors: Vector[]; height: number }> {
	const { width, fontSize, qrSize } = settings;
	const height = settings.autoHeight ? 297 - 2 * settings.margin : settings.height;
	const scale = width / 45;
	const inset = padding * scale, lineGap = sectionGap * scale, qrGap = textQrGap * scale;
	const payload = `ampoteket.no/p/${label.code}`;
	if (productCodeFromQr(payload) !== label.code) throw new LabelRenderError('code', label.code);
	if (label.lines.length > 12 || label.lines.some((line) => line.length > 400)) throw new LabelRenderError('overflow', label.code);
	const vectors: Vector[] = [];
	let top = inset;
	function line(text: string) {
		const ink = textInk(font, text.normalize('NFC'), fontSize, label.code);
		if (ink.width > width - 2 * inset || top + ink.height > height - inset) {
			throw new LabelRenderError('overflow', label.code);
		}
		vectors.push({ path: ink.path, x: (width - ink.width) / 2, y: top, scale: 1 });
		top += ink.height + lineGap;
	}
	line(label.code);
	const written = await writeBarcode(payload, { format: 'QRCode', options: 'ecLevel=M', addQuietZones: true });
	if (written.error || !written.symbol.width || written.symbol.width !== written.symbol.height) throw new LabelRenderError('qr', label.code);
	const { data, width: modules } = written.symbol;
	// The writer's symbol is the bare one-channel matrix, independent of its
	// SVG quiet-zone option. Use the compact two-module border requested for these labels.
	const moduleSize = qrSize / (modules + 2 * quietModules);
	// Position text relative to the visible modules, not the blank SVG border.
	const blankBorder = quietModules * moduleSize;
	top += qrGap - lineGap - blankBorder;
	if (moduleSize < 0.35 || top + qrSize - blankBorder > height - inset) throw new LabelRenderError('overflow', label.code);
	const squares: string[] = [];
	for (let row = 0; row < modules; row++) for (let col = 0; col < modules; col++) {
		if (data[row * modules + col] === 0) squares.push(`M${col + quietModules} ${row + quietModules}h1v1h-1z`);
	}
	vectors.push({ path: squares.join(''), x: (width - qrSize) / 2, y: top, scale: moduleSize, qr: true });
	top += qrSize - blankBorder + qrGap;
	for (const value of label.lines) for (const text of wrapped(font, value, fontSize, width - 2 * inset, label.code)) line(text);
	const contentHeight = top - (label.lines.some(value => value.trim()) ? lineGap : qrGap) + inset;
	return { vectors, height: settings.autoHeight ? contentHeight : settings.height };
}

export async function prepareLabels(labels: LabelInput[], settings: LabelSettings, signal?: AbortSignal): Promise<PreparedLabels> {
	cancelled(signal);
	sheet(settings, labels.length);
	// A caller may keep editing controls while work is pending. Export one
	// immutable snapshot rather than mixing settings or specifications mid-file.
	settings = { ...settings };
	labels = labels.map((label) => ({ ...label, lines: [...label.lines] }));
	const font = await loadResources(signal);
	cancelled(signal);
	const layouts: { vectors: Vector[]; height: number }[] = [];
	for (const [index, label] of labels.entries()) {
		cancelled(signal);
		layouts.push(await labelVectors(label, settings, font));
		if (index % 8 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	cancelled(signal);
	const grid = sheet({ ...settings, height: Math.max(...layouts.map(layout => layout.height)) }, labels.length);
	const rowHeight = Math.max(...layouts.map(layout => layout.height));
	const pdf = await PDFDocument.create();
	pdf.setTitle('Ampoteket');
	pdf.setCreator('Ampoteket');
	pdf.catalog.set(pdf.context.obj('ViewerPreferences'), pdf.context.obj({ PrintScaling: 'None' }));
	const previews: PreparedLabels['labels'] = [];
	let sheetIndex = 0;
	const black = rgb(0, 0, 0);
	for (const [labelIndex, label] of labels.entries()) {
		cancelled(signal);
		const { vectors, height } = layouts[labelIndex];
		cancelled(signal);
		const paths = vectors.map((vector) => `<path${vector.qr ? ' id="qr"' : ''} d="${vector.path}" transform="translate(${vector.x} ${vector.y}) scale(${vector.scale})"/>`).join('');
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${settings.width}mm" height="${height}mm" viewBox="0 0 ${settings.width} ${height}"><title>${escapeXml([label.code, ...label.lines].join(' · '))}</title><rect width="100%" height="100%" fill="white"/><g fill="black">${paths}</g></svg>`;
		previews.push({ id: label.id, code: label.code, height, svgUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` });
		for (let copy = 0; copy < settings.copies; copy++, sheetIndex++) {
			const cell = sheetIndex % (grid.columns * grid.rows);
			const page = cell === 0 ? pdf.addPage([210 * pointsPerMm, 297 * pointsPerMm]) : pdf.getPages().at(-1)!;
			const x = settings.margin + (cell % grid.columns) * (settings.width + settings.gap);
			const y = settings.margin + Math.floor(cell / grid.columns) * (rowHeight + settings.gap);
			for (const vector of vectors) if (vector.path) page.drawSvgPath(vector.path, {
				x: (x + vector.x) * pointsPerMm, y: (297 - y - vector.y) * pointsPerMm,
				scale: vector.scale * pointsPerMm, color: black
			});
		}
		// Yield between small batches so navigation/cancellation stays responsive
		// even when an entire workshop (up to 2,000 labels) is exported.
		if (labelIndex % 8 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	if (settings.cutGuides) for (const [pageIndex, page] of pdf.getPages().entries()) {
		const count = Math.min(grid.columns * grid.rows, grid.totalLabels - pageIndex * grid.columns * grid.rows);
		const columns = Math.min(grid.columns, count), rows = Math.ceil(count / grid.columns);
		const left = settings.margin, top = settings.margin;
		const right = left + columns * settings.width + (columns - 1) * settings.gap;
		const bottom = top + rows * rowHeight + (rows - 1) * settings.gap;
		function cut(x1: number, y1: number, x2: number, y2: number) {
			page.drawLine({ start: { x: x1 * pointsPerMm, y: (297 - y1) * pointsPerMm },
				end: { x: x2 * pointsPerMm, y: (297 - y2) * pointsPerMm },
				color: rgb(0.55, 0.55, 0.55), thickness: 0.25, dashArray: [1, 2] });
		}
		// One shared cut halfway through each gutter, plus the outer sheet edges.
		for (let col = 0; col <= columns; col++) {
			const x = col === 0 ? left : col === columns ? right : left + col * (settings.width + settings.gap) - settings.gap / 2;
			cut(x, top, x, bottom);
		}
		for (let row = 0; row <= rows; row++) {
			const y = row === 0 ? top : row === rows ? bottom : top + row * (rowHeight + settings.gap) - settings.gap / 2;
			cut(left, y, right, y);
		}
	}

	cancelled(signal);
	const bytes = await pdf.save();
	cancelled(signal);
	return { labels: previews, ...grid, pdfBytes: new Uint8Array(bytes) };
}

export type TapeBitmap = { width: number; height: number; ink: Uint8Array };
const tapePxPerMm = 180 / 25.4;

/** P-touch tape label at 180 dpi: code → QR → specifications, stacked across the
 * tape's printable dots (`pins`). Sizes follow the owner-accepted 18 mm print
 * (2026-09-24): 14-dot text, 2 dots between text and QR modules. One byte per
 * dot (1 = ink), row-major; each row is one raster line along the tape. */
export async function prepareTapeLabel(label: LabelInput, pins: number, signal?: AbortSignal): Promise<TapeBitmap> {
	const font = await loadResources(signal);
	cancelled(signal);
	const payload = `ampoteket.no/p/${label.code}`;
	if (productCodeFromQr(payload) !== label.code) throw new LabelRenderError('code', label.code);
	if (label.lines.length > 12 || label.lines.some((line) => line.length > 400)) throw new LabelRenderError('overflow', label.code);
	const written = await writeBarcode(payload, { format: 'QRCode', options: 'ecLevel=M' });
	if (written.error || !written.symbol.width || written.symbol.width !== written.symbol.height) throw new LabelRenderError('qr', label.code);
	const { data, width: modules } = written.symbol;
	// One blank module is printed at each side; the unprinted tape edge completes
	// the two-module border used by the sheet labels.
	const module = Math.floor(pins / (modules + quietModules));
	if (module / tapePxPerMm < 0.35) throw new LabelRenderError('overflow', label.code);
	const inset = 1, gap = 2, lead = 3, fontSize = 14 / tapePxPerMm * pointsPerMm;
	const maxWidth = (pins - 2 * inset) / tapePxPerMm;
	const texts = [label.code, ...label.lines.flatMap(value => wrapped(font, value, fontSize, maxWidth, label.code))]
		.map(text => textInk(font, text, fontSize, label.code));
	if (texts.some(ink => ink.width > maxWidth)) throw new LabelRenderError('overflow', label.code);
	const [code, ...lines] = texts.map(ink => ({ ...ink, rows: Math.ceil(ink.height * tapePxPerMm) }));
	const qrTop = inset + code.rows + gap, qrRows = modules * module;
	const height = qrTop + qrRows + (lines.length ? gap + lines.reduce((sum, ink) => sum + ink.rows + lead, -lead) : 0) + inset;
	const canvas = new OffscreenCanvas(pins, height);
	const context = canvas.getContext('2d');
	if (!context) throw new LabelRenderError('asset');
	context.fillStyle = 'white'; context.fillRect(0, 0, pins, height); context.fillStyle = 'black';
	function place(ink: Ink, top: number) {
		context!.setTransform(tapePxPerMm, 0, 0, tapePxPerMm, (pins - ink.width * tapePxPerMm) / 2, top);
		if (ink.path) context!.fill(new Path2D(ink.path));
	}
	place(code, inset);
	let top = qrTop + qrRows + gap;
	for (const ink of lines) { place(ink, top); top += ink.rows + lead; }
	context.setTransform(1, 0, 0, 1, 0, 0);
	const left = Math.floor((pins - qrRows) / 2);
	for (let row = 0; row < modules; row++) for (let col = 0; col < modules; col++) {
		if (data[row * modules + col] === 0) context.fillRect(left + col * module, qrTop + row * module, module, module);
	}
	const pixels = context.getImageData(0, 0, pins, height).data;
	const ink = new Uint8Array(pins * height);
	// A quarter coverage counts as ink, so thin strokes such as the code's hyphen survive.
	for (let index = 0; index < ink.length; index++) ink[index] = pixels[index * 4] < 192 ? 1 : 0;
	return { width: pins, height, ink };
}
