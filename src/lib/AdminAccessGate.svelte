<script lang="ts">
	import type { Snippet } from 'svelte';
	import { getAdminContext } from '#lib/admin-context.svelte.js';
	import { getI18n } from '#lib/i18n/index.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Button, ButtonLabel } from '#lib/components/ui/button/index.js';
	let { children, active = true }: { children: Snippet; active?: boolean } = $props();
	const admin = getAdminContext();
	const i18n = getI18n();
	let checking = $state(false);
	async function retry() {
		if (checking) return;
		checking = true;
		try { await admin.refresh(); } finally { checking = false; }
	}
</script>

<!-- Dialog portals escape the admin layout's inert boundary. Keep recovery in the dialog. -->
{#if active && admin.status !== 'ready'}
	<div class="mb-4 grid justify-items-start gap-2">
		<Alert.Message appearance="inline" variant="destructive" role="alert">{i18n.m.admin.accessUnavailable}</Alert.Message>
		<Button type="button" variant="outline" disabled={checking || admin.status === 'loading'} onclick={retry}><ButtonLabel pending={checking || admin.status === 'loading'} pendingLabel={i18n.m.admin.loading} label={i18n.m.admin.retry} /></Button>
	</div>
{/if}
<div class="contents" inert={active && admin.status !== 'ready'}>{@render children()}</div>
