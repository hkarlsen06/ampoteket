<script lang="ts">
	import { page } from '$app/state';
	import AdminProductEditor from '#lib/AdminProductEditor.svelte';
</script>
<!-- `?from=` starts a new product from another; "Save and add another" adds `created`. -->
{#key `${page.params.id}${page.url.search}`}<AdminProductEditor id={page.params.id ?? ''} from={page.url.searchParams.get('from')} created={page.url.searchParams.has('created')} />{/key}
