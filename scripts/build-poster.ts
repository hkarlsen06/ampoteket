/**
 * Builds the A4 buyer poster that hangs by the parts shelf:
 *
 *   bun scripts/build-poster.ts   # writes assets/poster/kjopsplakat-a4.pdf
 *
 * The copy follows the shop's own wording (src/lib/i18n, home.shelf.steps and the
 * checkout buttons); update both together. Print at 100 % / actual size.
 */
import { chromium } from '@playwright/test';
import { writeBarcode } from 'zxing-wasm/writer';

const root = new URL('..', import.meta.url).pathname;
const out = `${root}assets/poster/kjopsplakat-a4.pdf`;
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

const led = (n: string) => `<span class="led" aria-label="Steg ${n}"><span class="ghost" aria-hidden="true">8</span><span aria-hidden="true">${n}</span></span>`;

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
	body { width: 210mm; height: 297mm; padding: 14mm 15mm 12mm; display: flex; flex-direction: column;
		font: 12.5pt/1.4 Lato, 'Helvetica Neue', Arial, sans-serif; color: #0f141b; background: #fff; }
	.en { color: #4b586a; font-size: 10.5pt; margin-top: 1.2mm; }
	header { display: flex; justify-content: space-between; align-items: flex-start; gap: 10mm; }
	.wordmark { width: 92mm; display: block; margin-bottom: 7mm; }
	h1 { font-size: 34pt; line-height: 1.02; font-weight: 900; letter-spacing: -0.02em; }
	header .en { font-size: 16pt; margin-top: 2mm; }
	.start { width: 46mm; text-align: center; }
	.start svg { width: 46mm; height: 46mm; display: block; }
	.start figcaption { margin-top: 2mm; font-weight: 700; font-size: 11pt; }
	.start .url { font-family: 'DejaVu Sans Mono', monospace; font-size: 13pt; font-weight: 700; display: block; }
	ol { list-style: none; padding: 0; margin-top: 9mm; display: flex; flex-direction: column; gap: 8mm; }
	li { display: grid; grid-template-columns: 19mm 1fr auto; gap: 6mm; align-items: start; }
	.led { position: relative; display: grid; place-items: center; width: 19mm; height: 23mm; background: #000;
		font: 46pt/1 'Seven Segment', monospace; color: #ff3c33; }
	.led > span { grid-area: 1 / 1; }
	.led .ghost { color: #1c1c1c; }
	h2 { font-size: 19pt; line-height: 1.1; font-weight: 900; }
	h2 .en { display: block; font-size: 12pt; font-weight: 400; margin-top: 0.8mm; }
	li p:not(.en) { margin-top: 2.5mm; max-width: 98mm; }
	li .en { max-width: 98mm; }
	.ui { display: flex; flex-direction: column; align-items: flex-end; gap: 2.5mm; padding-top: 1mm; }
	.btn { display: inline-flex; align-items: center; gap: 2mm; height: 10mm; padding: 0 4mm; white-space: nowrap;
		font-weight: 700; font-size: 11pt; background: #c63933; color: #fff; }
	.btn.outline { background: #fff; color: #0f141b; border: 0.35mm solid #c9d1db; }
	.btn svg { width: 5mm; height: 5mm; }
	.arrow { color: #4b586a; font-size: 13pt; line-height: 1; padding-right: 4mm; }
	.label { width: 34mm; padding: 2mm; border: 0.2mm dashed #c9d1db; display: flex; flex-direction: column; align-items: center;
		font-size: 10pt; font-family: 'DejaVu Sans Mono', monospace; }
	.label svg { width: 24mm; height: 24mm; margin: -1.5mm 0; }
	.vipps { text-align: right; font-weight: 700; font-size: 10.5pt; }
	.vipps b { display: block; font: 26pt/1 'Seven Segment', monospace; color: #c63933; letter-spacing: 0.04em; margin-top: 1mm; }
	footer { margin-top: auto; padding-top: 5mm; border-top: 0.3mm solid #c9d1db; display: grid; grid-template-columns: 1fr 1fr; gap: 8mm; font-size: 11pt; }
	footer strong { display: block; font-size: 12pt; }
	footer .en { font-size: 9.5pt; }
	.url-inline { font-family: 'DejaVu Sans Mono', monospace; font-weight: 700; }
</style>
</head>
<body>
	<header>
		<div>
			<img class="wordmark" alt="Ampoteket" src="data:image/svg+xml;base64,${await base64('static/brand/wordmark-light.svg')}">
			<h1>Slik kjøper<br>du deler</h1>
			<p class="en">How to buy parts</p>
		</div>
		<figure class="start">
			${await qr('https://ampoteket.no')}
			<figcaption>Start her <span class="url">ampoteket.no</span></figcaption>
		</figure>
	</header>

	<ol>
		<li>
			${led('1')}
			<div>
				<h2>Finn delen <span class="en">Find the part</span></h2>
				<p>Åpne ampoteket.no, trykk «Skann» og hold kameraet mot lappen på skuffen. Du kan også søke etter delen eller skrive inn koden.</p>
				<p class="en">Open ampoteket.no, tap “Scan” and point the camera at the label on the drawer. You can also search or type the code.</p>
			</div>
			<div class="ui">
				<span class="btn outline">${qrIcon}Skann</span>
				<!-- Drawn, not a real QR: a scannable sample would lead buyers to a product that is not on the shelf. -->
				<span class="label" role="img" aria-label="Eksempel på lapp: RES-A3F09, 22 kΩ"><span>RES-A3F09</span>${qrIcon}<span>22 kΩ</span></span>
			</div>
		</li>
		<li>
			${led('2')}
			<div>
				<h2>Betal i Vipps <span class="en">Pay in Vipps</span></h2>
				<p>Legg delene i handlekurven og trykk «Gå til kassen». Betal beløpet som står der i Vipps.</p>
				<p class="en">Add the parts to your cart and tap “Go to checkout”. Pay the amount shown there in Vipps.</p>
			</div>
			<div class="ui">
				<span class="btn">Legg i handlekurven</span>
				<span class="arrow" aria-hidden="true">↓</span>
				<span class="btn">Gå til kassen</span>
				<p class="vipps">Vippsnummer <b>47322</b></p>
			</div>
		</li>
		<li>
			${led('3')}
			<div>
				<h2>Registrer kjøpet <span class="en">Register the purchase</span></h2>
				<p>Kom tilbake til siden og trykk «Jeg har betalt». Da trekkes delene fra lageret, så vi ser når vi må bestille mer.</p>
				<p class="en">Come back to the page and tap “I have paid”. The parts are taken off stock, so we know when to order more.</p>
			</div>
			<div class="ui">
				<span class="btn">Jeg har betalt, registrer kjøpet</span>
			</div>
		</li>
	</ol>

	<footer>
		<p><strong>Mistet du nettet etter at du betalte?</strong>
			Gå til handlekurven og fortsett kjøpet der. Ikke betal på nytt.
			<span class="en" style="display:block">Lost your connection after paying? Open the cart and continue the purchase there. Don’t pay again.</span></p>
		<p><strong>Trenger du hjelp?</strong>
			Spør en frivillig, eller se <span class="url-inline">ampoteket.no/help</span>.
			<span class="en" style="display:block">Need help? Ask a volunteer, or see ampoteket.no/help.</span></p>
	</footer>
</body>
</html>`;

const browser = await chromium.launch();
try {
	const page = await browser.newPage();
	await page.setContent(html, { waitUntil: 'load' });
	await page.evaluate(() => document.fonts.ready);
	await page.pdf({ path: out, format: 'A4', printBackground: true, preferCSSPageSize: true });
	if (process.argv.includes('--png')) {
		await page.setViewportSize({ width: 794, height: 1123 });
		await page.screenshot({ path: '/tmp/kjopsplakat-a4.png', fullPage: true });
	}
} finally {
	await browser.close();
}
console.log(`Wrote ${out}`);
