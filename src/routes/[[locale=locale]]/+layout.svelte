<script lang="ts">
	import Icon from '$lib/Icon.svelte';
	import ShoppingCartIcon from 'phosphor-svelte/lib/ShoppingCartIcon';
	import ListIcon from 'phosphor-svelte/lib/ListIcon';
	import CpuIcon from 'phosphor-svelte/lib/CpuIcon';
	import WrenchIcon from 'phosphor-svelte/lib/WrenchIcon';
	import TranslateIcon from 'phosphor-svelte/lib/TranslateIcon';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import QrCodeIcon from 'phosphor-svelte/lib/QrCodeIcon';
	import InstagramLogoIcon from 'phosphor-svelte/lib/InstagramLogoIcon';
	import ChatsIcon from 'phosphor-svelte/lib/ChatsIcon';
	import DiscordLogo from '$lib/DiscordLogo.svelte';
	import { onMount, setContext, untrack } from 'svelte';
	import { AdminContext, setAdminContext } from '$lib/admin-context.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Separator } from '$lib/components/ui/separator';
	import { pageContainer } from '$lib/ui';
	import * as Collapsible from '$lib/components/ui/collapsible';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { createCartStore, setCartContext } from '$lib/cart';
	import Scanner from '$lib/Scanner.svelte';
	import { isPrivateRoute } from '$lib/private-route';
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import {
		htmlLang,
		localeFromPathname,
		localizeCurrentUrl,
		localizeHref,
		locales,
		messagesFor,
		ogLocale,
		DISCORD_INVITE,
		INSTAGRAM,
		PROD_ORIGIN,
		SOCIAL_CARD,
		setI18n,
		stripLocale,
		type I18n
	} from '$lib/i18n';

	let { data, children } = $props();

	// One context for the whole tree: current locale, its messages, and a link
	// rewriter. Getters keep it reactive across client-side navigation.
	const i18n: I18n = setI18n({
		get locale() {
			return data.locale;
		},
		get m() {
			return messagesFor(data.locale);
		},
		href: (path: string) => localizeHref(path, data.locale)
	});
	const m = $derived(i18n.m);
	// One browser Auth client is shared by the header and all admin pages.
	const admin = setAdminContext(untrack(() => new AdminContext(data.adminConfig, data.callbackOrigin)));
	onMount(() => { void admin.start(); });
	function checkAccess() { if (document.visibilityState === 'visible') void admin.refresh(); }

	/** Current path with the locale prefix removed, so the picker can swap it. */
	const bare = $derived(stripLocale(page.url.pathname));
	const privatePage = $derived(isPrivateRoute(page.route.id, page.url.pathname));
	// Discord and Instagram stay off the cart and checkout, where a leaving link costs a purchase in progress.
	const showSocial = $derived(!isCurrent('/cart') && !isCurrent('/checkout'));
	const buyerScanPage = $derived(data.salesOpen && (bare === '/' || bare === '/p' || bare.startsWith('/p/') || bare === '/cart'));

	/** Always the production URL, never a preview origin; see PROD_ORIGIN. */
	const canonical = $derived(PROD_ORIGIN + localizeHref(bare, data.locale));

	// A layout-owned store is shared with product/cart pages, never across SSR requests.
	const cart = setCartContext(createCartStore());
	onMount(() => cart.start());
	const cartCount = $derived($cart.status === 'ready' ? $cart.lines.length : null);

	// `<html lang>` is rendered by hooks.server.ts; keep it right after a
	// client-side navigation between languages.
	$effect(() => {
		document.documentElement.lang = htmlLang[localeFromPathname(page.url.pathname)];
	});

	// Closed sales (SALES_OPEN) hide every way into the catalog, cart and scanner.
	const nav = $derived(data.salesOpen ? [
		{ href: '/p', label: m.header.parts, icon: CpuIcon },
		{ href: '/cart', label: m.header.cart, icon: ShoppingCartIcon }
	] : []);
	const adminLink = $derived({ href: '/admin', label: m.header.admin, icon: WrenchIcon });
	// Admin comes last in the phone menu and first in the desktop header row, so a
	// session check never moves the catalog link.
	const catalogLink = $derived(nav.slice(0, 1));
	const menuLinks = $derived(admin.status === 'ready' ? [...catalogLink, adminLink] : catalogLink);
	const headerLinks = $derived(admin.status === 'ready' ? [adminLink, ...catalogLink] : catalogLink);

	function isCurrent(href: string) {
		return bare === href || bare.startsWith(href + '/');
	}

	// Above 40rem the header row holds the wordmark, catalog/admin/cart icons (with text
	// labels from 48rem) and the menu button; the menu holds Contact, the scanner and the language picker. On phones the
	// destinations move into the menu and the scanner floats (Scanner.svelte).
	// Pure enhancement: `html.no-js` (src/app.html) hides the button and leaves
	// the menu open, so the links are reachable without JavaScript.
	let menuOpen = $state(false);
	let headerEl: HTMLElement | undefined = $state();
	let menuButton = $state<HTMLButtonElement | null>(null);

	// Following a link leaves the menu behind, including on client-side navigation.
	afterNavigate(() => {
		menuOpen = false;
	});

	function onKeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape' || !menuOpen) return;
		menuOpen = false;
		menuButton?.focus();
	}

	let scanner = $state<Scanner>();
	// The home hero docks its own phone trigger for the same dialog.
	setContext('scanner', () => scanner?.show());
	function openScanner() {
		// Focus the menu button first: the dialog returns focus there, not to the hidden menu row.
		menuOpen = false;
		menuButton?.focus();
		scanner?.show();
	}

	function onPointerdown(event: PointerEvent) {
		if (menuOpen && !headerEl?.contains(event.target as Node)) menuOpen = false;
	}
</script>

<svelte:window onkeydown={onKeydown} onpointerdown={onPointerdown} onfocus={checkAccess} />
<svelte:document onvisibilitychange={checkAccess} />

<svelte:head>
	{#if privatePage}
		<meta name="robots" content="noindex, nofollow" />
		<meta name="referrer" content="no-referrer" />
	{:else}
	<link rel="canonical" href={canonical} />
	{#each locales as loc (loc)}
		<link
			rel="alternate"
			hreflang={htmlLang[loc]}
			href={PROD_ORIGIN + localizeHref(bare, loc)}
		/>
	{/each}
	<link rel="alternate" hreflang="x-default" href={PROD_ORIGIN + bare} />

	<!-- Link previews. Without these, ampoteket.no pasted into a chat renders as a
	     bare grey link, the most-seen unstyled surface the site has. og:title and
	     og:description are per page, beside that page's <title>. -->
	<meta property="og:type" content="website" />
	<meta property="og:site_name" content="Ampoteket" />
	<meta property="og:url" content={canonical} />
	<meta property="og:locale" content={ogLocale[data.locale]} />
	{#each locales.filter((loc) => loc !== data.locale) as loc (loc)}
		<meta property="og:locale:alternate" content={ogLocale[loc]} />
	{/each}
	<meta property="og:image" content={PROD_ORIGIN + SOCIAL_CARD} />
	<meta property="og:image:type" content="image/jpeg" />
	<meta property="og:image:width" content="1200" />
	<meta property="og:image:height" content="630" />
	<meta property="og:image:alt" content={m.social.imageAlt} />
	<meta name="twitter:card" content="summary_large_image" />
	{/if}
</svelte:head>

<a class="absolute -top-25 left-[var(--gutter)] z-100 rounded-md bg-warning px-4 py-3 font-bold text-on-warning no-underline focus:top-3" href="#main">{m.header.skip}</a>

<!-- Discord sits left of the catalog at every width (the catalog link is phone:hidden),
     except on cart and checkout; Admin, once confirmed, enters at the far left so nothing else moves.
     Instagram follows it from 40rem and moves into the menu on phones. -->
{#snippet instagramRow()}
	<li class="hidden phone:block">
		<Button href={INSTAGRAM} target="_blank" rel="external noopener" variant="ghost" class="w-full justify-start px-3"><Icon icon={InstagramLogoIcon} class="size-5" aria-hidden="true" />{m.header.instagram}<span class="sr-only"> {m.newTab}</span></Button>
	</li>
{/snippet}

{#snippet socialLinks()}
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<Button {...props} href={DISCORD_INVITE} target="_blank" rel="external noopener" variant="ghost" size="icon-sm" class="shrink-0" aria-label={`${m.header.discord} ${m.newTab}`}><DiscordLogo class="size-5" /></Button>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content side="bottom">{m.header.discord}</Tooltip.Content>
	</Tooltip.Root>
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<Button {...props} href={INSTAGRAM} target="_blank" rel="external noopener" variant="ghost" size="icon-sm" class="shrink-0 phone:hidden" aria-label={`${m.header.instagram} ${m.newTab}`}><Icon icon={InstagramLogoIcon} class="size-5" aria-hidden="true" /></Button>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content side="bottom">{m.header.instagram}</Tooltip.Content>
	</Tooltip.Root>
{/snippet}

<header class="site-header sticky top-0 z-40 bg-card" bind:this={headerEl}>
	<div class={pageContainer({ class: "max-w-none px-5 flex min-h-[var(--header-h)] items-center gap-4 py-2 phone:gap-3 phone:py-1 no-js:flex-wrap" })}>
		<a class="mr-auto inline-flex min-h-11 min-w-0 items-center rounded-md font-extrabold text-foreground no-underline" href={i18n.href('/')} aria-label={m.header.home}>
			<picture>
				<source media="(prefers-color-scheme: light)" srcset="/brand/wordmark-light.svg" />
				<img class="h-auto w-44 phone:w-36" src="/brand/wordmark.svg" alt="Ampoteket" width="756" height="139" />
			</picture>
		</a>
		<Tooltip.Provider>
			{#each headerLinks as item (item.href)}
				{#if item.href === '/p' && showSocial}{@render socialLinks()}{/if}
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<Button {...props} href={i18n.href(item.href)} variant={isCurrent(item.href) ? 'secondary' : 'ghost'} size="icon-sm"
								class="shrink-0 aria-[current=page]:border-current phone:hidden md:w-auto md:gap-2 md:px-3"
								aria-label={item.label}
								aria-current={isCurrent(item.href) ? 'page' : undefined}><Icon icon={item.icon} class="size-5" aria-hidden="true" /><span class="hidden md:inline" aria-hidden="true">{item.label}</span></Button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content side="bottom" class="md:hidden">{item.label}</Tooltip.Content>
				</Tooltip.Root>
			{/each}
			{#if !data.salesOpen}{@render socialLinks()}{:else}
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Button {...props} href={i18n.href('/cart')} variant={isCurrent('/cart') ? 'secondary' : 'ghost'} size="icon-sm"
							class="header-cart shrink-0 aria-[current=page]:border-current md:w-auto md:gap-2 md:px-3"
							aria-current={isCurrent('/cart') ? 'page' : undefined}>
							<span class="relative inline-flex" aria-hidden="true">
								<Icon icon={ShoppingCartIcon} class="size-5" />
								<!-- A neutral count, only when there is something to count; red means error or empty stock. -->
								{#if $cart.status !== 'initializing' && cartCount !== 0}<Badge class="absolute -top-2.5 -right-3.5 h-6 min-w-6 border-2 border-card bg-foreground px-1 font-mono text-background">{cartCount ?? '?'}</Badge>{/if}
							</span>
							<span class="hidden md:ms-2 md:inline" aria-hidden="true">{m.header.cart}</span>
							<span class="sr-only">{m.header.cart}{cartCount !== null
								? m.header.cartLines(cartCount)
								: $cart.status === 'initializing' ? m.header.cartLoading : m.header.cartUnavailable}</span>
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content side="bottom" class="md:hidden">{m.header.cart}</Tooltip.Content>
			</Tooltip.Root>
			{/if}
		</Tooltip.Provider>
		{#if buyerScanPage}<Scanner bind:this={scanner} config={data.adminConfig} />{/if}
		<!-- Desktop: a floating panel hanging from the header under the button. Phone: a full-width panel under the header bar. -->
		<Collapsible.Root bind:open={menuOpen} class="relative flex phone:static no-js:contents">
			<Collapsible.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="ghost" size="icon" class="menu-toggle no-js:hidden" bind:ref={menuButton} aria-label={m.header.menuToggle}>
						{#if menuOpen}<Icon icon={XIcon} class="size-5" aria-hidden="true" />{:else}<Icon icon={ListIcon} class="size-5" aria-hidden="true" />{/if}
					</Button>
				{/snippet}
			</Collapsible.Trigger>
			<Collapsible.Content forceMount id="site-menu" class="menu absolute top-[calc(50%+var(--header-h)/2+1px)] right-0 z-10 hidden w-64 rounded-lg border bg-card p-2 shadow-card data-[state=open]:block phone:inset-x-0 phone:top-full phone:w-auto phone:rounded-none phone:border-0 phone:px-[calc(var(--gutter)-0.75rem)] phone:pt-2 phone:pb-3 phone:shadow-none no-js:relative no-js:inset-auto no-js:block no-js:w-full no-js:rounded-none no-js:border-0 no-js:px-0 no-js:pt-2 no-js:pb-3 no-js:shadow-none">
			<Separator class="absolute inset-x-0 top-0 hidden no-js:block" />
			<!-- Phone: catalog, Instagram and Admin, which desktop has in the header row; then Contact at every width. -->
			<nav class="site-nav" aria-label={m.header.menu}>
				<ul class="m-0 flex list-none flex-col p-0">
					{#if !catalogLink.length && showSocial}{@render instagramRow()}{/if}
					{#each menuLinks as item (item.href)}
						<li class="hidden phone:block">
							<Button
								href={i18n.href(item.href)}
								variant={isCurrent(item.href) ? 'secondary' : 'ghost'}
								class="w-full justify-start px-3 aria-[current=page]:border-current"
								aria-current={isCurrent(item.href) ? 'page' : undefined}
							><Icon icon={item.icon} class="size-5" />{item.label}</Button>
						</li>
						{#if item.href === '/p' && showSocial}{@render instagramRow()}{/if}
					{/each}
					<li>
						<Button
							href={i18n.href('/contact')}
							variant={isCurrent('/contact') ? 'secondary' : 'ghost'}
							class="w-full justify-start px-3 aria-[current=page]:border-current"
							aria-current={isCurrent('/contact') ? 'page' : undefined}
						><Icon icon={ChatsIcon} class="size-5" />{m.header.contact}</Button>
					</li>
				</ul>
			</nav>
			{#if buyerScanPage}
				<Button variant="ghost" class="w-full justify-start px-3 phone:hidden no-js:hidden" aria-haspopup="dialog" onclick={openScanner}>
					<Icon icon={QrCodeIcon} class="size-5" aria-hidden="true" />{m.scanner.open}
				</Button>
			{/if}
			<nav class="relative mt-2 flex items-center pt-2" aria-label={m.header.language}>
				<Separator class="absolute inset-x-0 top-0" />
				<Icon icon={TranslateIcon} class="mx-3 size-5" />
				<ul class="m-0 flex list-none items-center gap-1 p-0">
					{#each locales as loc (loc)}
						<li>
							<Button
								variant="ghost"
								class="px-3 aria-[current=true]:underline aria-[current=true]:decoration-2 aria-[current=true]:underline-offset-4"
								href={localizeCurrentUrl(bare, privatePage ? '' : page.url.search, loc)}
								hreflang={htmlLang[loc]}
								lang={htmlLang[loc]}
								aria-current={loc === data.locale ? 'true' : undefined}
							>{messagesFor(loc).locale.name}</Button>
						</li>
					{/each}
				</ul>
			</nav>
			<Separator class="absolute inset-x-0 bottom-0 hidden phone:block no-js:phone:hidden" />
			</Collapsible.Content>
		</Collapsible.Root>
	</div>
	<Separator />
	{#if bare === '/'}
		<!-- Homepage only: a hairline over the header's bottom edge that fills as the page scrolls. Decorative. -->
		<span class="scroll-meter absolute inset-x-0 bottom-0 h-0.5 bg-primary motion-reduce:hidden" aria-hidden="true"></span>
	{/if}
</header>

<main id="main" tabindex="-1" class="min-h-[calc(100dvh-var(--header-h))] flex-[1_0_auto] outline-none">
	{@render children()}
</main>

<footer class="site-footer bg-card text-sm text-muted-foreground">
	<Separator />
	<div class={pageContainer({ class: "max-w-none px-5 flex flex-wrap items-center gap-x-8 gap-y-1 py-3" })}>
		<div class="inline-flex items-center gap-2.5 font-extrabold text-foreground">
			<img class="rounded-sm" src="/brand/mark-square-64.png" alt="" width="28" height="28" />
			<span>Ampoteket</span>
		</div>
		<p class="m-0 min-w-0">{m.footer.about}</p>
		<nav class="md:ml-auto" aria-label={m.footer.links}>
			<ul class="m-0 flex list-none flex-wrap gap-x-5 p-0 [&_a]:inline-flex [&_a]:min-h-11 [&_a]:items-center [&_a]:text-foreground">
				{#each nav as item (item.href)}
					<li><a href={i18n.href(item.href)}>{item.label}</a></li>
				{/each}
				<li><a href={i18n.href('/contact')}>{m.footer.help}</a></li>
				<li><a href={i18n.href('/privacy')}>{m.footer.privacy}</a></li>
				<li><a href={DISCORD_INVITE} target="_blank" rel="external noopener">{m.footer.discord}<span class="sr-only"> {m.newTab}</span></a></li>
				<li><a href={i18n.href('/admin')}>{m.header.admin}</a></li>
			</ul>
		</nav>
	</div>
</footer>
