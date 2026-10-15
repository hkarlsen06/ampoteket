<script lang="ts">
	import { newsImageUrl, type NewsImage } from '#lib/news.js';

	// The stored size reserves the box before the image arrives, so nothing shifts.
	let { image, class: className = '', eager = false, crop = false }: { image: NewsImage; class?: string; eager?: boolean; crop?: boolean } = $props();
</script>

<img class={['block h-auto w-full rounded-xl bg-muted', crop && 'aspect-video object-cover', className]} src={newsImageUrl(image.id)} width={image.width} height={image.height}
	alt={image.alt} loading={eager ? 'eager' : 'lazy'} fetchpriority={eager ? 'high' : 'auto'} decoding="async" />
