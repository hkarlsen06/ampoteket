<script lang="ts">
	import { pageHeader, pageHeading } from '#lib/ui.js';
	import { getI18n } from '#lib/i18n/index.js';
	import AdminStatistics from '#lib/AdminStatistics.svelte';
	const i18n = getI18n();
</script>
<svelte:head><title>{i18n.m.adminStatistics.title}</title></svelte:head>
<header class={pageHeader}><h1 class={pageHeading}>{i18n.m.adminStatistics.heading}</h1></header>
<AdminStatistics />
