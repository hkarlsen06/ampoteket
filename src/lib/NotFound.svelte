<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Empty from '$lib/components/ui/empty';
	import * as Card from '$lib/components/ui/card';
	import Led from '$lib/Led.svelte';
	import { pageContainer, pageHeader, pageHeading, formActions, lede } from '$lib/ui';
	// Shared body for every error page: the locale `+error.svelte` (inside the
	// header/footer layout) and the root `+error.svelte` (the fallback for paths
	// that never match the locale layout, e.g. `/nb/...`). Copy comes from the
	// `notFound` dictionaries, links go through `localizeHref`; never hard-code
	// either here (docs/i18n.md §2).
	import { localizeHref, messagesFor, type Locale } from '$lib/i18n';
	import { page } from '$app/state';

	let {
		locale,
		status,
		showBrand = false
	}: { locale: Locale; status: number; showBrand?: boolean } = $props();

	const m = $derived(messagesFor(locale).notFound);
	const header = $derived(messagesFor(locale).header);
	const is404 = $derived(status === 404);
	// Closed sales: `(sales)/+layout.server.ts`. An announcement, not a fault, so no LED code.
	const soon = $derived(status === 503 && page.error?.message === 'SALES_CLOSED');
	const code = $derived(String(status));
	const homeHref = $derived(localizeHref('/', locale));
	const catalogHref = $derived(localizeHref('/p', locale));
	const helpHref = $derived(localizeHref('/contact', locale));
</script>

{#if showBrand}
	<div class={pageContainer({ class: "pt-4" })}>
		<Button variant="ghost" class="min-h-11 p-0" href={homeHref} aria-label={header.home}>
			<picture>
				<source media="(prefers-color-scheme: light)" srcset="/brand/wordmark-light.svg" />
				<img class="h-8 w-auto" src="/brand/wordmark.svg" alt="Ampoteket" width="756" height="139" />
			</picture>
		</Button>
	</div>
{/if}

<section class={pageContainer({ padding: 'page' })} aria-labelledby="missing-title">
	<Empty.Root class={["grid items-center gap-10 lg:gap-16", !soon && "lg:grid-cols-[1.05fr_1fr]"]}>
		<Empty.Header class={[pageHeader, 'mb-0 max-w-none text-left']}>
			<h1 id="missing-title" class={pageHeading}>{soon ? m.soonHeading : is404 ? m.heading : m.errorHeading}</h1>
			<Empty.Description class={lede}>{soon ? m.soonBody : is404 ? m.body : m.errorBody}</Empty.Description>
			<Empty.Content class={[formActions, "w-full max-w-none flex-row justify-start"]}>
				{#if is404}
					{#if page.data.salesOpen}<Button class="min-w-42" href={catalogHref}>{m.catalog}</Button>{/if}
				{:else if !soon}
					<!-- A full reload, so a failed load function or chunk runs again. -->
					<Button class="min-w-42" href={page.url.pathname + page.url.search} data-sveltekit-reload>{m.retry}</Button>
					<Button variant="outline" class="min-w-42" href={helpHref}>{m.help}</Button>
				{/if}
				<Button variant={soon || (is404 && !page.data.salesOpen) ? "default" : "outline"} class="min-w-42" href={homeHref}>{m.home}</Button>
			</Empty.Content>
		</Empty.Header>
		{#if !soon}
		<Empty.Media class="w-full" role="img" aria-label={code}>
			<Card.Root aria-hidden="true" class="w-full items-center justify-center border bg-secondary p-6 lg:p-12">
				<Led value={code} label={code} red size="display" />
			</Card.Root>
		</Empty.Media>
		{/if}
	</Empty.Root>
</section>
