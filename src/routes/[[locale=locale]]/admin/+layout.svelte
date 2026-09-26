<script lang="ts">
	import { pageContainer, pageHeader, pageHeading } from '$lib/ui';
	import * as Alert from '$lib/components/ui/alert';
	import * as Sidebar from '$lib/components/ui/sidebar';
	import Icon from '$lib/Icon.svelte';
	import HouseIcon from 'phosphor-svelte/lib/HouseIcon';
	import ChartLineUpIcon from 'phosphor-svelte/lib/ChartLineUpIcon';
	import PackageIcon from 'phosphor-svelte/lib/PackageIcon';
	import ReceiptIcon from 'phosphor-svelte/lib/ReceiptIcon';
	import SquaresFourIcon from 'phosphor-svelte/lib/SquaresFourIcon';
	import ListChecksIcon from 'phosphor-svelte/lib/ListChecksIcon';
	import ClockCounterClockwiseIcon from 'phosphor-svelte/lib/ClockCounterClockwiseIcon';
	import ArrowsDownUpIcon from 'phosphor-svelte/lib/ArrowsDownUpIcon';
	import QrCodeIcon from 'phosphor-svelte/lib/QrCodeIcon';
	import QuestionIcon from 'phosphor-svelte/lib/QuestionIcon';
	import UsersIcon from 'phosphor-svelte/lib/UsersIcon';
	import UserCircleIcon from 'phosphor-svelte/lib/UserCircleIcon';
	import SignOutIcon from 'phosphor-svelte/lib/SignOutIcon';
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon';
	import { Button } from '$lib/components/ui/button';
	import { Separator } from '$lib/components/ui/separator';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { afterNavigate, goto } from '$app/navigation';
	import { getI18n, stripLocale } from '$lib/i18n';
	import { getAdminContext } from '$lib/admin-context.svelte';
	import type { LayoutProps } from './$types';
	let { children }: LayoutProps = $props();
	const i18n = getI18n();
	const m = $derived(i18n.m.admin);
	// Reuse the site layout's Auth client and membership state.
	const admin = getAdminContext();
	// Runs before the site layout's start, so admin pages always load Auth.
	onMount(() => { void admin.start(true); });
	const authPage = $derived(['/admin/login', '/admin/password'].includes(stripLocale(page.url.pathname)));
	$effect(() => {
		if (admin.status === 'signedOut' && !authPage) {
			const next = encodeURIComponent(stripLocale(page.url.pathname));
			void goto(i18n.href(`/admin/login?next=${next}`), { replaceState: true });
		}
	});
	const navEntries = $derived([
		{ path: '/admin', label: m.overview, icon: HouseIcon },
		{ path: '/admin/products', label: i18n.m.adminProducts.heading, icon: PackageIcon },
		{ path: '/admin/stock', label: i18n.m.adminStock.heading, icon: ArrowsDownUpIcon },
		{ path: '/admin/orders', label: i18n.m.adminOrders.heading, icon: ReceiptIcon },
		{ path: '/admin/counts', label: i18n.m.adminCounts.heading, icon: ListChecksIcon },
		{ path: '/admin/shelf', label: i18n.m.adminShelf.heading, icon: SquaresFourIcon },
		{ path: '/admin/products/labels', label: i18n.m.adminLabels.heading, icon: QrCodeIcon },
		{ path: '/admin/statistics', label: i18n.m.adminStatistics.heading, icon: ChartLineUpIcon },
		{ path: '/admin/audit', label: i18n.m.adminAudit.heading, icon: ClockCounterClockwiseIcon },
		{ path: '/admin/privacy', label: m.recoveryHeading, icon: QuestionIcon },
		{ path: '/admin/help', label: m.directoryHeading, icon: UsersIcon }
	]);
	const currentPath = $derived(stripLocale(page.url.pathname));
	// Longest prefix wins so /admin/products/labels marks the labels entry, not products.
	const currentNav = $derived([...navEntries].sort((a, b) => b.path.length - a.path.length)
		.find(({ path }) => currentPath === path || currentPath.startsWith(`${path}/`))?.path);
	const productPage = $derived(currentNav === '/admin/products' && Boolean(page.params.id));
	// Detail pages link their section crumb, so pages need no separate back link.
	const detailPage = $derived(Boolean(currentNav && currentNav !== '/admin' && currentPath !== currentNav));
	const productCode = $derived(admin.productBreadcrumb?.routeId === page.params.id ? admin.productBreadcrumb?.code ?? null : null);
	// While access is checked, draw the shell the staff member is about to get, so nothing jumps.
	const shell = $derived(admin.retainsEditor || (!authPage && admin.status === 'loading'));
	let menuOpen = $state(false);
	afterNavigate(() => { menuOpen = false; });
</script>
<svelte:head><meta name="robots" content="noindex, nofollow" /></svelte:head>
<Sidebar.Provider bind:openMobile={menuOpen}>
	{#if shell}
		<Sidebar.Root collapsible="icon" label={m.navigation} closeLabel={m.closeSidebar} inert={admin.status !== 'ready'}>
			<Sidebar.Header class="p-3 group-data-[collapsible=icon]:px-2">
				<Sidebar.MenuButton size="lg" tooltipContent={m.heading} aria-label={m.heading}>
					{#snippet child({ props })}
						<a {...props} href={i18n.href('/admin')}>
							<img src="/brand/mark-square-64.png" alt="" width="32" height="32" class="size-8 shrink-0 rounded-md" />
							<span class="font-semibold">{m.heading}</span>
						</a>
					{/snippet}
				</Sidebar.MenuButton>
			</Sidebar.Header>
			<Sidebar.Content>
				<Sidebar.Group>
					<nav aria-label={m.navigation}>
						<Sidebar.Menu>
							{#each navEntries as { path, label, icon } (path)}
								<Sidebar.MenuItem>
									<Sidebar.MenuButton isActive={currentNav === path} tooltipContent={label} aria-label={label} aria-current={currentNav === path ? 'page' : undefined}>
										{#snippet child({ props })}
											<a {...props} href={i18n.href(path)}><Icon {icon} /><span>{label}</span></a>
										{/snippet}
									</Sidebar.MenuButton>
								</Sidebar.MenuItem>
							{/each}
						</Sidebar.Menu>
					</nav>
				</Sidebar.Group>
			</Sidebar.Content>
			<Sidebar.Footer class="p-3 group-data-[collapsible=icon]:px-2">
				<div class="flex min-w-0 items-center gap-2 p-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0">
					{#if admin.retainsEditor}
						<Icon icon={UserCircleIcon} class="size-8 shrink-0" />
						<div class="min-w-0 text-sm group-data-[collapsible=icon]:sr-only">
							<p class="font-medium wrap-anywhere">{admin.membership?.displayName}</p>
							<p class="text-muted-foreground wrap-anywhere">{admin.session?.user.email}</p>
						</div>
					{:else}
						<Skeleton class="size-8 shrink-0 rounded-full" />
						<div class="min-w-0 flex-1 space-y-1.5 group-data-[collapsible=icon]:hidden" aria-hidden="true"><Skeleton class="h-4 w-24" /><Skeleton class="h-4 w-36 max-w-full" /></div>
					{/if}
				</div>
				<Sidebar.MenuButton tooltipContent={m.signOut} aria-label={m.signOut} onclick={() => admin.signOut()}>
					<Icon icon={SignOutIcon} /><span>{m.signOut}</span>
				</Sidebar.MenuButton>
			</Sidebar.Footer>
		</Sidebar.Root>
	{/if}
	<Sidebar.Inset class="min-w-0">
		{#if shell}
			<div class="flex min-h-16 items-center gap-3 px-4 md:px-6" inert={admin.status !== 'ready'}>
				<Sidebar.Trigger label={m.toggleSidebar} />
				<Separator orientation="vertical" class="my-5" />
				<nav aria-label={m.breadcrumb} class="min-w-0">
					<ol class="flex min-w-0 flex-wrap items-center gap-2 text-sm">
						<li><a href={i18n.href('/admin')} class="text-muted-foreground no-underline">{m.heading}</a></li>
						{#if currentNav && currentNav !== '/admin'}
							<li aria-hidden="true"><Icon icon={CaretRightIcon} class="size-4" /></li>
							<li>{#if detailPage}<a href={i18n.href(currentNav)} class="text-muted-foreground no-underline">{navEntries.find(entry => entry.path === currentNav)?.label}</a>{:else}<span aria-current="page">{navEntries.find(entry => entry.path === currentNav)?.label}</span>{/if}</li>
						{/if}
						{#if detailPage}
							<li aria-hidden="true"><Icon icon={CaretRightIcon} class="size-4" /></li>
							<li class="min-w-0 wrap-anywhere" aria-current="page">{productPage ? productCode ?? (page.params.id === 'new' ? i18n.m.adminProducts.newProduct : i18n.m.adminProducts.editProduct) : currentNav === '/admin/orders' ? i18n.m.adminOrders.detailHeading : i18n.m.adminCounts.detailHeading}</li>
						{/if}
					</ol>
				</nav>
			</div>
		{/if}
		<section>
			<div class={pageContainer({ width: 'admin', padding: 'page' })}>
			<noscript><p>{m.noScript}</p></noscript>

			{#if authPage || admin.retainsEditor}
				<!-- A transport failure blocks interaction without destroying this
				     identity's drafts. Credentials remain fail-closed in AdminContext. -->
				<div inert={!authPage && admin.status !== 'ready'}>
					{#key authPage ? 'auth' : admin.session?.user.id}{@render children()}{/key}
				</div>
			{/if}
			{#if !authPage && admin.status !== 'ready'}
				{#if !admin.retainsEditor && admin.status !== 'loading'}<header class={pageHeader}><h1 class={pageHeading}>{m.heading}</h1></header>{/if}
				<div class="min-h-40" aria-live="polite">
					{#if admin.status === 'loading'}
						<span class="sr-only" role="status">{m.loading}</span>
						{#if !admin.retainsEditor}
							<div class="space-y-6" aria-hidden="true">
								<Skeleton class="h-10 w-64 max-w-full" />
								<Skeleton class="h-5 w-80 max-w-full" />
								{#each [1, 2, 3] as row (row)}<div class="space-y-3 py-3"><Skeleton class="h-6 w-2/3" /><Skeleton class="h-5 w-1/2" /></div>{/each}
							</div>
						{/if}
					{:else if admin.status === 'signedOut'}
						<Alert.Message appearance="inline" variant="default" role="status">{m.signInRequired}</Alert.Message><Button variant="default" href={i18n.href(`/admin/login?next=${encodeURIComponent(stripLocale(page.url.pathname))}`)}>{m.signIn}</Button>
					{:else if admin.status === 'noAccess' || admin.status === 'revoked'}
						<Alert.Message appearance="inline" variant="default" role="status">{admin.status === 'revoked' ? m.revoked : m.noAccess}</Alert.Message>
						<Button type="button" variant="outline" onclick={() => admin.refresh()}>{m.retry}</Button>
						<Button type="button" variant="ghost" onclick={() => admin.signOut()}>{m.signOut}</Button>
					{:else}<Alert.Message appearance="inline" variant="destructive" role="status">{m.unavailable}</Alert.Message><Button type="button" variant="outline" onclick={() => admin.refresh()}>{m.retry}</Button>{/if}
				</div>
			{/if}
			</div>
		</section>
	</Sidebar.Inset>
</Sidebar.Provider>
