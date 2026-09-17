<script lang="ts">
	// Fallback error page above the locale layout, for paths that never match it
	// (e.g. `/nb/...` — Norwegian is served unprefixed, so `/nb` is a 404 per
	// docs/i18n.md). No header/footer here, so the shared body renders its own
	// brand row. The locale comes from the URL prefix, exactly like
	// hooks.server.ts does for `<html lang>`.
	import { page } from '$app/state';
	import { localeFromPathname, messagesFor } from '$lib/i18n';
	import NotFound from '$lib/NotFound.svelte';

	const locale = $derived(localeFromPathname(page.url.pathname));
	const m = $derived(messagesFor(locale).notFound);
	const status = $derived(page.status);
</script>

<svelte:head>
	<title>{status === 404 ? m.title : m.errorTitle}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main>
	<NotFound {locale} status={status} showBrand />
</main>
