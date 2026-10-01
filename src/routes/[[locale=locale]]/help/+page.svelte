<script lang="ts">
	import Icon from '$lib/Icon.svelte';
	import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';
	import DiscordLogo from '$lib/DiscordLogo.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Alert from '$lib/components/ui/alert';
	import * as Item from '$lib/components/ui/item';
	import * as Empty from '$lib/components/ui/empty';
	import { itemTitle, pageContainer, pageHeader, pageHeading, section, sectionHeading } from '$lib/ui';
	import { DISCORD_INVITE, getI18n } from '$lib/i18n';
	import type { PageProps } from './$types';
	let { data }: PageProps = $props(); const i18n = getI18n(); const m = $derived(i18n.m.help);
</script>
<svelte:head><title>{m.title}</title><meta name="description" content={m.description} /><meta property="og:title" content={m.title} /><meta property="og:description" content={m.description} /></svelte:head>
<div class={pageContainer({ width: 'reading', padding: 'page' })}>
	<header class={pageHeader}><h1 class={pageHeading}>{m.heading}</h1></header>
	<div class="grid gap-3"><p>{m.references}</p><p>{m.payment}</p></div>
	<section class={section()} aria-labelledby="contacts-title">
		<h2 id="contacts-title" class={sectionHeading}>{m.contacts}</h2>
		{#if data.contacts === null}
			<Alert.Message role="status" appearance="inline" variant="destructive">{m.unavailable}</Alert.Message>
			<Button variant="outline" href={i18n.href('/help')} data-sveltekit-reload>{m.retry}</Button>
		{:else if !data.contacts.length}
			<Empty.Root><Empty.Description>{m.empty}</Empty.Description></Empty.Root>
		{:else}
			<Item.Group>
				{#each data.contacts as contact, index (contact.id)}
					{#if index > 0}<Item.Separator />{/if}
					<Item.Root variant="row" role="listitem" class="items-start">
						<Item.Content class="min-w-0 gap-1">
							<h3 class={itemTitle}>{contact.display_name}</h3>
							{#if contact.responsibility}<p class="text-muted-foreground">{contact.responsibility}</p>{/if}
							<div class="flex flex-wrap items-center gap-x-6">
								{#if contact.discord}<span class="inline-flex min-w-0 items-center gap-2 wrap-anywhere"><DiscordLogo class="size-4 shrink-0" /><span class="sr-only">{m.discordUser}: </span>{contact.discord}</span>{/if}
								{#if contact.email}<Button variant="link" class="justify-start text-left wrap-anywhere" href={`mailto:${encodeURIComponent(contact.email).replace('%40', '@')}`}>{contact.email}</Button>{/if}
								{#if contact.phone}<Button variant="link" href={`tel:${contact.phone.replace(/[ ()-]/g, '')}`}>{contact.phone}</Button>{/if}
								{#if contact.contact_url}<Button variant="link" class="justify-start text-left" href={contact.contact_url} target="_blank" rel="noreferrer">{m.contactLink(contact.display_name)}<span class="sr-only"> {i18n.m.newTab}</span></Button>{/if}
							</div>
						</Item.Content>
					</Item.Root>
				{/each}
			</Item.Group>
		{/if}
		<Button variant="outline" class="justify-self-start" href={DISCORD_INVITE} target="_blank" rel="external noopener"><DiscordLogo />{m.discord}<span class="sr-only"> {i18n.m.newTab}</span></Button>
	</section>
	{#if data.salesOpen}<div class={section()}><Button variant="link" href={i18n.href('/cart')}><Icon icon={ArrowLeftIcon} />{i18n.m.checkout.backToCart}</Button></div>{/if}
</div>
