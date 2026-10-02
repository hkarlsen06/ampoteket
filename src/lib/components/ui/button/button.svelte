<script lang="ts" module>
	import { type VariantProps, tv } from "tailwind-variants";
	import { cn, type WithElementRef } from "#lib/utils.js";
	import Brackets from "#lib/Brackets.svelte";
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from "svelte/elements";

	export const buttonVariants = tv({
		base: "relative aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 rounded-lg border border-transparent bg-clip-padding text-base text-foreground font-semibold aria-invalid:ring-3 active:not-aria-[haspopup]:translate-y-px [&_svg:not([class*='size-'])]:size-4 group/button inline-flex min-w-0 max-w-full items-center justify-center whitespace-normal wrap-break-word text-center no-underline transition-colors outline-none select-none disabled:pointer-events-none disabled:border-dashed disabled:border-current disabled:bg-clip-border aria-disabled:pointer-events-none aria-disabled:border-dashed aria-disabled:border-current aria-disabled:bg-clip-border [&_svg]:pointer-events-none [&_svg]:shrink-0",
		variants: {
			variant: {
				// Wireframe primary: a tinted panel, hairline border and corner marks.
				default: "border-primary/40 bg-[color-mix(in_oklab,var(--primary)_10%,var(--background))] text-primary-ink hover:bg-[color-mix(in_oklab,var(--primary)_18%,var(--background))]",
				outline: "border-input bg-card hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
				secondary: "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
				ghost: "hover:bg-muted hover:text-foreground dark:hover:bg-muted/50 aria-expanded:bg-muted aria-expanded:text-foreground",
				destructive: "bg-destructive/10 hover:bg-destructive/20 dark:bg-destructive/20 text-destructive dark:hover:bg-destructive/30",
				// Inline links: the link blue, like every other anchor; never brand red.
				link: "text-link px-0 underline underline-offset-[0.15em] hover:decoration-2",
				// The primary on the always-dark hero (`--night`), with the sign's red.
				night: "border-[color-mix(in_oklab,var(--night-accent)_40%,transparent)] bg-[color-mix(in_oklab,var(--night-accent)_10%,var(--night))] text-night-accent hover:bg-[color-mix(in_oklab,var(--night-accent)_18%,var(--night))]",
			},
			size: {
				default: "min-h-12 h-auto gap-2 px-5 py-2 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
				sm: "min-h-11 h-auto gap-1.5 rounded-lg px-3 text-sm in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5",
				icon: "size-12",
				"icon-sm": "size-11",
			},
		},
		// Square corners for the framed variants; links keep the text edge. After the size classes.
		compoundVariants: [
			{ variant: ["default", "outline", "night"], class: "rounded-none" },
			{ variant: "link", class: "px-0 font-normal" },
		],
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	});

	export type ButtonVariant = VariantProps<typeof buttonVariants>["variant"];
	export type ButtonSize = VariantProps<typeof buttonVariants>["size"];

	export type ButtonProps = WithElementRef<HTMLButtonAttributes> &
		WithElementRef<HTMLAnchorAttributes> & {
			variant?: ButtonVariant;
			size?: ButtonSize;
		};
</script>

<script lang="ts">
	let {
		class: className,
		variant = "default",
		size = "default",
		ref = $bindable(null),
		href = undefined,
		type = "button",
		disabled,
		children,
		...restProps
	}: ButtonProps = $props();
</script>

{#if href}
	<a
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		href={disabled ? undefined : href}
		aria-disabled={disabled}
		role={disabled ? "link" : undefined}
		tabindex={disabled ? -1 : undefined}
		{...restProps}
	>
		{@render children?.()}
		{#if variant === "default" || variant === "night"}<Brackets class="-inset-px" />{/if}
	</a>
{:else}
	<button
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		{type}
		{disabled}
		{...restProps}
	>
		{@render children?.()}
		{#if variant === "default" || variant === "night"}<Brackets class="-inset-px" />{/if}
	</button>
{/if}
