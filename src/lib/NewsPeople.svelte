<script lang="ts">
	import * as Popover from '#lib/components/ui/popover/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import Icon from '#lib/Icon.svelte';
	import DiscordLogo from '#lib/DiscordLogo.svelte';
	import UserIcon from 'phosphor-svelte/lib/UserIcon';
	import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
	import CopyIcon from 'phosphor-svelte/lib/CopyIcon';
	import { itemTitle } from '#lib/ui.js';
	import { getI18n } from '#lib/i18n/index.js';
	import type { NewsPerson } from '#lib/news.js';

	// Tagged volunteers: a name opens their /contact details in place. Without
	// JavaScript the name links to the same person on the contact page.
	let { people }: { people: NewsPerson[] } = $props();
	const i18n = getI18n();
	const m = $derived(i18n.m.news);
	const help = $derived(i18n.m.help);
	let copied = $state<string | null>(null); let copiedTimer: ReturnType<typeof setTimeout> | undefined;
	async function copyDiscord(id: string, username: string) {
		try { await navigator.clipboard.writeText(username); } catch { return; }
		copied = id; clearTimeout(copiedTimer); copiedTimer = setTimeout(() => (copied = null), 2000);
	}
</script>

<ul class="m-0 flex list-none flex-wrap gap-2 p-0">
	{#each people as person (person.id)}
		<li>
			<Popover.Root>
				<Popover.Trigger class="no-js:hidden">
					{#snippet child({ props })}
						<Button {...props} variant="outline" size="sm" aria-label={m.personDetails(person.display_name)}><Icon icon={UserIcon} />{person.display_name}</Button>
					{/snippet}
				</Popover.Trigger>
				<Popover.Content align="start" collisionPadding={16} class="w-80 max-w-[calc(100vw-2rem)] gap-3 p-4 wrap-anywhere">
					<div class="grid gap-1">
						<p class={itemTitle}>{person.display_name}</p>
						{#if person.responsibility}<p class="text-muted-foreground">{person.responsibility}</p>{/if}
					</div>
					<div class="grid justify-items-start">
						{#if person.discord}{@const username = person.discord}<Button variant="link" class="justify-start text-left wrap-anywhere no-underline" onclick={() => copyDiscord(person.id, username)}><DiscordLogo /><span class="sr-only">{`${help.copyDiscord}: `}</span>{username}<Icon icon={copied === person.id ? CheckIcon : CopyIcon} /></Button>{/if}
						{#if person.email}<Button variant="link" class="justify-start text-left wrap-anywhere" href={`mailto:${encodeURIComponent(person.email).replace('%40', '@')}`}>{person.email}</Button>{/if}
						{#if person.phone}<Button variant="link" href={`tel:${person.phone.replace(/[ ()-]/g, '')}`}>{person.phone}</Button>{/if}
						{#if person.contact_url}<Button variant="link" class="justify-start text-left" href={person.contact_url} target="_blank" rel="noreferrer">{help.contactLink(person.display_name)}<span class="sr-only"> {i18n.m.newTab}</span></Button>{/if}
					</div>
				</Popover.Content>
			</Popover.Root>
			<Button variant="outline" size="sm" class="hidden no-js:inline-flex" href={i18n.href(`/contact#contact-${person.id}`)}><Icon icon={UserIcon} />{person.display_name}</Button>
		</li>
	{/each}
</ul>
<p class="sr-only" role="status">{#if copied}{help.discordCopied}{/if}</p>
