<script lang="ts">
	import { page } from '$app/state';
	import AdminProductEditor from '$lib/AdminProductEditor.svelte';
</script>
{#key page.params.id}<AdminProductEditor id={page.params.id ?? ''} />{/key}
