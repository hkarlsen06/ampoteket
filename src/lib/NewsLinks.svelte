<script lang="ts">
	import Icon from '#lib/Icon.svelte';
	import ArrowUpRightIcon from 'phosphor-svelte/lib/ArrowUpRightIcon';
	import { Button } from '#lib/components/ui/button/index.js';
	import { getI18n } from '#lib/i18n/index.js';
	import type { NewsLink } from '#lib/news.js';

	let { links }: { links: NewsLink[] } = $props();
	const i18n = getI18n();
</script>

<ul class="m-0 grid list-none justify-items-start gap-1 p-0">
	{#each links as link, index (index)}
		<li><Button variant="link" class="justify-start text-left wrap-anywhere" href={link.url} target="_blank" rel="noreferrer">{link.label}<Icon icon={ArrowUpRightIcon} /><span class="sr-only"> {i18n.m.newTab}</span></Button></li>
	{/each}
</ul>
