/**
 * Builds the A4 buyer poster that hangs by the parts shelf:
 *
 *   bun scripts/build-poster.ts   # writes assets/poster/kjopsplakat-a4.pdf
 *
 * and the showcase slide's picture of it, src/routes/internal/showcase/img/kjopsplakat.jpg.
 *
 * The copy follows the shop's own wording (src/lib/i18n, home.shelf.steps and the
 * checkout buttons); update both together. Print at 100 % / actual size.
 */
import { chromium } from '@playwright/test';
import { writeBarcode } from 'zxing-wasm/writer';

const root = new URL('..', import.meta.url).pathname;
const out = `${root}assets/poster/kjopsplakat-a4.pdf`;
const slide = `${root}src/routes/internal/showcase/img/kjopsplakat.jpg`;
const base64 = async (path: string) => Buffer.from(await Bun.file(root + path).arrayBuffer()).toString('base64');

async function qr(payload: string): Promise<string> {
	const written = await writeBarcode(payload, { format: 'QRCode', options: 'ecLevel=M', addQuietZones: false });
	if (written.error) throw new Error(written.error);
	const size = written.symbol.width;
	return written.svg
		.replace(/<\?xml[^>]*>|<!DOCTYPE[^>]*>/g, '')
		.replace(/width="\d+" height="\d+"/, `viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="${payload}"`);
}

const qrIcon = `<svg viewBox="0 0 256 256" aria-hidden="true"><path fill="currentColor" d="M104,40H56A16,16,0,0,0,40,56v48a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V56A16,16,0,0,0,104,40Zm0,64H56V56h48v48Zm0,32H56a16,16,0,0,0-16,16v48a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V152A16,16,0,0,0,104,136Zm0,64H56V152h48v48ZM200,40H152a16,16,0,0,0-16,16v48a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V56A16,16,0,0,0,200,40Zm0,64H152V56h48v48Zm-64,72V144a8,8,0,0,1,16,0v32a8,8,0,0,1-16,0Zm80-16a8,8,0,0,1-8,8H184v40a8,8,0,0,1-8,8H144a8,8,0,0,1,0-16h24V144a8,8,0,0,1,16,0v8h24A8,8,0,0,1,216,160Zm0,32v16a8,8,0,0,1-16,0V192a8,8,0,0,1,16,0Z"/></svg>`;

const warnIcon = `<svg viewBox="0 0 256 256" aria-hidden="true"><path fill="currentColor" d="M240.26,186.1,152.81,34.23h0a28.74,28.74,0,0,0-49.62,0L15.74,186.1a27.45,27.45,0,0,0,0,27.71A28.31,28.31,0,0,0,40.55,228h174.9a28.31,28.31,0,0,0,24.79-14.19A27.45,27.45,0,0,0,240.26,186.1Zm-20.8,15.7a4.46,4.46,0,0,1-4,2.2H40.55a4.46,4.46,0,0,1-4-2.2,3.56,3.56,0,0,1,0-3.73L124,46.2a4.77,4.77,0,0,1,8,0l87.44,151.87A3.56,3.56,0,0,1,219.46,201.8ZM116,136V104a12,12,0,0,1,24,0v32a12,12,0,0,1-24,0Zm28,40a16,16,0,1,1-16-16A16,16,0,0,1,144,176Z"/></svg>`;

// Viewfinder corners, the same motif as the home page's bracketed label.
const brackets = `<svg class="brackets" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="M0 18V0H18M82 0H100V18M100 82V100H82M18 100H0V82" fill="none" stroke="currentColor" stroke-width="0.8mm" vector-effect="non-scaling-stroke"/></svg>`;

/** Seven-segment readout: unlit 8s behind the lit digits, like the site's Led cells. */
const led = (value: string, label: string, cls = '', ghost = true) =>
	`<span class="led ${cls}" ${label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"'}>${ghost ? `<span class="ghost" aria-hidden="true">${'8'.repeat(value.length)}</span>` : ''}<span aria-hidden="true">${value}</span></span>`;

const html = `<!doctype html>
<html lang="nb">
<head>
<meta charset="utf-8">
<title>Ampoteket: slik kjøper du deler</title>
<style>
	@font-face { font-family: 'Seven Segment'; src: url(data:font/woff2;base64,${await base64('static/fonts/SevenSegment-led.woff2')}) format('woff2'); }
	@page { size: A4; margin: 0; }
	* { box-sizing: border-box; margin: 0; }
	html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
	body { width: 210mm; height: 297mm; display: flex; flex-direction: column;
		font: 12.5pt/1.35 Lato, 'Helvetica Neue', Arial, sans-serif; color: #0f141b; background: #fff; }
	.en { color: #4b586a; font-size: 10.5pt; }
	.mono { font-family: 'DejaVu Sans Mono', monospace; font-weight: 700; }

	/* The sign: black like the LED sign in the window. */
	header { background: #000; color: #fff; padding: 10mm 15mm 9mm; display: grid; grid-template-columns: 1fr auto; gap: 8mm; align-items: center; }
	.wordmark { width: 86mm; display: block; margin-bottom: 5mm; }
	h1 { font-size: 36pt; line-height: 1; font-weight: 900; letter-spacing: -0.02em; }
	header .en { color: #a9b4c2; font-size: 15pt; margin-top: 2mm; }
	.start { text-align: center; }
	.start .tile { background: #fff; padding: 3mm; width: 46mm; }
	.start svg { width: 40mm; height: 40mm; display: block; }
	.start figcaption { margin-top: 3mm; font-size: 14pt; color: #ff3c33; }

	main { padding: 8mm 15mm 5mm; flex: 1; display: flex; flex-direction: column; }
	ol { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 9mm; }
	li { position: relative; display: grid; grid-template-columns: 22mm 1fr 62mm; gap: 7mm; align-items: start; }
	/* The trace from each step cell to the next. */
	li:not(:last-child)::after { content: ''; position: absolute; left: 10.6mm; top: 27mm; bottom: -9mm; width: 0.8mm; background: #c63933; }
	.led { position: relative; display: inline-grid; place-items: center end; background: #000; color: #ff3c33;
		font-family: 'Seven Segment', monospace; line-height: 1; }
	.led > span { grid-area: 1 / 1; }
	.led .ghost { color: #1c1c1c; }
	.step { width: 22mm; height: 27mm; font-size: 54pt; place-items: center; z-index: 1; }
	h2 { font-size: 22pt; line-height: 1.05; font-weight: 900; padding-top: 1mm; }
	h2 + .en { font-size: 13pt; margin-top: 1mm; }
	.text p:not(.en) { margin-top: 2.5mm; }
	.text p.en:last-child { margin-top: 1.5mm; }

	.prop { display: flex; flex-direction: column; align-items: center; gap: 2mm; align-self: center; }
	.btn { display: inline-flex; align-items: center; gap: 2mm; height: 10mm; padding: 0 4mm; white-space: nowrap;
		font-weight: 700; font-size: 11pt; background: #c63933; color: #fff; border-radius: 1.5mm; }
	.finder { position: relative; padding: 2.5mm; color: #4b586a; }
	.brackets { position: absolute; inset: 0; width: 100%; height: 100%; }
	.label { width: 32mm; padding: 2mm; background: #fff; border: 0.2mm solid #c9d1db; display: flex; flex-direction: column; align-items: center;
		font: 700 10pt 'DejaVu Sans Mono', monospace; color: #0f141b; }
	.label svg { width: 22mm; height: 22mm; margin: -1mm 0; }
	.vipps { font-size: 30pt; padding: 1.5mm 2.5mm; letter-spacing: 0.04em; }

	.readout { display: flex; flex-direction: column; align-items: center; gap: 1.5mm; font-weight: 700; font-size: 11pt; }
	.readout .en { font-weight: 400; font-size: 9.5pt; margin-top: -1.5mm; }
	footer { margin: 0 15mm; padding: 5mm 0 8mm; border-top: 0.3mm solid #c9d1db; display: grid; grid-template-columns: 1fr 1fr; gap: 8mm; font-size: 11pt; }
	footer strong { display: flex; align-items: center; gap: 2mm; font-size: 12pt; }
	footer svg { width: 5mm; height: 5mm; flex: none; }
	footer .en { display: block; font-size: 9.5pt; margin-top: 1mm; }
</style>
</head>
<body>
	<header>
		<div>
			<img class="wordmark" alt="Ampoteket" src="data:image/svg+xml;base64,${await base64('static/brand/wordmark.svg')}">
			<h1>Slik kjøper<br>du deler</h1>
			<p class="en">How to buy parts</p>
		</div>
		<figure class="start">
			<div class="tile">${await qr('https://ampoteket.no')}</div>
			<figcaption class="mono">ampoteket.no</figcaption>
		</figure>
	</header>

	<main>
		<ol>
			<li>
				${led('1', 'Steg 1', 'step')}
				<div class="text">
					<h2>Finn delen</h2>
					<p class="en">Find the part</p>
					<p>Trykk «Skann» og hold kameraet mot lappen på skuffen. Du kan også søke etter delen.</p>
					<p class="en">Tap “Scan” and point the camera at the label on the drawer, or search for the part.</p>
				</div>
				<div class="prop">
					<!-- Drawn, not a real QR: a scannable sample would lead buyers to a product that is not on the shelf. -->
					<span class="finder">${brackets}<span class="label" role="img" aria-label="Eksempel på lapp: RES-A3F09, 22 kΩ"><span>RES-A3F09</span>${qrIcon}<span>22 kΩ</span></span></span>
				</div>
			</li>
			<li>
				${led('2', 'Steg 2', 'step')}
				<div class="text">
					<h2>Betal i Vipps</h2>
					<p class="en">Pay in Vipps</p>
					<p>Legg delene i handlekurven og gå til kassen. Betal beløpet som står der.</p>
					<p class="en">Add the parts to your cart and go to checkout. Pay the amount shown there.</p>
				</div>
				<div class="prop">
					<span class="readout">Vippsnummer <span class="en">Vipps number</span><!-- No unlit 8s: they risk a misread of the payment number on a toner print. -->${led('47322', 'Vippsnummer 47322', 'vipps', false)}</span>
				</div>
			</li>
			<li>
				${led('3', 'Steg 3', 'step')}
				<div class="text">
					<h2>Registrer kjøpet</h2>
					<p class="en">Register the purchase</p>
					<p>Kom tilbake og trykk «Jeg har betalt». Da trekkes delene fra lageret, så vi vet når vi må bestille mer.</p>
					<p class="en">Come back and tap “I have paid”. The parts come off stock, so we know when to order more.</p>
				</div>
				<div class="prop">
					<span class="btn">Jeg har betalt, registrer kjøpet</span>
				</div>
			</li>
		</ol>
	</main>

	<footer>
		<p><strong>${warnIcon}Mistet nettet etter at du betalte?</strong>
			Ikke betal på nytt. Åpne handlekurven og fortsett kjøpet der.
			<span class="en">Lost your connection after paying? Don’t pay again. Open the cart and continue the purchase there.</span></p>
		<p><strong>Trenger du hjelp?</strong>
			Spør en frivillig, eller se <span class="mono">ampoteket.no/help</span>.
			<span class="en">Need help? Ask a volunteer, or see ampoteket.no/help.</span></p>
	</footer>
</body>
</html>`;

const browser = await chromium.launch();
try {
	const page = await browser.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 1.5 });
	await page.setContent(html, { waitUntil: 'load' });
	await page.evaluate(() => document.fonts.ready);
	const overflow = await page.evaluate(() => document.body.scrollHeight - document.body.clientHeight);
	if (overflow > 0) throw new Error(`Poster overflows A4 by ${overflow}px; tighten the layout`);
	await page.pdf({ path: out, format: 'A4', printBackground: true, preferCSSPageSize: true });
	await page.screenshot({ path: slide, type: 'jpeg', quality: 85 });
} finally {
	await browser.close();
}
console.log(`Wrote ${out} and ${slide}`);
