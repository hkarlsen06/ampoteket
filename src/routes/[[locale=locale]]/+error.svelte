<script lang="ts">
	// Error page inside the locale layout: header, footer, language picker and
	// `<main>` all keep working, only the page body is replaced. Handles 404s
	// (`/fins-ikke`, `/en/no-such-page`) and any load failure under the locale.
	import { page } from '$app/state';
	import { getI18n } from '$lib/i18n';
	import NotFound from '$lib/NotFound.svelte';

	const i18n = getI18n();
	const m = $derived(i18n.m.notFound);
	const status = $derived(page.status);
</script>

<svelte:head>
	<title>{status === 404 ? m.title : m.errorTitle}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<NotFound locale={i18n.locale} status={status} />
