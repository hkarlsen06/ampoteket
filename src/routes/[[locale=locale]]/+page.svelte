<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import type { createSolderingPointer } from '#lib/soldering-pointer.js';
	import Icon from '#lib/Icon.svelte';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import MapTrifoldIcon from 'phosphor-svelte/lib/MapTrifoldIcon';
	import QrCodeIcon from 'phosphor-svelte/lib/QrCodeIcon';
	import CpuIcon from 'phosphor-svelte/lib/CpuIcon';
	import ClockIcon from 'phosphor-svelte/lib/ClockIcon';
	import DiscordLogo from '#lib/DiscordLogo.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import StateBadge from '#lib/StateBadge.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Separator } from '#lib/components/ui/separator/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import * as Item from '#lib/components/ui/item/index.js';
	import Led from '#lib/Led.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import Brackets from '#lib/Brackets.svelte';
	import type { PageData } from './$types';
	import { pageContainer, formActions, sheetBody } from '#lib/ui.js';
	// The page renders without API reads, so nothing delays its first byte; the shelf
	// picker loads live topology and drawer contents in the browser when opened.
	import { goto } from '$app/navigation';
	import { DISCORD_INVITE, INSTAGRAM, MAZEMAP, PROD_ORIGIN, THE_RESISTANCE, getI18n } from '#lib/i18n/index.js';

	let { data }: { data: PageData } = $props();
	const i18n = getI18n();
	const m = $derived(i18n.m.home);

	// Scroll carries the printer camera (degrees) from a raised front-right view down
	// to an eye-level front-left view; the mouse offsets it within that envelope.
	const PRINTER_START = { azimuth: 30, polar: 62 };
	const PRINTER_END = { azimuth: -25, polar: 90 };
	const POINTER_TURN = 30, POINTER_TILT = 15;
	// The soldering clip plays as its stage centre crosses these viewport-height fractions.
	const SOLDERING_START = 1.1, SOLDERING_END = 0.35;

	const ARTICLE =
		'https://www.oslomet.no/studier/studenthistorier/ampoteket-skrur-opp-spenningen';
	// Association tags link to a site when the association has one (RoboMEK has none).
	// The linked tag looks like the others by design; hover and focus still show it.
	const ASSOCIATION_SITES: Record<string, string> = {
		'The Resistance': 'https://foreninger.sio.no/foreninger/the-resistance'
	};

	// Staff shortcut: holding the catalog button opens the admin pages instead.
	let holdTimer: ReturnType<typeof setTimeout> | undefined;
	let held = false;
	function startHold(event: PointerEvent) {
		if (event.button !== 0) return;
		held = false;
		holdTimer = setTimeout(() => { held = true; goto(i18n.href('/admin')); }, 600);
	}
	function cancelHold() { clearTimeout(holdTimer); }

	const openScanner = getContext<() => void>('scanner');
	// On phones the scanner sits beside the catalog button; the floating trigger
	// (Scanner.svelte) stays hidden until this one scrolls out of view.
	let scanDock = $state<HTMLElement | null>(null);
	let scanDocked = $state(true);
	let heroCopy = $state<HTMLDivElement | null>(null), heroFrame = $state<HTMLDivElement | null>(null);
	let walkFits = $state(false);
	// Shown only while the hero runs its scroll scene (CSS decides).
	let walkMark = $state<HTMLElement | null>(null);
	$effect(() => {
		if (!scanDock || !walkMark || !heroCopy || !heroFrame) return;
		const dock = scanDock, mark = walkMark, copy = heroCopy, frame = heroFrame;
		let observer: IntersectionObserver | undefined;
		// CSS switches the mark on/off when height or motion preferences change.
		// Reobserve after rotation so docking follows the currently visible layout.
		const resize = new ResizeObserver(() => {
			const style = getComputedStyle(frame);
			// Natural height and CSS's viewport budget are identical in both layouts.
			// Animated transforms never affect the fit test or cause observer feedback.
			walkFits = copy.offsetHeight + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) <= parseFloat(style.minHeight);
			observer?.disconnect();
			const header = getComputedStyle(document.documentElement).getPropertyValue('--header-h') || '0px';
			const walking = getComputedStyle(mark).display !== 'none';
			observer = new IntersectionObserver(([entry]) => { scanDocked = walking ? entry.isIntersecting : entry.intersectionRatio === 1; }, { rootMargin: `-${header} 0px 0px`, threshold: walking ? 0 : 1 });
			observer.observe(walking ? mark : dock);
		});
		resize.observe(dock); resize.observe(mark); resize.observe(copy); resize.observe(frame);
		return () => { resize.disconnect(); observer?.disconnect(); };
	});
	// Discord's online members load through the Worker once their card is about a screen
	// away. undefined: loading; null: unavailable, never shown as 0.
	type DiscordStatus = 'online' | 'idle' | 'dnd';
	type DiscordMembers = { online: number; members: { name: string; status: DiscordStatus; avatar: string | null }[] };
	// Discord's own shapes carry the status; the colour only repeats it.
	const discordStatusColor: Record<DiscordStatus, string> = { online: 'text-success', idle: 'text-foreground', dnd: 'text-destructive' };
	let discord = $state<DiscordMembers | null>();
	let discordCard = $state<HTMLElement | null>(null);
	let discordStatus = $state<HTMLElement>();
	async function loadDiscord(retry = false) {
		const body = await fetch('/api/discord').then((response) => response.ok ? response.json() as Promise<DiscordMembers> : null).catch(() => null);
		discord = typeof body?.online === 'number' && Array.isArray(body.members) ? body : null;
		// The retry button leaves with the error, so keep focus in the status line.
		if (retry && discord) discordStatus?.focus({ preventScroll: true });
	}
	$effect(() => {
		if (!discordCard) return;
		const observer = new IntersectionObserver(([entry]) => {
			if (!entry.isIntersecting) return;
			observer.disconnect();
			void loadDiscord();
		}, { rootMargin: '100% 0px' });
		observer.observe(discordCard);
		return () => observer.disconnect();
	});
	// Photograph derivatives from scripts/build-photos.ts.
	const photoSrcset = (name: string) => [960, 1280, 1920, 2560].map((width) => `/photos/${name}-${width}.webp ${width}w`).join(', ');

	let code = $state('');
	let showModels = $state(false);
	let solderingFailed = $state(false);
	let printerSrc = $state<string>(), solderingSrc = $state<string>();
	let shelfOpen = $state(false), shelfMounted = $state(false);
	let shelfBody = $state<HTMLDivElement>();
	let printerStage = $state<HTMLDivElement>();
	let solderingStage = $state<HTMLDivElement>();
	// Oslo wall time for the hero's status strip; a placeholder of the same width until mounted.
	let clock = $state('--:--:--');
	// OsloMet's Pilestredet building hours (student.oslomet.no/apningstider): Mon–Fri
	// 06–22, weekends 08–22, card and PIN after 16. Known limit: public holidays follow the
	// weekend hours and are not modelled, so a weekday holiday reads open from 06 not 08.
	let open = $state<boolean>();

	onMount(() => {
		const format = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
		const tick = () => {
			const t = Object.fromEntries(format.formatToParts(new Date()).map((part) => [part.type, part.value]));
			clock = `${t.hour}:${t.minute}:${t.second}`;
			open = +t.hour < 22 && +t.hour >= (t.weekday === 'Sat' || t.weekday === 'Sun' ? 8 : 6);
		};
		tick();
		const timer = setInterval(tick, 1000);
		return () => clearInterval(timer);
	});

	onMount(() => {
		let mounted = true;
		let frame = 0;
		let pointerX = 0, pointerY = 0;
		let solderingX = 0, solderingY = 0;
		let solderingPointer: ReturnType<typeof createSolderingPointer> = null;
		let unpacking = false;
		const stage = printerStage;
		const soldering = solderingStage;
		const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
		// The viewer and three.js load only once the models are about a screen away.
		let near = false;
		const nearby = new IntersectionObserver((entries) => {
			if (!entries.some((entry) => entry.isIntersecting)) return;
			near = true;
			nearby.disconnect();
			updateModels();
		}, { rootMargin: '100% 0px' });
		const rotatePrinter = () => {
			const viewer = printerStage?.querySelector('model-viewer');
			if (!viewer || !printerStage) return;
			const box = printerStage.getBoundingClientRect();
			const progress = Math.max(0, Math.min(1, (window.innerHeight - box.top) / (window.innerHeight + box.height)));
			const pose = (key: 'azimuth' | 'polar', offset: number) => {
				const [start, end] = [PRINTER_START[key], PRINTER_END[key]];
				return Math.max(Math.min(start, end), Math.min(Math.max(start, end), start + (end - start) * progress + offset));
			};
			// Decreasing camera azimuth makes the printer turn counterclockwise from above.
			viewer.setAttribute('camera-orbit', `${pose('azimuth', -pointerX * POINTER_TURN)}deg ${pose('polar', -pointerY * POINTER_TILT)}deg 1.4m`);
		};
		const updatePoses = () => {
			frame = 0;
			rotatePrinter();
			const viewer = soldering?.querySelector('model-viewer');
			if (!soldering || !viewer?.loaded) return;
			const box = soldering.getBoundingClientRect();
			const progress = Math.max(0, Math.min(1, (innerHeight * SOLDERING_START - box.top - box.height / 2) / (innerHeight * (SOLDERING_START - SOLDERING_END))));
			// A paused looping clip wraps at its exact duration; retain the contact pose.
			const time = progress * Math.max(0, viewer.duration - .000001);
			// Seeking also queues a render of the local iron/cable changes below.
			viewer.currentTime = time;
			solderingPointer?.update(solderingX, solderingY, progress);
		};
		const queueRotation = () => { if (showModels && !frame) frame = requestAnimationFrame(updatePoses); };
		const followPointer = (event: PointerEvent) => {
			if (!stage || event.pointerType !== 'mouse' || reducedMotion.matches) return;
			const box = stage.getBoundingClientRect();
			pointerX = Math.max(-1, Math.min(1, 2 * (event.clientX - box.left) / box.width - 1));
			pointerY = Math.max(-1, Math.min(1, 2 * (event.clientY - box.top) / box.height - 1));
			queueRotation();
		};
		const resetPointer = () => { pointerX = pointerY = 0; queueRotation(); };
		const followSoldering = (event: PointerEvent) => {
			if (!soldering || event.pointerType !== 'mouse' || reducedMotion.matches) return;
			const box = soldering.getBoundingClientRect();
			solderingX = Math.max(-1, Math.min(1, 2 * (event.clientX - box.left) / box.width - 1));
			solderingY = Math.max(-1, Math.min(1, 2 * (event.clientY - box.top) / box.height - 1));
			queueRotation();
		};
		const resetSoldering = () => { solderingX = solderingY = 0; queueRotation(); };
		const loadSoldering = async () => {
			const viewer = soldering?.querySelector('model-viewer');
			if (!viewer?.loaded) return;
			const { createSolderingPointer } = await import('#lib/soldering-pointer.js');
			if (!mounted || !viewer.isConnected) return;
			solderingPointer?.dispose();
			solderingPointer = createSolderingPointer(viewer);
			queueRotation();
		};
		const webgl = () => {
			try { const canvas = document.createElement('canvas'); return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl')); }
			catch { return false; }
		};
		// Cloudflare serves model/gltf-binary uncompressed, so the models ship gzipped
		// (scripts/compress-model.sh) and are unpacked here into object URLs. A server
		// that labels .gz as Content-Encoding (Vite's) has the browser unpack it first.
		const unpack = async (name: string) => {
			const response = await fetch(`/models/${name}.glb.gz`);
			if (!response.ok) throw new Error(`Model ${name}: HTTP ${response.status}`);
			let blob = await response.blob();
			const [a, b] = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
			if (a === 0x1f && b === 0x8b) blob = await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).blob();
			if (!mounted) throw new Error('Unmounted');
			return URL.createObjectURL(blob);
		};
		const updateModels = () => {
			if (reducedMotion.matches) {
				pointerX = pointerY = 0;
				solderingX = solderingY = 0;
				solderingPointer?.dispose();
				solderingPointer = null;
				showModels = false;
				return;
			}
			if (!near) return;
			// Without WebGL model-viewer cannot render (and throws while syncing its
			// camera); the still renders are the complete fallback.
			if (!webgl()) { showModels = false; return; }
			// Data Saver keeps the posters: the viewer and models are about 1.5 MB.
			if ((navigator as { connection?: { saveData?: boolean } }).connection?.saveData) return;
			if (!unpacking) {
				unpacking = true;
				// A printer that fails keeps its poster; the soldering stage swaps to its still.
				unpack('bambu-p2s').then((url) => { printerSrc = url; }, () => {});
				unpack('soldering-station').then((url) => { solderingSrc = url; }, () => { if (mounted) solderingFailed = true; });
			}
			void import('@google/model-viewer')
				.then(({ ModelViewerElement }) => {
					// model-viewer uses three's bundled meshopt decoder once a script at this
					// location loads; an empty inline script enables it without a network request.
					ModelViewerElement.meshoptDecoderLocation = 'data:text/javascript,';
					if (mounted && !reducedMotion.matches) { showModels = true; queueRotation(); }
				})
				.catch(() => { if (mounted) showModels = false; });
		};
		for (const target of [stage, soldering]) if (target) nearby.observe(target);
		reducedMotion.addEventListener('change', updateModels);
		window.addEventListener('scroll', queueRotation, { passive: true });
		window.addEventListener('resize', queueRotation);
		stage?.addEventListener('pointermove', followPointer);
		stage?.addEventListener('pointerleave', resetPointer);
		soldering?.addEventListener('load', loadSoldering, true);
		soldering?.addEventListener('pointermove', followSoldering);
		soldering?.addEventListener('pointerleave', resetSoldering);
		return () => {
			mounted = false;
			for (const url of [printerSrc, solderingSrc]) if (url) URL.revokeObjectURL(url);
			nearby.disconnect();
			cancelAnimationFrame(frame);
			solderingPointer?.dispose();
			reducedMotion.removeEventListener('change', updateModels);
			window.removeEventListener('scroll', queueRotation);
			window.removeEventListener('resize', queueRotation);
			stage?.removeEventListener('pointermove', followPointer);
			stage?.removeEventListener('pointerleave', resetPointer);
			soldering?.removeEventListener('load', loadSoldering, true);
			soldering?.removeEventListener('pointermove', followSoldering);
			soldering?.removeEventListener('pointerleave', resetSoldering);
		};
	});

	function revealShelfSection(section: HTMLElement) {
		if (!shelfOpen || !shelfBody) return;
		shelfBody.scrollTo({ top: shelfBody.scrollTop + section.getBoundingClientRect().top - shelfBody.getBoundingClientRect().top - 16, behavior: 'instant' });
		section.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true });
	}

	// Without JS the form submits GET /p?code=…; with JS we go straight to /p/[code].
	function openCode(event: SubmitEvent) {
		const clean = code.trim().toUpperCase();
		if (!/^[A-Z0-9][A-Z0-9-]{0,39}$/.test(clean)) return; // native validation shows the message
		event.preventDefault();
		goto(i18n.href(`/p/${encodeURIComponent(clean)}`));
	}

	// Every section below the hero opens with its h2 over a circuit-trace rule
	// that starts at a pad under the heading's first letter.
	const sectionTitle = 'pb-4';
	// Equipment panels: a light display title and marker rows beside a model.
	const panelTitle = 'text-[clamp(1.75rem,1.3rem+2vw,2.75rem)] font-light tracking-tight';
	const panelList = 'm-0 list-none p-0';
	const panelItem = 'flex items-baseline gap-4 py-3';
	const panelMarker = 'size-1.5 shrink-0 -translate-y-0.5 bg-primary';
	const leadText = 'text-[clamp(1.125rem,1rem+0.4vw,1.3125rem)] text-muted-foreground';
	const stepTitle = 'text-[clamp(1.375rem,1.2rem+0.8vw,1.75rem)] font-light tracking-tight';
	const modelStage = 'aspect-square w-full max-w-[28rem] justify-self-center';
	const headingTrace = 'relative mb-8 bg-border data-horizontal:h-0.5 before:absolute before:top-1/2 before:left-0 before:size-2.5 before:-translate-y-1/2 before:rounded-full before:bg-border md:mb-10';

	// Search engines read the site name, logo, address and Instagram profile from this.
	// `<` is escaped so copy can never close the script element. The tag is built here
	// because a literal script tag in the markup would be parsed as a component script.
	const structuredData = $derived(`<script type="application/ld+json">${JSON.stringify({
		'@context': 'https://schema.org',
		'@graph': [
			{ '@type': 'WebSite', name: 'Ampoteket', url: `${PROD_ORIGIN}/`, inLanguage: ['nb', 'en'] },
			{
				'@type': 'Organization', name: 'Ampoteket', url: `${PROD_ORIGIN}/`, logo: `${PROD_ORIGIN}/brand/mark-square-180.png`,
				description: m.description, sameAs: [INSTAGRAM],
				address: { '@type': 'PostalAddress', streetAddress: 'Pilestredet 35', addressLocality: 'Oslo', addressCountry: 'NO' }
			}
		]
	}).replaceAll('<', '\\u003c')}${'</'}script>`);
</script>

<svelte:head>
	<title>{m.title}</title>
	<meta name="description" content={m.description} />
	<!-- The site-wide Open Graph tags live in the layout; these two are per page. -->
	<meta property="og:title" content={m.title} />
	<meta property="og:description" content={m.description} />
	<!-- eslint-disable-next-line svelte/no-at-html-tags -- static, escaped JSON built above -->
	{@html structuredData}
</svelte:head>

<!-- The storefront act. Where scroll-driven animations run, motion is welcome
     and the viewport is tall enough, a --walk timeline pins the stage: the
     storefront grows toward its window and dissolves into the room inside,
     where the quote appears. Elsewhere the same DOM stacks as two still
     figures: storefront with the copy, then the room with the quote. -->
<section class="focus-night relative isolate bg-night walk-motion:walk-scene walk-motion:h-[250svh]" data-walk-fits={walkFits || undefined} aria-labelledby="hero-title">
	<!-- In the scene the scanner dock fades instead of scrolling away; the floating
	     trigger takes over when this mark, placed where the fade ends, passes the header. -->
	<div bind:this={walkMark} class="pointer-events-none absolute top-[calc(27svh+var(--header-h))] hidden size-px walk-motion:block" aria-hidden="true"></div>
	<div class="relative grid overflow-hidden walk-motion:sticky walk-motion:top-[var(--header-h)] walk-motion:h-[calc(100svh-var(--header-h))]">
		<!-- Phones: the window between the status strip and the copy, fading into the
		     night; short screens give it less height so the headline stays on the
		     feathered floor. From 64rem: the
		     photograph fills the right of the stage, feathered on three sides, and is
		     lowered 12% so the lit window is centred on the copy rather than riding high.
		     The mask sits on the image, so the feather moves with it. -->
		<figure class="relative col-start-1 row-start-1 m-0 h-[clamp(10rem,100svh-24rem,56svh)] origin-[46%_38%] max-lg:mt-15 md:max-lg:mt-19 lg:ml-[40%] lg:h-auto lg:origin-center walk-motion:walk-approach">
			<img class="absolute inset-0 size-full object-cover object-[28%_50%] mask-b-from-55% max-lg:mask-t-from-85% lg:translate-y-[12%] lg:object-[0%_50%] lg:mask-l-from-75% lg:mask-y-from-75%"
				srcset={photoSrcset('storefront')} sizes="(min-width: 64rem) 60vw, 130vw" src="/photos/storefront-1280.webp" width="4066" height="3100"
				alt={m.photos.storefront} fetchpriority="high" />
		</figure>
		<!-- Viewfinder corners around the scene; artwork only. -->
		<div class="pointer-events-none relative z-30 col-start-1 row-start-1 hidden lg:block" aria-hidden="true"><Brackets class="inset-4 text-night-muted" /></div>
		<div bind:this={heroFrame} class={pageContainer({ class: 'relative z-10 col-start-1 row-start-1 grid min-h-[calc(100svh-var(--header-h))] w-full grid-cols-[minmax(0,1fr)] content-end pt-16 pb-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:content-center lg:py-24 walk-motion:walk-away' })}>
			<!-- Sized to its own column, so a wide fallback font cannot push the headline
			     or lede into the photograph; smaller on short screens, where the pinned
			     stage cannot grow and the copy would reach the status strip. -->
			<div bind:this={heroCopy} class="@container grid min-w-0 grid-cols-[minmax(0,1fr)] justify-items-start gap-5 md:gap-6">
				<h1 id="hero-title" class="w-full min-w-0 max-w-[16ch] text-[clamp(2.25rem,12.5cqi,5.25rem)] text-night-foreground [@media(max-height:40rem)]:text-[clamp(1.75rem,10cqi,3rem)]">{m.hero.title}</h1>
				<p class="w-full min-w-0 max-w-[var(--measure-lede)] text-[clamp(1.125rem,1rem+0.6vw,1.375rem)] text-night-muted">{m.hero.lede}</p>
				<div class={[formActions, 'min-w-0 max-w-full phone:items-stretch walk-motion:walk-hide']}>
					{#if !data.salesOpen}
					<!-- Holds the scan dock's place so the hero's fit test still runs. -->
					<Badge bind:ref={scanDock} variant="outline" class="min-h-11 h-auto gap-2 border-transparent px-0 text-base text-night-foreground"><Icon icon={ClockIcon} />{m.hero.soon}</Badge>
					{:else}
					<Button variant="night" class="min-w-42 px-6 whitespace-nowrap phone:min-w-0 phone:flex-[1_1_auto] phone:px-4 [-webkit-touch-callout:none]" href={i18n.href('/p')} onpointerdown={startHold} onpointerup={cancelHold} onpointerleave={cancelHold} onpointercancel={cancelHold} oncontextmenu={(event) => event.preventDefault()} onclick={(event) => { if (held) { event.preventDefault(); held = false; } }}><Icon icon={CpuIcon} />{m.hero.parts}</Button>
					<Button variant="night" class="hidden grow px-4 no-js:hidden phone:inline-flex" aria-label={i18n.m.scanner.open} aria-haspopup="dialog" data-scanner-dock={scanDocked || undefined} bind:ref={scanDock} onclick={openScanner}><Icon icon={QrCodeIcon} />{i18n.m.scanner.action}</Button>
					{/if}
				</div>
			</div>
		</div>
		<!-- Inside: the room at night, and the page's best sentence over its dark floor.
		     It holds nothing interactive, so while faded out it lets taps through. -->
		<div class="relative z-20 col-start-1 row-start-2 grid min-h-[85svh] content-end walk-motion:pointer-events-none walk-motion:row-start-1 walk-motion:min-h-0">
			<figure class="absolute inset-0 m-0 walk-motion:walk-inside">
				<img class="absolute inset-0 size-full object-cover object-[30%_40%] lg:object-[50%_35%]"
					srcset={photoSrcset('workshop')} sizes="(min-width: 64rem) 100vw, 230vw" src="/photos/workshop-1280.webp" width="5425" height="3876"
					alt={m.photos.workshop} loading="lazy" decoding="async" />
				<div class="absolute inset-0 bg-[linear-gradient(to_top,var(--night),color-mix(in_srgb,var(--night)_55%,transparent)_40%,transparent_70%)]" aria-hidden="true"></div>
			</figure>
			<figure class={pageContainer({ class: 'relative m-0 w-full pt-24 pb-24 max-md:pr-10 md:pb-16 lg:pb-24 walk-motion:walk-quote' })}>
				<blockquote class="m-0 border-l-2 border-night-accent pl-6 md:pl-8"><p class="max-w-[24ch] text-[clamp(1.75rem,1.1rem+2.6vw,3.5rem)] leading-[1.1] font-light tracking-tight text-night-foreground">{m.about.quote}</p></blockquote>
				<figcaption class="mt-5 pl-6 text-sm text-night-muted md:pl-8">{m.about.quoteBy}</figcaption>
			</figure>
		</div>
		<!-- The instrument strip: the room and Oslo time. The room links to MazeMap under
		     its logo (cropped from use.mazemap.com), which students know from campus; the
		     clock links to the OsloMet hours it is coloured by. -->
		<div class="absolute inset-x-0 top-0 z-30">
			<div class={pageContainer({ class: 'flex flex-wrap items-center justify-between gap-x-4 gap-y-1 pt-4 text-sm text-night-muted md:pt-8' })}>
				<a href={MAZEMAP} target="_blank" rel="external noopener" class="inline-flex min-h-11 min-w-0 items-center gap-2.5 rounded-sm text-night-muted no-underline hover:text-night-foreground"><img src="/mazemap.webp" alt="" width="20" height="20" />{m.hero.place}<span class="sr-only">, {m.hero.map} {i18n.m.newTab}</span></a>
				<a href={m.hero.hoursSource} target="_blank" rel="external noopener" class="inline-flex min-h-11 shrink-0 items-center gap-2.5 rounded-sm text-night-muted no-underline hover:text-night-foreground"><span class="grid">{#each [m.hero.open, m.hero.closed] as status (status)}<span class="invisible col-start-1 row-start-1" aria-hidden="true">{status}</span>{/each}<span class="col-start-1 row-start-1">{open === undefined ? '' : open ? m.hero.open : m.hero.closed}</span></span><Led value={clock} label={m.hero.clockTime(clock)} red={!open} size="small" class="border-night-border text-sm whitespace-nowrap" /><span class="sr-only">{m.hero.hours} {i18n.m.newTab}</span></a>
			</div>
		</div>
	</div>
	<Separator class="absolute inset-x-0 bottom-0 bg-night-border" />
</section>

<section class="py-16 md:py-24" aria-labelledby="about-title">
	<div class={pageContainer()}>
		<h2 id="about-title" class={sectionTitle}>{m.about.title}</h2>
		<Separator class={headingTrace} />
		<!-- What the room is for, beside the facts; space separates the facts, not rules.
		     The source link covers the quote above and the facts here. -->
		<div class="grid items-start gap-12 md:mt-8 md:grid-cols-2">
			<div class="grid justify-items-start gap-6">
				<p class={leadText}>{m.about.body2}</p>
				<a href={ARTICLE} target="_blank" rel="external noopener">{m.about.sourceText}<span class="sr-only"> {i18n.m.newTab}</span></a>
			</div>
			<!-- A short spec table: label and value on one line, so it scans at a glance. -->
			<dl class="m-0 grid gap-y-5">
				{#each m.about.facts as fact (fact.term)}
					<div class="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-3 md:gap-4">
						<dt class="text-sm text-muted-foreground">{fact.term}</dt>
						<dd class="m-0">
							{#if fact.led}
								<!-- The one fact that is pure digits, set in the display face the
								     sign in the window uses. The readable date stays in the
								     accessibility tree; the cell is decoration over it. -->
								<Led value={fact.led} label={fact.value} size="small" />
							{:else if fact.chips}
								<!-- Two names read faster as two tags than as a sentence. -->
								<ul class="m-0 flex list-none flex-wrap gap-2 p-0">
									{#each fact.chips as chip (chip)}
										<li>
											{#if ASSOCIATION_SITES[chip]}
											<Badge variant="outline" href={ASSOCIATION_SITES[chip]} target="_blank" rel="external noopener" class="min-h-11 h-auto px-2 py-1 font-normal text-foreground no-underline hover:bg-muted">{chip}<span class="sr-only"> {i18n.m.newTab}</span></Badge>
											{:else}
												<Badge variant="outline" class="min-h-11 h-auto px-2 py-1 font-normal text-foreground">{chip}</Badge>
											{/if}
										</li>
									{/each}
								</ul>
							{:else}
								{fact.value}
							{/if}
						</dd>
					</div>
				{/each}
			</dl>
		</div>
	</div>
</section>

<!-- Follows «Dette er Ampoteket» on the same surface, which already supplies the gap. -->
<section class="pb-16 md:pb-24" aria-labelledby="gear-title">
	<!-- A night stage the width of the screen with the whole bench photograph in it,
	     feathered into the black and switching on like a screen as it scrolls into
	     view. Phones show it uncropped at full width with the heading just under its
	     faded foot. From 64rem it is as tall as the screen allows (never wider than the
	     screen), centred, so the meters and the lit trainer are seen together, and the
	     heading sits on the dark wall between them. -->
	<div class="scheme-night relative isolate grid bg-night">
		<div class={pageContainer({ class: 'relative z-10 grid min-h-[calc(74.6vw+5rem)] w-full content-end pb-2 lg:min-h-[calc(100svh-var(--header-h))] lg:content-center lg:pb-[18svh]' })}>
			<div class="max-w-md">
				<h2 id="gear-title" class={sectionTitle}>{m.facilities.title}</h2>
				<Separator class={headingTrace} />
			</div>
		</div>
		<figure class="absolute inset-x-0 top-0 m-0 lg:inset-y-0 lg:flex lg:items-center lg:justify-center">
			<img class="block h-auto w-full mask-t-from-90% mask-b-from-70% lg:h-[min(100%,74.6vw)] lg:w-auto lg:mask-x-from-85% lg:mask-y-from-85% scroll-motion:power-on"
				srcset={photoSrcset('bench')} sizes="(min-width: 64rem) 75vw, 100vw" src="/photos/bench-1280.webp" width="5483" height="4090"
				alt={m.photos.bench} loading="lazy" decoding="async" />
		</figure>
	</div>
	<div class={pageContainer()}>
		<!-- Two panels: a list beside its scroll-driven model. -->
		<div class="mt-16 grid gap-16 md:mt-24 md:gap-20">
			<div class="grid items-center gap-8 md:grid-cols-2 md:gap-12">
				<div class="grid content-start gap-5">
					<h3 class={panelTitle}>{m.facilities.gearTitle}</h3>
					<ul class={panelList}>
						{#each m.facilities.gear as item, idx (item)}
							<li>{#if idx > 0}<Separator />{/if}<span class={panelItem}><span class={panelMarker} aria-hidden="true"></span>{item}</span></li>
						{/each}
					</ul>
				</div>
				<div bind:this={printerStage} class={modelStage}>
					{#if showModels}
						<model-viewer id="home-printer" class="block size-full [&::part(default-progress-bar)]:hidden" src={printerSrc} poster="/models/bambu-p2s.webp" alt={m.facilities.printerAlt} loading="lazy" camera-orbit="{PRINTER_START.azimuth}deg {PRINTER_START.polar}deg 1.4m" exposure="1" shadow-intensity="0.6" shadow-softness="1"></model-viewer>
					{:else}
						<img class="size-full object-contain" src="/models/bambu-p2s.webp" alt={m.facilities.printerAlt} width="1100" height="1100" loading="lazy" decoding="async" />
					{/if}
				</div>
			</div>
			<div class="grid items-center gap-8 md:grid-cols-2 md:gap-12">
				<!-- Mirrored from 48rem so the two models read as a pair. -->
				<div class="grid content-start gap-5 md:order-last">
					<h3 class={panelTitle}>{m.facilities.eventsTitle}</h3>
					<ul class={panelList}>
						{#each m.facilities.events as item, idx (item)}
							<li>{#if idx > 0}<Separator />{/if}<span class={panelItem}><span class={panelMarker} aria-hidden="true"></span>{item}</span></li>
						{/each}
					</ul>
				</div>
				<div bind:this={solderingStage} class={modelStage}>
					{#if showModels && !solderingFailed}
						<model-viewer id="home-soldering" class="block size-full [&::part(default-progress-bar)]:hidden" src={solderingSrc} poster="/models/soldering-station.webp" alt={m.facilities.solderingAlt} loading="lazy" animation-name="Soldering" camera-orbit="20deg 62deg 1.0m" camera-target="0.03m 0.115m 0m" exposure="1" shadow-intensity="0.6" shadow-softness="1" onerror={() => solderingFailed = true}></model-viewer>
					{:else}
						<img class="size-full object-contain" src="/models/soldering-station.webp" alt={m.facilities.solderingAlt} width="1100" height="1100" loading="lazy" decoding="async" />
					{/if}
				</div>
			</div>
		</div>
	</div>
</section>

<!-- `band`: hairlines across the page split the workshop and the shelf into two acts. -->
<section aria-labelledby="shelf-title">
	<Separator />
	<div class={pageContainer({ class: 'py-16 md:py-24' })}>
		<h2 id="shelf-title" class={sectionTitle}>{m.shelf.title}</h2>
		<Separator class={headingTrace} />
		<!-- The real wall the shelf map draws, in a rounded night frame at content width
		     with the three steps on it (`scheme-night` keeps the frame dark with light
		     text in both schemes). The photograph fills the frame's top: 4:3 on phones,
		     16:10 from 48rem, close to its own 1.24:1. From 64rem it fades to black at
		     the foot and the steps sit there in three columns; below 64rem the frame
		     grows and the steps continue under the faded photograph. -->
		<div class="scheme-night grid overflow-hidden rounded-xl bg-night">
			<figure class="relative col-start-1 row-start-1 m-0">
				<img class="block aspect-[4/3] w-full object-cover mask-b-from-70% md:aspect-[16/10] md:object-[50%_55%] lg:mask-b-from-45% lg:mask-b-to-88%"
					srcset={photoSrcset('drawers')} sizes="(min-width: 72rem) 72rem, 100vw" src="/photos/drawers-1280.webp" width="3418" height="2757"
					alt={m.photos.drawers} loading="lazy" decoding="async" />
			</figure>
			<!-- Hairline rows on phones, three columns from 48rem. -->
			<ol class="relative col-start-1 row-start-2 m-0 -mt-8 grid list-none px-5 pb-2 md:mt-0 md:grid-cols-3 md:gap-8 md:px-8 md:pt-2 md:pb-8 lg:row-start-1 lg:self-end lg:gap-12 lg:px-10 lg:pb-10">
				{#each m.shelf.steps as step, idx (step.n)}
					<li>
						{#if idx > 0}<Separator class="md:hidden" />{/if}
						<Item.Root variant="row" class="items-start gap-5 py-6 md:py-0">
							<Item.Media class="self-start"><Led value={String(step.n)} label={m.shelf.stepLabel(step.n)} size="step" /></Item.Media>
							<Item.Content class="min-w-0 gap-2">
								<Item.Title><h3 class={stepTitle}>{step.title}</h3></Item.Title>
								<Item.Description class="text-base">{step.text}</Item.Description>
							</Item.Content>
						</Item.Root>
					</li>
				{/each}
			</ol>
		</div>
		<!-- Lookup as a panel like the equipment ones: description and code entry
		     beside the printed label, separated from the steps by space, not a rule. -->
		<div class="mt-16 grid items-center gap-12 md:mt-24 md:grid-cols-2">
			<div class="grid content-start justify-items-start gap-8">
				<p class={leadText}>{m.shelf.body1}</p>
				{#if data.salesOpen}
				<Card.Root class="grid w-full max-w-sm min-w-0 gap-4 p-5 md:p-6">
					<form class="code-form" action={i18n.href('/p')} method="get" onsubmit={openCode}>
						<Field.Field>
							<Field.Label for="part-code">{m.find.codeLabel}</Field.Label>
							<div class="grid grid-cols-2 items-center gap-3">
								<Input
									id="part-code"
									class="font-mono uppercase"
									name="code"
									type="text"
									inputmode="text"
									enterkeyhint="go"
									bind:value={code}
									autocomplete="off"
									autocapitalize="characters"
									spellcheck="false"
									placeholder="RES-00026"
									pattern="[A-Za-z0-9][A-Za-z0-9\-]{'{'}0,39}"
									title={m.find.codeHint}
									required
								/>
								<Button variant="default" class="w-full" type="submit">{m.find.codeSubmit}</Button>
							</div>
						</Field.Field>
					</form>
					<div class="grid gap-3">
						<Dialog.Root bind:open={shelfOpen} onOpenChange={(open) => { if (open) shelfMounted = true; }}>
							<Dialog.Trigger>
								{#snippet child({ props })}<Button {...props} variant="outline" class="no-js:hidden w-full"><Icon icon={MapTrifoldIcon} /><span class="min-w-0">{m.find.shelfOpen}</span></Button>{/snippet}
							</Dialog.Trigger>
							{#if shelfMounted}
								<Dialog.Content variant="sheet" forceMount preventScroll={false} aria-describedby={undefined}
									class="shelf-picker data-closed:hidden md:max-w-md">
									<Dialog.Header layout="bar">
										<Dialog.Title id="home-shelf-title">{m.find.shelfTitle}</Dialog.Title>
										<Dialog.Close>
											{#snippet child({ props })}<Button {...props} variant="ghost" size="icon" class="shrink-0" aria-label={m.find.shelfClose}><Icon icon={XIcon} /></Button>{/snippet}
										</Dialog.Close>
									</Dialog.Header>
									<!-- svelte-ignore a11y_no_noninteractive_tabindex (Named scroll region supports native keyboard scrolling.) -->
									<div bind:this={shelfBody} class={["shelf-picker-body", sheetBody]} role="region" aria-labelledby="home-shelf-title" tabindex="0">
										<!-- Loaded on first open: the picker is most of this page's own script. -->
										{#await import('#lib/ShelfMap.svelte') then { default: ShelfMap }}<ShelfMap stacked config={data.adminConfig} labelledby="home-shelf-title" onreveal={shelfOpen ? revealShelfSection : undefined} />{/await}
									</div>
								</Dialog.Content>
							{/if}
						</Dialog.Root>
					</div>
					<noscript><p class="text-sm text-muted-foreground">{i18n.m.shelfMap.noJavascript}</p></noscript>
				</Card.Root>
				{/if}
			</div>
			<!-- Viewfinder corners: the label is what the scanner reads. From 48rem it
			     sits at the column's end so the pair spans the container edge to edge. -->
			<figure class="relative m-0 w-full max-w-60 justify-self-center p-4 md:max-w-72 md:justify-self-end lg:max-w-80">
				<Brackets class="text-muted-foreground" />
				<img class="h-auto w-full" src={`/labels/home-${i18n.locale}.svg`} width="45" height="45.6823" loading="lazy"
					alt={`${m.shelf.labelIntro} RES-00026. ${m.shelf.labelName}`} />
			</figure>
		</div>
	</div>
	<Separator />
</section>

<section class="py-16 md:py-24" aria-labelledby="who-title">
	<div class={pageContainer()}>
		<h2 id="who-title" class={sectionTitle}>{m.who.title}</h2>
		<Separator class={headingTrace} />
		<!-- Who, then the clock footnote, beside the Discord card from 48rem; phones end on the invite. -->
		<div class="grid items-start gap-12 md:mt-8 md:grid-cols-2">
			<div class="grid content-start gap-12">
				{#each m.who.groups as group (group.title)}
					<div class="grid content-start gap-3">
						<h3 class={stepTitle}>{group.title}</h3>
						<!-- The association name is the same in both locales, so it is linked in place. -->
						<p class="text-muted-foreground">{#each group.text.split('The Resistance') as part, i (i)}{#if i}<a href={THE_RESISTANCE} target="_blank" rel="external noopener">The Resistance<span class="sr-only"> {i18n.m.newTab}</span></a>{/if}{part}{/each}</p>
					</div>
				{/each}
				<p class="max-w-[var(--measure)] text-muted-foreground">{m.who.hours} <a href={m.hero.hoursSource} target="_blank" rel="external noopener">{m.hero.hours}<span class="sr-only"> {i18n.m.newTab}</span></a>.</p>
			</div>
			<Card.Root bind:ref={discordCard} class="grid min-w-0 gap-4 p-5 md:p-6">
				<div class="flex flex-wrap items-center gap-x-4 gap-y-2">
					<h3 class={stepTitle}>{m.who.discord.title}</h3>
					<div bind:this={discordStatus} tabindex="-1" class="flex flex-wrap items-center gap-3 outline-none no-js:hidden">
						{#if discord === undefined}
							<span class="text-sm text-muted-foreground">{m.who.discord.loading}</span>
						{:else if discord === null}
							<Alert.Message role="alert" appearance="inline" variant="destructive">{m.who.discord.unavailable}</Alert.Message>
							<Button variant="outline" size="sm" onclick={() => loadDiscord(true)}>{m.who.discord.retry}</Button>
						{:else}
							<StateBadge tone="success">{m.who.discord.online(discord.online)}</StateBadge>
						{/if}
					</div>
				</div>
				<p class="text-muted-foreground">{m.who.discord.text}</p>
				{#if discord}
					<ul class="m-0 flex w-full list-none flex-wrap gap-2 p-0" aria-label={m.who.discord.online(discord.online)}>
						{#each discord.members as member, index (index)}
							<li class="inline-flex max-w-full min-w-0 items-center gap-2 rounded-sm bg-muted py-1 pr-3 pl-1 text-sm">
								<span class="relative shrink-0">
									{#if member.avatar}<img class="size-6 rounded-full" src={member.avatar} alt="" width="24" height="24" loading="lazy" decoding="async" />{:else}<DiscordLogo class="size-6 p-1" />{/if}
									<svg class={['absolute -right-1 -bottom-1 size-3.5 rounded-full bg-muted p-0.5', discordStatusColor[member.status]]} viewBox="0 0 10 10" stroke="none" aria-hidden="true" focusable="false">
										<circle cx="5" cy="5" r="5" fill="currentColor" />
										{#if member.status === 'idle'}<circle cx="2.5" cy="2.5" r="3.5" class="fill-muted" />{:else if member.status === 'dnd'}<rect x="2" y="4" width="6" height="2" rx="1" class="fill-muted" />{/if}
									</svg>
								</span>
								<span class="truncate">{member.name}<span class="sr-only">, {m.who.discord.status[member.status]}</span></span>
							</li>
						{/each}
						{#if discord.online > discord.members.length}
							<li class="inline-flex items-center px-2 text-sm text-muted-foreground">{m.who.discord.more(discord.online - discord.members.length)}</li>
						{/if}
					</ul>
				{/if}
				<Button class="justify-self-start" href={DISCORD_INVITE} target="_blank" rel="external noopener"><DiscordLogo />{m.who.discord.join}<span class="sr-only"> {i18n.m.newTab}</span></Button>
			</Card.Root>
		</div>
	</div>
</section>
