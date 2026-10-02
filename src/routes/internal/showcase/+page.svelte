<script lang="ts">
	// Meeting showcase (2026-10-01), Norwegian only and outside the locale routes on
	// purpose: it is a presentation, not part of the shop. The devices show the real
	// components rendered from sample data (./fixtures.ts), so nothing here needs the
	// network. A fixed 1600×900 stage scales to the window. What recurs across slides
	// (shelf, phone, step counter, admin window, background glow) stays on stage and
	// changes in place; only each slide's own text fades and rises in.
	import { mount, onMount, unmount } from 'svelte';
	import { Tween } from 'svelte/motion';
	import { cubicOut } from 'svelte/easing';
	import { fade, fly } from 'svelte/transition';
	import Led from '#lib/Led.svelte';
	import Icon from '#lib/Icon.svelte';
	import ShelfDiagram from '#lib/ShelfDiagram.svelte';
	import ProductIdentity from '#lib/ProductIdentity.svelte';
	import StateBadge from '#lib/StateBadge.svelte';
	import SalesChart from '#lib/SalesChart.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { messagesFor, setI18n } from '#lib/i18n/index.js';
	import { cabinetInner } from '#lib/shelf-map.js';
	import { formatMoney, gridCell, gridRange } from '#lib/format.js';
	import { proportionalLabelSettings } from '#lib/labels/settings.js';
	import type { TapeBitmap } from '#lib/labels/render.js';
	import CaretLeftIcon from 'phosphor-svelte/lib/CaretLeftIcon';
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon';
	import CornersInIcon from 'phosphor-svelte/lib/CornersInIcon';
	import CornersOutIcon from 'phosphor-svelte/lib/CornersOutIcon';
	import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircleIcon';
	import SealWarningIcon from 'phosphor-svelte/lib/SealWarningIcon';
	import ArrowsClockwiseIcon from 'phosphor-svelte/lib/ArrowsClockwiseIcon';
	import SnowflakeIcon from 'phosphor-svelte/lib/SnowflakeIcon';
	import QrCodeIcon from 'phosphor-svelte/lib/QrCodeIcon';
	import * as data from './fixtures';
	import Phone from './Phone.svelte';
	import poster from './img/kjopsplakat.jpg';
	import printer from './img/printer.webp';
	import qr from './img/qr.svg';

	// The components read the same context the locale layout gives them.
	const i18n = setI18n({ locale: 'nb', m: messagesFor('nb'), href: (path: string) => path });

	const W = 1600, H = 900;
	const MIRROR = 2, LABEL = 3, FIND = 5, REGISTER = 8, OVERVIEW = 10, LABELS = 12, TRACE = 13;
	let i = $state(0);
	let innerWidth = $state(W), innerHeight = $state(H);
	const k = $derived(Math.min(innerWidth / W, innerHeight / H));
	let still = $state(false);
	let fullscreen = $state(false);

	function go(next: number) {
		i = Math.max(0, Math.min(slides.length - 1, next));
		history.replaceState(null, '', `#${i + 1}`);
	}
	function toggleFullscreen() {
		void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
	}
	function key(event: KeyboardEvent) {
		// Space and Enter on a focused button already click it.
		if (event.altKey || event.ctrlKey || event.metaKey || ((event.key === ' ' || event.key === 'Enter') && (event.target as HTMLElement).closest('button'))) return;
		const step = ({ ArrowRight: 1, ArrowDown: 1, PageDown: 1, ' ': 1, ArrowLeft: -1, ArrowUp: -1, PageUp: -1, Backspace: -1 } as Record<string, number>)[event.key];
		if (step) go(i + step);
		else if (event.key === 'Home') go(0);
		else if (event.key === 'End') go(slides.length - 1);
		else if (event.key === 'f') toggleFullscreen();
		else return;
		event.preventDefault();
	}

	// A slide's blocks fade and rise in one after another, once the previous slide
	// has faded; a `data-group` block staggers its own children instead, and
	// `data-delay` holds a block back (in ms) until something else has moved.
	function rise(node: HTMLElement) {
		if (still) return { duration: 0 };
		const pieces = node.querySelectorAll<HTMLElement>(':scope > :not([data-group]), :scope > [data-group] > *');
		pieces.forEach((piece, n) => piece.animate(
			[{ opacity: 0, translate: '0 36px', filter: 'blur(8px)' }, { opacity: 1, translate: '0 0', filter: 'blur(0)' }],
			{ duration: 700, delay: Number(piece.dataset.delay ?? 300 + n * 80), easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' }));
		return { duration: 300 + pieces.length * 80 + 700 };
	}
	const leave = { duration: 250 };
	const enter = $derived(still ? { duration: 0 } : { y: 60, duration: 800, easing: cubicOut });

	// LED readouts count up when their slide arrives.
	const counters = { cabinets: new Tween(0), drawers: new Tween(0), tests: new Tween(0) };
	function count(counter: Tween<number>, to: number) {
		return () => { void counter.set(0, { duration: 0 }).then(() => counter.set(to, { duration: still ? 0 : 1600, delay: 300, easing: cubicOut })); };
	}
	const shown = (counter: Tween<number>, digits: number) => String(Math.round(counter.current)).padStart(digits, '0');
	// The sign switches on like a real one; photographs settle slowly.
	function flicker(node: HTMLElement) {
		if (!still) node.animate([0, 0.9, 0.1, 0.8, 0.2, 1, 0.6, 1].map((opacity) => ({ opacity })), { duration: 1400, easing: 'steps(1)', fill: 'backwards', delay: 300 });
	}
	function drift(node: HTMLElement) {
		if (!still) node.animate([{ scale: 1.12 }, { scale: 1 }], { duration: 9000, easing: 'cubic-bezier(.2,.8,.2,1)' });
	}

	// The real shelf map, first the wall and then cabinet A1. The camera frames the
	// whole wall, then flies into A1 until it is exactly where the cabinet view sits.
	const WALL = 880, wallHeight = (WALL - 8) * (2 * 552) / (6 * 306);
	const A1 = { x: 4, y: 4 + wallHeight / 2, w: (WALL - 8) / 6, h: wallHeight / 2 };
	const CABINET = { x: 920, y: 80, h: 760 }, zoom = CABINET.h / A1.h;
	const camera = $derived(i === LABEL ? { x: CABINET.x - A1.x * zoom, y: CABINET.y - A1.y * zoom, s: zoom } : { x: 640, y: 200, s: 1 });
	const wallItems = data.cabinets.map((cabinet) => ({ id: cabinet.id, row: cabinet.outer_row, col: cabinet.outer_col,
		label: gridCell(cabinet.outer_row, cabinet.outer_col), inner: cabinetInner(cabinet, data.bins) }));
	const a1 = data.cabinets.find((cabinet) => cabinet.code === 'A1')!;
	const a1Items = data.bins.filter((bin) => bin.cabinet_id === a1.id).map((bin) => ({ id: bin.id, row: bin.inner_row, col: bin.inner_col,
		rowSpan: bin.row_span, colSpan: bin.col_span, empty: !bin.has_products, label: gridRange(bin.inner_row, bin.inner_col, bin.row_span, bin.col_span) }));

	// The buyer's phone: ./Phone.svelte mounted into an empty iframe that carries the
	// app's styles, so the components' breakpoints see a 360 px phone viewport.
	const phone = $state({ screen: 0 });
	$effect(() => { phone.screen = Math.max(0, Math.min(3, i - FIND)); });
	function phoneScreen(frame: HTMLIFrameElement) {
		const target = frame.contentDocument!;
		target.documentElement.lang = 'nb';
		for (const node of document.head.querySelectorAll('style, link[rel="stylesheet"]')) target.head.appendChild(node.cloneNode(true));
		const app = mount(Phone, { target: target.body, props: phone });
		return () => { void unmount(app); };
	}
	// The step counter is the home page's three steps.
	const step = $derived([1, 1, 2, 3][i - FIND] ?? 1);
	// The volunteers' admin window: where it sits on each admin slide.
	const desk = [[600, 170, 1], [80, 170, 1], [80, 230, 740 / 920]] as const;
	const pose = $derived(desk[Math.max(0, Math.min(2, i - OVERVIEW))]);
	// Backdrop drawn the way Apple Music's web player does it (reverse-engineered in
	// aadishv.dev/music; constants from AMLL's PixiRenderer): four copies of an
	// artwork, stretched square at √2, 0.8, 0.5 and 0.25 of the stage's long side,
	// each turning at its own speed while the third drifts, then blurred hard,
	// saturated, darkened and given contrast. Like the original it renders small and
	// is scaled up; each slide's artwork fades in over one second, like a new song.
	// A WebGL pass then bends the result with slow, layered waves, standing in for
	// Apple's twist filters and AMLL's warped mesh: that is what makes it flow.
	// The colour comes only from the artwork: the slide's own photograph where it is
	// full-bleed, otherwise a cover filled with shades of the one or two hues its
	// elements show.
	const artwork: (string | string[])[] = [
		'/photos/storefront-960.webp',
		'/photos/drawers-960.webp',
		['--drawer-edge', '--link'], // the shelf map
		['--drawer-edge', '--yellow'], // A1 picked out in yellow
		['--led-red'], // the poster's step lights
		['--led-red', '--led-green'], // catalog: step light, stock badges
		['--led-red'], // cart total
		['--led-red'], // the Vipps amount
		['--led-green', '--led-red'], // «Kjøpet er registrert», step 3
		['--primary'], // the trust icons
		['--link'], // the overview's sales chart
		['--led-green', '--yellow'], // stock history badges
		['--led-green'], // label count
		['--led-green', '--yellow'], // purchase and log badges
		['--led-green'], // test count and checks
		['--led-red'], // the four launch points
		['--led-red', '--led-green'] // the sign again
	];
	// A 3×3 cover: every cell a shade of the slide's hues, the second hue in three cells.
	const shades = [1, 0.2, 0.7, 0.12, 0.9, 0.3, 0.6, 0.15, 0.45], second = [2, 4, 6];
	function artworkImage(art: string | string[], style: CSSStyleDeclaration) {
		if (typeof art === 'string') return Object.assign(new Image(), { src: art });
		const cover = document.createElement('canvas');
		cover.width = cover.height = 3;
		const context = cover.getContext('2d')!;
		shades.forEach((shade, n) => {
			const hex = style.getPropertyValue(art[second.includes(n) ? art.length - 1 : 0]).trim();
			const [r, g, b] = [1, 3, 5].map((at) => Math.round(parseInt(hex.slice(at, at + 2), 16) * shade));
			context.fillStyle = `rgb(${r} ${g} ${b})`;
			context.fillRect(n % 3, Math.floor(n / 3), 1, 1);
		});
		return cover;
	}
	const spin = [6e-5, -1.2e-4, 6e-5, -8e-5]; // radians per ms: AMLL's 1/1000, 1/500, 1/1000, 1/750 per 60 fps frame
	const warp = `precision mediump float;
		uniform sampler2D art;
		uniform float t;
		varying vec2 uv;
		void main() {
			vec2 p = uv;
			p += 0.07 * vec2(sin(p.y * 4.0 + t * 0.5), cos(p.x * 3.5 - t * 0.4));
			p += 0.05 * vec2(sin((p.x + p.y) * 6.0 - t * 0.6), cos((p.x - p.y) * 5.0 + t * 0.45));
			gl_FragColor = texture2D(art, p);
		}`;
	function backdrop(canvas: HTMLCanvasElement) {
		const gl = canvas.getContext('webgl');
		if (!gl) return; // ponytail: no WebGL, no backdrop; the stage stays black
		const w = 200, h = 113, long = Math.max(w, h), blur = 14, margin = blur * 3;
		const scratch = document.createElement('canvas'), art = document.createElement('canvas');
		scratch.width = w + 2 * margin; scratch.height = h + 2 * margin;
		art.width = w; art.height = h;
		// Both CPU-backed, so WebGL can take each frame without reading back from the GPU.
		const paint = scratch.getContext('2d', { willReadFrequently: true })!, view = art.getContext('2d', { willReadFrequently: true })!;
		const program = gl.createProgram()!;
		for (const [type, source] of [[gl.VERTEX_SHADER, 'attribute vec2 at; varying vec2 uv; void main() { uv = at * 0.5 + 0.5; uv.y = 1.0 - uv.y; gl_Position = vec4(at, 0.0, 1.0); }'], [gl.FRAGMENT_SHADER, warp]] as const) {
			const shader = gl.createShader(type)!;
			gl.shaderSource(shader, source);
			gl.compileShader(shader);
			gl.attachShader(program, shader);
		}
		gl.linkProgram(program);
		gl.useProgram(program);
		gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
		gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
		for (const [name, value] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, name, value);
		const clock = gl.getUniformLocation(program, 't');
		const moving = !matchMedia('(prefers-reduced-motion: reduce)').matches;
		const layers: { image: HTMLImageElement | HTMLCanvasElement; alpha: number; turn: number[] }[] = [];
		let current = -1, time = 0, last = 0, frame = 0;
		function draw(now: number) {
			frame = requestAnimationFrame(draw);
			if (now - last < 1000 / 30) return; // AMLL caps the original at 30 fps
			const dt = last ? Math.min(now - last, 100) : 0;
			last = now;
			if (i !== current) {
				current = i;
				layers.push({ image: artworkImage(artwork[i], getComputedStyle(canvas)), alpha: 0, turn: spin.map(() => Math.random() * 2 * Math.PI) });
			}
			if (moving) time += dt;
			paint.globalAlpha = 1;
			paint.fillStyle = 'black';
			paint.fillRect(0, 0, scratch.width, scratch.height);
			for (const layer of layers) {
				if (layer.image instanceof HTMLImageElement && !layer.image.complete) continue;
				layer.alpha = moving ? Math.min(1, layer.alpha + dt / 1000) : 1;
				if (moving) layer.turn = layer.turn.map((angle, n) => angle + spin[n] * dt);
				const drift = (w / 4) * Math.cos(time * 4.5e-5);
				const sprites = [[w / 2, h / 2, long * Math.SQRT2], [w / 2.5, h / 2.5, long * 0.8], [w / 2 + drift, h / 2 + drift, long * 0.5], [w / 2 + w / 40, h / 2 + w / 40, long * 0.25]];
				paint.globalAlpha = layer.alpha;
				sprites.forEach(([x, y, size], n) => {
					paint.setTransform(1, 0, 0, 1, x + margin, y + margin);
					paint.rotate(layer.turn[n]);
					paint.drawImage(layer.image, -size / 2, -size / 2, size, size);
				});
				paint.setTransform(1, 0, 0, 1, 0, 0);
			}
			while (layers.length > 1 && layers[1].alpha >= 1) layers.shift();
			view.filter = `blur(${blur}px) saturate(1.2) brightness(0.6) contrast(1.3)`;
			view.drawImage(scratch, -margin, -margin);
			gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGB, gl!.RGB, gl!.UNSIGNED_BYTE, art);
			gl!.uniform1f(clock, time / 1000);
			gl!.drawArrays(gl!.TRIANGLES, 0, 3);
		}
		frame = requestAnimationFrame(draw);
		return () => cancelAnimationFrame(frame);
	}


	// Label artwork from the same code the admin pages print with.
	let drawerLabel = $state<string>(), sheetLabels = $state<string[]>([]);
	let tape = $state<TapeBitmap>();
	onMount(() => {
		still = matchMedia('(prefers-reduced-motion: reduce)').matches;
		const n = Number(location.hash.slice(1));
		if (Number.isInteger(n) && n >= 1 && n <= slides.length) i = n - 1;
		const demo = { id: 'demo', code: data.resistor.code, lines: [data.resistor.name_nb] };
		void import('#lib/labels/render.js').then(async ({ prepareLabels, prepareTapeLabel }) => {
			const settings = { ...proportionalLabelSettings(45), copies: 1 };
			drawerLabel = (await prepareLabels([demo], settings)).labels[0].svgUrl;
			sheetLabels = (await prepareLabels(data.sheet, settings)).labels.map((label) => label.svgUrl);
			// Brother PT-P700 on 18 mm tape: 112 printable pins (docs/page-labels.md).
			tape = await prepareTapeLabel(demo, 112);
		}).catch(() => {});
	});
	function drawTape(canvas: HTMLCanvasElement) {
		if (!tape) return;
		canvas.width = tape.width; canvas.height = tape.height;
		const context = canvas.getContext('2d')!, image = context.createImageData(tape.width, tape.height);
		tape.ink.forEach((ink, index) => image.data.set(ink ? [0, 0, 0, 255] : [255, 255, 255, 255], index * 4));
		context.putImageData(image, 0, 0);
	}

	const traceTiles: { head: string; text: string; rows: [string, string, 'success' | 'warning' | 'neutral' | 'time'][] }[] = [
		{ head: 'Bestillinger og mottak', text: 'Innkjøp og delvise leveranser', rows: [['Mouser, 20 deler', 'Delvis mottatt', 'warning'], ['Elfa, 6 deler', 'Mottatt', 'success'], ['Kjell, 3 deler', 'Bestilt', 'neutral']] },
		{ head: 'Endringslogg', text: 'Hvem gjorde hva, og når', rows: [['Ingrid endret prisen på RES-00005', '10:02', 'time'], ['Jonas flyttet CAP-00045 til C1', '09:47', 'time'], ['Sara inviterte en lageransvarlig', 'i går', 'time']] },
		{ head: 'Administratorer', text: 'Inviter og fjern lageransvarlige', rows: [['Ingrid', 'Aktiv', 'success'], ['Jonas', 'Aktiv', 'success'], ['Sara', 'Invitert', 'warning']] }
	];
	const slides = [cover, today, mirror, label, sign, find, fill, pay, register, trust, overview, stockLog, labels, trace, tested, launch, questions];
</script>

<svelte:window bind:innerWidth bind:innerHeight onkeydown={key} />
<svelte:document onfullscreenchange={() => (fullscreen = !!document.fullscreenElement)} />
<svelte:head>
	<title>Ampoteket</title>
	<meta name="robots" content="noindex" />
</svelte:head>

{#snippet title(text: string, cls = 'left-[80px] top-[150px] w-[560px]')}
	<h2 class="absolute text-[64px] leading-[1.05] font-bold tracking-tight {cls}">{text}</h2>
{/snippet}
{#snippet body(text: string, cls = 'left-[80px] top-[330px] w-[560px]')}
	<p class="absolute text-[30px] leading-snug text-muted-foreground {cls}">{text}</p>
{/snippet}
{#snippet chips(labels: string[], cls: string)}
	<div class="absolute flex flex-wrap gap-3 {cls}" data-group>
		{#each labels as text (text)}<Badge variant="outline" class="h-auto border-border px-4 py-2 text-[22px] text-foreground">{text}</Badge>{/each}
	</div>
{/snippet}
{#snippet stat(value: string, caption: string, red = false, spoken = value)}
	<div class="flex items-center gap-5">
		<Led {value} label={`${spoken.replace('.', ',')} ${caption}`} {red} class="px-5 py-3 text-[88px]" />
		<span class="text-[26px] text-muted-foreground" aria-hidden="true">{caption}</span>
	</div>
{/snippet}

<!-- Slide copy. -->
{#snippet cover()}
	<!-- The lit storefront, its real sign beside the wordmark; the camera pulls back from the sign. -->
	<div class="absolute top-0 right-0 h-full w-[1000px] overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_35%)]">
		<img class="size-full origin-[25%_25%] object-cover object-left" src="/photos/storefront-1920.webp" alt="" {@attach drift} />
	</div>
	<div class="absolute top-[250px] left-[80px] w-[640px]" data-group>
		<h1><img class="h-[110px]" src="/brand/wordmark.svg" alt="Ampoteket" {@attach flicker} /></h1>
		<p class="mt-14 text-[44px] leading-tight font-semibold">Selvbetjent delebutikk og lagersystem for verkstedet</p>
		<div class="mt-12 flex items-center gap-6">
			<Led value="01.10.26" label="1. oktober 2026" class="px-4 py-2 text-[44px]" />
			<span class="text-[26px] text-muted-foreground">ampoteket.no · Pilestredet 35</span>
		</div>
	</div>
{/snippet}

{#snippet today()}
	<div class="absolute top-0 right-0 h-full w-[56%] overflow-hidden">
		<img class="size-full object-cover" src="/photos/drawers-1920.webp" alt="Skuffene i delehylla" {@attach drift} />
		<div class="absolute inset-0 bg-linear-to-r from-background to-transparent to-60%"></div>
	</div>
	{@render title('Delehylla i dag')}
	<div class="absolute top-[270px] left-[80px] flex flex-col gap-6" {@attach count(counters.cabinets, 12)} {@attach count(counters.drawers, 492)}>
		{@render stat(shown(counters.cabinets, 2), 'kabinetter', true, '12')}{@render stat(shown(counters.drawers, 3), 'potensielle skuffer', true, '492')}
	</div>
	{@render body('Ingen vet sikkert hva som er på lager, eller hva som er betalt. Lageransvarlige oppdager at noe er tomt når det allerede er tomt.', 'left-[80px] top-[660px] w-[620px]')}
{/snippet}

{#snippet mirror()}
	{@render title('Et digitalt speil av hylla', 'left-[80px] top-[150px] w-[520px]')}
	<div class="absolute top-[300px] left-[80px] flex flex-col gap-6" data-group>{@render stat('12', 'kabinetter')}{@render stat('492', 'potensielle skuffer')}</div>
	{@render body('Lagersystemet viser hvor hver del skal ligge og hvor mange som er registrert.', 'left-[80px] top-[680px] w-[500px]')}
{/snippet}

{#snippet label()}
	{@render title('Hver del har sin egen etikett', 'left-[80px] top-[150px] w-[600px]')}
	{@render body('QR-koden åpner bare delens side. Pris og beholdning hentes fra lageret, så etiketten må ikke byttes når prisen endres.', 'left-[80px] top-[330px] w-[540px]')}
	<div class="absolute top-[745px] left-[620px] flex h-0 items-center" data-delay="1300">
		{#if drawerLabel}<img class="w-[214px] rounded-md bg-[var(--paper)] p-2 shadow-2xl" src={drawerLabel} alt="Etiketten til RES-00005, 1 kΩ motstand" />{/if}
		<div class="h-[3px] w-[98px] bg-primary shadow-[0_0_8px_var(--led-red)]"></div>
	</div>
{/snippet}

{#snippet sign()}
	{@render title('Plakaten ved hylla', 'left-[80px] top-[150px] w-[700px]')}
	{@render body('Tre steg og Vippsnummeret, på norsk og engelsk. QR-koden åpner ampoteket.no.', 'left-[80px] top-[260px] w-[620px]')}
	<img class="absolute top-[60px] left-[960px] h-[780px] rotate-2 shadow-2xl ring-1 ring-night-border" src={poster} alt="Kjøpsplakaten: slik kjøper du deler, i tre steg" />
{/snippet}

{#snippet find()}
	{@render title('Finn delen', 'left-[80px] top-[150px] w-[900px]')}
	{@render body('Skann QR-koden på skuffen, eller slå opp koden i delekatalogen. Produktsiden viser pris, beholdning og hvor delen ligger.', 'left-[80px] top-[260px] w-[860px]')}
	{@render chips(['Ingen konto', 'Ingen app', 'Norsk og engelsk', 'Mørk og lys modus'], 'left-[80px] top-[460px] w-[860px]')}
{/snippet}

{#snippet fill()}
	{@render title('Fyll handlekurven', 'left-[80px] top-[150px] w-[900px]')}
	<div class="absolute top-[290px] left-[80px]">{@render stat('14.50', 'kr for tre deler', true)}</div>
	{@render body('Prisen fryses når kjøperen går til kassen, så beløpet endrer seg ikke underveis.', 'left-[80px] top-[470px] w-[860px]')}
{/snippet}

{#snippet pay()}
	{@render title('Betal i Vipps', 'left-[80px] top-[150px] w-[900px]')}
	<div class="absolute top-[290px] left-[80px]">{@render stat('14.50', 'kr til Vipps 47322', true)}</div>
	{@render body('Kjøperen betaler i sin egen Vipps-app. Mister de nettet etterpå, fortsetter de samme kjøp uten å betale på nytt.', 'left-[80px] top-[470px] w-[860px]')}
{/snippet}

{#snippet register()}
	{@render title('Registrer kjøpet', 'left-[80px] top-[150px] w-[900px]')}
	{@render body('Trykk «Jeg har betalt». Delene trekkes fra lageret med en gang, så lageransvarlige ser når de må bestille mer.', 'left-[80px] top-[260px] w-[860px]')}
	{@render chips(['Lageret oppdateres', 'Kvittering på e-post hvis du vil'], 'left-[80px] top-[460px] w-[860px]')}
{/snippet}

{#snippet trust()}
	{@render title('Bygget på tillit, og ærlig om det', 'left-[80px] top-[150px] w-[1440px]')}
	{#each [
		{ icon: SealWarningIcon, head: 'Aldri «bekreftet»', text: 'Siden sier aldri at betalingen er sjekket. Ingen Vipps-bedriftsavtale trengs.' },
		{ icon: ArrowsClockwiseIcon, head: 'Aldri betal to ganger', text: 'Mister du nettet etter betaling, fortsetter du samme kjøp.' },
		{ icon: SnowflakeIcon, head: 'Prisen fryses', text: 'Beløpet i kassen endrer seg ikke mens du betaler.' },
		{ icon: QrCodeIcon, head: 'Skanning kjøper ingenting', text: 'En QR-kode åpner bare produktsiden.' }
	] as tile, index (tile.head)}
		<div class="absolute top-[330px] h-[400px] w-[335px] rounded-3xl border border-border bg-background/60 p-9 backdrop-blur" style:left="{80 + index * 368}px">
			<Icon icon={tile.icon} size={56} class="text-primary" />
			<h3 class="mt-8 text-[30px] leading-tight font-semibold">{tile.head}</h3>
			<p class="mt-4 text-[24px] leading-snug text-muted-foreground">{tile.text}</p>
		</div>
	{/each}
{/snippet}

{#snippet overview()}
	<!-- Smaller than the other titles: «lageransvarlige» must fit beside the admin window. -->
	<h2 class="absolute top-[150px] left-[80px] w-[500px] text-[52px] leading-[1.05] font-bold tracking-tight">For lageransvarlige: et ekte lagersystem</h2>
	{@render body('Hver lageransvarlig har egen innlogging. Oversikten viser salget og hva som trenger oppmerksomhet.', 'left-[80px] top-[420px] w-[440px]')}
{/snippet}

{#snippet stockLog()}
	{@render title('Kjøpet står allerede i historikken', 'left-[1070px] top-[150px] w-[460px]')}
	{@render body('Lagerendringer redigeres aldri. Feil rettes med en ny bevegelse og en begrunnelse.', 'left-[1070px] top-[480px] w-[440px]')}
{/snippet}

{#snippet labels()}
	{@render title('Etiketter på A4-ark eller fra skriveren', 'left-[80px] top-[100px] w-[1440px]')}
	<img class="absolute top-[280px] left-[1200px] h-[420px]" src={printer} alt="Brother PT-P700" />
	{#if tape}
		<div class="absolute top-[330px] left-[890px] rotate-[-5deg] rounded-lg bg-[var(--paper)] p-4 shadow-2xl" role="img" aria-label="Etiketten skriveren lager for RES-00005">
			<canvas class="block w-[224px] [image-rendering:pixelated]" {@attach drawTape}></canvas>
		</div>
	{/if}
	<div class="absolute top-[740px] left-[900px] w-[620px]">
		<p class="text-[30px] font-semibold">Brother PT-P700</p>
		<p class="mt-1 text-[26px] text-muted-foreground">Én etikett om gangen, fra produktet i admin</p>
	</div>
{/snippet}

{#snippet trace()}
	{@render title('Full sporbarhet', 'left-[80px] top-[150px] w-[1440px]')}
	{#each traceTiles as tile, index (tile.head)}
		<div class="absolute top-[520px] w-[450px]" style:left="{80 + index * 495}px">
			<h3 class="text-[30px] font-semibold">{tile.head}</h3>
			<p class="mt-1 text-[24px] text-muted-foreground">{tile.text}</p>
		</div>
	{/each}
{/snippet}

{#snippet tested()}
	{@render title('Testet, og laget for å overleveres', 'left-[80px] top-[150px] w-[1440px]')}
	<div class="absolute top-[360px] left-[80px] flex flex-col gap-4" {@attach count(counters.tests, 223)}>
		<Led value={shown(counters.tests, 3)} label="223 automatiske tester" class="self-start px-6 py-4 text-[140px]" />
		<span class="text-[28px] text-muted-foreground" aria-hidden="true">automatiske tester</span>
	</div>
	<ul class="absolute top-[330px] left-[720px] flex w-[800px] flex-col gap-10" data-group>
		{#each [
			{ head: 'Databasen', text: 'Sjekkes automatisk ved hver endring' },
			{ head: 'Hele nettsiden', text: 'Butikk, kasse, admin, skanner og etiketter testes i nettleseren' },
			{ head: 'Dokumentert', text: 'Neste års studenter kan drive og utvide den uten meg' }
		] as item (item.head)}
			<li class="flex gap-6">
				<Icon icon={CheckCircleIcon} size={48} weight="fill" class="shrink-0 text-[var(--led-green)]" />
				<div><p class="text-[32px] font-semibold">{item.head}</p><p class="mt-1 text-[26px] text-muted-foreground">{item.text}</p></div>
			</li>
		{/each}
	</ul>
{/snippet}

{#snippet launch()}
	{@render title('Før lansering trenger jeg fra dere', 'left-[80px] top-[110px] w-[1440px]')}
	{#each [
		{ head: 'Klarsignal', text: 'Ja til å publisere på ampoteket.no' },
		{ head: 'Startlager', text: 'Jeg lærer opp lageransvarlige, og vi teller skuffene inn sammen' },
		{ head: 'Etiketter på skuffene', text: 'Testark, mål og skanning i verkstedlyset' },
		{ head: 'Kontaktpersoner', text: 'Navn og kontaktmåte til kontaktsiden' }
	] as card, index (card.head)}
		<div class="absolute flex h-[230px] w-[700px] items-center gap-8 rounded-3xl border border-border bg-background/60 px-10 backdrop-blur"
			style:left="{80 + (index % 2) * 740}px" style:top="{260 + Math.floor(index / 2) * 270}px">
			<Led value={String(index + 1)} label={`Punkt ${index + 1}`} class="h-[96px] w-[72px] shrink-0 p-0 text-[64px]" />
			<div><h3 class="text-[34px] font-semibold">{card.head}</h3><p class="mt-2 text-[26px] leading-snug text-muted-foreground">{card.text}</p></div>
		</div>
	{/each}
{/snippet}

{#snippet questions()}
	<div class="absolute inset-x-0 top-[150px] flex flex-col items-center" data-group>
		<img class="h-[100px]" src="/brand/wordmark.svg" alt="Ampoteket" />
		<h2 class="mt-14 text-[64px] font-bold">Spørsmål?</h2>
	</div>
	<div class="absolute inset-x-0 top-[490px] flex flex-col items-center gap-5">
		<img class="size-[240px] rounded-xl bg-[var(--paper)] p-3" src={qr} alt="QR-kode til ampoteket.no" />
		<p class="text-[26px] text-muted-foreground">ampoteket.no</p>
	</div>
{/snippet}

<!-- Devices show the site in the viewer's own colour scheme, like the real one;
     the stage around them stays dark. -->
<main class="fixed inset-0 overflow-hidden bg-night">
	<div class="absolute top-1/2 left-1/2 h-[900px] w-[1600px] overflow-hidden" style:transform="translate(-50%, -50%) scale({k})">
		<canvas class="scheme-night absolute inset-0 size-full" width="320" height="180" aria-hidden="true" {@attach backdrop}></canvas>

		{#if i === MIRROR || i === LABEL}
			<div class="absolute inset-0" in:fly={enter} out:fade={leave} inert>
				<div class="absolute top-0 left-0 origin-top-left transition-transform duration-[1200ms] ease-in-out motion-reduce:transition-none"
					style:width="{WALL}px" style:transform="translate({camera.x}px, {camera.y}px) scale({camera.s})">
					<ShelfDiagram rows={2} cols={6} items={wallItems} selected={null} current="A1" label="Hylleveggen" onselect={() => {}} responsive expand />
				</div>
				<!-- Once the camera has arrived, A1's own drawer map takes over in the same place. -->
				<div class={['absolute transition-opacity motion-reduce:transition-none', i === LABEL ? 'opacity-100 delay-[1000ms] duration-500' : 'opacity-0 duration-200']}
					style:left="{CABINET.x - 4}px" style:top="{CABINET.y - 4}px" style:width="{A1.w * zoom + 8}px">
					<ShelfDiagram cabinet responsive expand rows={a1.inner_rows} cols={a1.inner_cols} items={a1Items} selected={null} current="A1:2:1"
						label="Kabinett A1" emptyLabel="Tom skuff" onselect={() => {}} />
				</div>
			</div>
		{/if}

		{#if i >= FIND && i <= REGISTER}
			<!-- The buyer's phone stays put; its screens scroll past like a feed. -->
			<div class="absolute top-[70px] left-[1120px] overflow-hidden rounded-[56px] border-[12px] border-night-border bg-background shadow-2xl" in:fly={enter} out:fade={leave}>
				<iframe class="block h-[736px] w-[360px]" title="Nettsiden på en telefon" inert {@attach phoneScreen}></iframe>
			</div>
			<!-- One step counter for the whole purchase: the red light and the bar move on. -->
			<ol class="scheme-night absolute top-[700px] left-[80px] grid w-[900px] grid-cols-3" in:fly={enter} out:fade={leave}>
				{#each i18n.m.home.shelf.steps as item, index (item.n)}
					<li class={['flex items-center gap-4 text-[24px] transition-colors duration-700', index + 1 === step ? 'font-semibold text-foreground' : 'text-muted-foreground']} aria-current={index + 1 === step ? 'step' : undefined}>
						<Led value={item.n} label={i18n.m.home.shelf.stepLabel(item.n)} red={index + 1 === step} class="h-[72px] w-[54px] p-0 text-[48px] transition-colors duration-700" />{item.title}
					</li>
				{/each}
				<li class="absolute -bottom-6 left-0 h-1 w-full rounded-full bg-border" aria-hidden="true">
					<div class="h-full rounded-full bg-primary shadow-[0_0_12px_var(--led-red)] transition-[width] duration-700 ease-in-out motion-reduce:transition-none" style:width="{step * 100 / 3}%"></div>
				</li>
			</ol>
		{/if}

		{#if i === TRACE}
			<!-- Small pages from the admin, in the viewer's own colour scheme like the devices. -->
			<div class="absolute inset-0" inert>
				{#each traceTiles as tile, index (tile.head)}
					<ul class="absolute top-[300px] grid w-[450px] divide-y divide-border rounded-2xl border border-night-border bg-background px-6 text-foreground shadow-2xl"
						style:left="{80 + index * 495}px" in:fly={{ ...enter, delay: still ? 0 : 150 + index * 100 }} out:fade={leave}>
						{#each tile.rows as [what, state, tone] (what)}
							<li class="flex items-center justify-between gap-4 py-4 text-[18px]"><span class="min-w-0 truncate">{what}</span>
								{#if tone === 'time'}<span class="shrink-0 text-muted-foreground">{state}</span>{:else}<StateBadge tone={tone} class="shrink-0">{state}</StateBadge>{/if}</li>
						{/each}
					</ul>
				{/each}
			</div>
		{/if}

		{#if i >= OVERVIEW && i <= LABELS}
			<!-- The volunteers' admin window glides between layouts and switches page in place. -->
			<div class="absolute top-0 left-0 w-[920px] origin-top-left overflow-hidden rounded-2xl border border-night-border bg-background text-foreground shadow-2xl transition-transform duration-[900ms] ease-in-out motion-reduce:transition-none"
				style:transform="translate({pose[0]}px, {pose[1]}px) scale({pose[2]})" in:fly={enter} out:fade={leave} inert>
				<div class="flex h-11 items-center gap-2 border-b border-border px-4">
					{#each ['bg-destructive', 'bg-warning', 'bg-success'] as dot (dot)}<span class="size-3 rounded-full {dot}"></span>{/each}
					<span class="ml-4 flex-1 rounded-md bg-muted px-3 py-1 text-xs text-muted-foreground">ampoteket.no/admin</span>
				</div>
				<div class="relative h-[530px]">
					<div class={['absolute inset-0 grid content-start gap-6 p-8 transition-opacity duration-500', i === OVERVIEW ? 'opacity-100' : 'opacity-0']}>
						<h1 class="text-2xl font-semibold">Oversikt</h1>
						<div class="flex gap-10">
							{#each [[String(data.salesCount), 'registrerte kjøp'], [formatMoney(data.salesValue, 'nb'), 'salgsverdi, siste 30 dager'], ['3', 'trenger oppmerksomhet']] as [value, caption] (caption)}
								<div class="grid gap-1"><span class="font-mono text-2xl font-semibold tabular-nums">{value}</span><span class="text-sm text-muted-foreground">{caption}</span></div>
							{/each}
						</div>
						<SalesChart days={data.salesDays} />
					</div>
					<div class={['absolute inset-0 grid content-start gap-4 p-8 transition-opacity duration-500', i === OVERVIEW + 1 ? 'opacity-100' : 'opacity-0']}>
						<ProductIdentity product={data.resistor} linked={false} headingLevel={1} />
						<h2 class="text-lg font-semibold">Lagerhistorikk</h2>
						<ul class="grid divide-y divide-border rounded-lg border border-border">
							{#each data.stockHistory as row, index (row.when)}
								<li class={['grid grid-cols-[1fr_auto_auto] items-center gap-6 px-4 py-3', index === 0 && 'bg-muted']}>
									<span><span class="font-semibold">{row.kind}</span> <span class="text-sm text-muted-foreground">{row.when} · {row.by}</span></span>
									<span class="font-mono tabular-nums">{row.change} stk</span>
									<StateBadge tone={row.tone}>{row.balance} stk</StateBadge>
								</li>
							{/each}
						</ul>
					</div>
					<div class={['absolute inset-0 grid content-start gap-4 bg-muted p-6 transition-opacity duration-500', i === LABELS ? 'opacity-100' : 'opacity-0']}>
						<div class="mx-auto grid aspect-[210/297] h-[480px] grid-cols-4 content-start gap-1.5 bg-[var(--paper)] p-5 shadow-lg">
							{#each sheetLabels as src, index (src)}<img {src} alt={data.sheet[index].code} class="w-full" />{/each}
						</div>
					</div>
				</div>
			</div>
		{/if}

		{#if (i >= FIND && i <= REGISTER) || (i >= OVERVIEW && i <= TRACE)}
			<!-- Sales, stock, history and names on these slides are invented. -->
			<p class="scheme-night absolute top-6 right-10 text-[18px] text-muted-foreground" transition:fade={leave}>Eksempeldata</p>
		{/if}

		{#key i}
			<section class="scheme-night absolute inset-0" in:rise out:fade={leave} aria-label="Lysbilde {i + 1} av {slides.length}">
				{@render slides[i]()}
			</section>
		{/key}
	</div>
	<nav class="scheme-night absolute right-4 bottom-3 flex items-center gap-1 text-[15px] text-muted-foreground" aria-label="Lysbilder">
		<Button variant="ghost" size="icon" aria-label="Forrige lysbilde" onclick={() => go(i - 1)}><Icon icon={CaretLeftIcon} size={18} /></Button>
		<span class="tabular-nums" aria-live="polite">{i + 1} / {slides.length}</span>
		<Button variant="ghost" size="icon" aria-label="Neste lysbilde" onclick={() => go(i + 1)}><Icon icon={CaretRightIcon} size={18} /></Button>
		<Button variant="ghost" size="icon" aria-label="Fullskjerm" aria-pressed={fullscreen} onclick={toggleFullscreen}><Icon icon={fullscreen ? CornersInIcon : CornersOutIcon} size={18} /></Button>
	</nav>
</main>
