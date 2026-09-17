import { tv } from 'tailwind-variants';

// App-wide compositions of Tailwind utilities. Keep semantic markup at the call
// site; extend the shared shadcn components for control and surface variants.
// `padding: 'page'` is the one top/bottom rhythm for every operational page
// (not the marketing homepage), so headings sit at the same height everywhere.
export const pageContainer = tv({
	// `wrap-anywhere` is the overflow safety net for user text (long codes, names,
	// e-mail addresses); readable prose and product names opt into `nameWrap`.
	base: 'mx-auto w-full min-w-0 px-[var(--gutter)] wrap-anywhere',
	variants: {
		width: {
			wide: 'max-w-[var(--content-width)]',
			admin: 'max-w-[60rem]',
			reading: 'max-w-[52rem]'
		},
		padding: { none: '', page: 'pt-8 pb-16' }
	},
	defaultVariants: { width: 'wide', padding: 'none' }
});

// The block holding a page's h1 and, when present, its lede, meta line and
// page-level actions (in that order). Owns the one gap between heading and content.
export const pageHeader = 'mb-6 grid justify-items-start gap-3';
export const pageHeading = 'text-3xl font-bold leading-tight tracking-tight md:text-4xl';
export const sectionHeading = 'text-xl font-semibold leading-snug tracking-tight md:text-2xl';
// Section introduction (design-system §3): only when it adds context the heading lacks.
export const lede = 'max-w-[var(--measure-lede)] text-[1.0625rem] text-muted-foreground md:text-lg';
// Titles of rows in lists (products, orders, counts, contacts), heading or not.
export const itemTitle = 'm-0 text-base font-semibold leading-snug';
// Product codes, references and other identifiers in running UI.
export const codeText = 'font-mono text-sm';
export const formLayout = 'grid gap-5 [&>button]:justify-self-start';
// Dense editors: one column grid for every row, so field edges line up at all
// widths. Two columns on phones, four from 48rem; span wider fields explicitly.
export const formGrid = 'grid grid-cols-2 items-end gap-x-5 gap-y-4 md:grid-cols-4';
export const formActions = 'flex flex-wrap items-center gap-3';
// Keep the live region mounted so later feedback is announced; it takes no
// space without a child element, so idle forms and lists have no blank gap.
// (Not `:empty`: whitespace between sibling `{#if}` blocks counts as content.)
export const formStatus = 'my-4 min-h-12 space-y-2 text-sm [&:not(:has(*))]:my-0 [&:not(:has(*))]:min-h-0';
// `divided`: a first-child <Separator /> becomes the hairline across the section top.
export const section = tv({
	base: 'mt-8 space-y-4',
	variants: {
		spacing: {
			default: '',
			divided: 'relative pt-6 [&>[data-slot=separator]:first-child]:absolute [&>[data-slot=separator]:first-child]:inset-x-0 [&>[data-slot=separator]:first-child]:top-0'
		}
	},
	defaultVariants: { spacing: 'default' }
});
// Scrolling body of a `Dialog.Content variant="sheet"` (a named interior scroll region).
export const sheetBody = 'min-h-0 overflow-y-auto overscroll-contain px-4 py-5 md:px-6';
// A card whose heading link stretches over the whole card (catalog and admin grids).
export const cardLink = 'relative row-span-2 grid min-w-0 grid-rows-subgrid gap-4 overflow-visible p-4 md:p-5 hover:ring-muted-foreground has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--focus-contrast)]';
// Product names can be long single words (Norwegian compounds): hyphenate, never split mid-syllable.
export const nameWrap = 'wrap-break-word hyphens-auto';
