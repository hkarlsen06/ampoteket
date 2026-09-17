<script lang="ts">
	import { pageHeader, pageHeading } from '$lib/ui';
	import { getI18n } from '$lib/i18n';
	import AdminStatistics from '$lib/AdminStatistics.svelte';
	const i18n = getI18n();
</script>
<svelte:head><title>{i18n.m.admin.title}</title></svelte:head>
<header class={pageHeader}><h1 class={pageHeading}>{i18n.m.admin.overview}</h1></header>
<AdminStatistics overview />
