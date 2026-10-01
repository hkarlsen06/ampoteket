<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { lede, pageContainer, pageHeader, pageHeading, section, sectionHeading } from '$lib/ui';
	import { getI18n } from '$lib/i18n';
	const i18n = getI18n(); const m = $derived(i18n.m.privacy);
</script>
<svelte:head><title>{m.title}</title><meta name="description" content={m.description} /><meta property="og:title" content={m.title} /><meta property="og:description" content={m.description} /></svelte:head>
<div class={pageContainer({ width: 'reading', padding: 'page' })}>
	<header class={pageHeader}>
		<h1 class={pageHeading}>{m.heading}</h1>
		<p class={['m-0', lede]}>{m.lede}</p>
	</header>
	{#each m.sections as item, index (item.title)}
		<section class={section()} aria-labelledby={`privacy-${index}`}>
			<h2 id={`privacy-${index}`} class={sectionHeading}>{item.title}</h2>
			{#each item.paragraphs as text (text)}<p>{text}</p>{/each}
		</section>
	{/each}
	<div class={section()}><Button variant="outline" href={i18n.href('/help')}>{m.help}</Button></div>
</div>
