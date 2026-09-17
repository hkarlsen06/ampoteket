<script lang="ts">
	let { label, pendingLabel, pending, reserveLabels = [] }: { label: string; pendingLabel: string; pending: boolean; reserveLabels?: string[] } = $props();
</script>

<!-- All labels participate in sizing; only the current label is announced. -->
<span class="grid min-w-0">
	<span class={['col-start-1 row-start-1', pending && 'invisible']} aria-hidden={pending}>{label}</span>
	<span class={['col-start-1 row-start-1', !pending && 'invisible']} aria-hidden={!pending}>{pendingLabel}</span>
	{#each reserveLabels as reserved, index (index)}<span class="invisible col-start-1 row-start-1" aria-hidden="true">{reserved}</span>{/each}
</span>
