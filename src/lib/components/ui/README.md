# Shared UI components

Project-owned Svelte components copied from the official
[shadcn-svelte registry](https://shadcn-svelte.com/registry) (CLI 1.7.0, **Nova**
style). Root `components.json` records the registry and aliases; interactive
primitives use Bits UI. The upstream [MIT license](LICENSE.md) is kept here.

How to use them (variants, layout, accessibility) is in the
[design system](../../../../docs/design-system.md#5-components-and-implementation).
The reference form is [AdminProductEditor.svelte](../../AdminProductEditor.svelte).
This file lists what differs from upstream, so updates do not undo it.

## Usage notes

- Import directly: `import { Button } from '#lib/components/ui/button'`.
- The field module exports `Field.Field`, not `Root`. Use `NativeSelect.Root` for
  native selects and `InputGroup` for unit affixes.
- Initialize `bind:ref` targets with `$state<HTMLButtonElement | null>(null)` (or the
  right element type), not `undefined`.
- Decimal inputs stay `type="text"` with `inputmode="decimal"` and string values.
- `Input` defaults to no autocomplete or capitalization and a next-key hint.
  Native input types keep their keyboard; override these defaults for names,
  search, credentials and final fields. `Textarea` uses sentence capitalization
  and a newline key. `InputGroup.Input` inherits `Input` defaults.
- Import Phosphor icons individually (`phosphor-svelte/lib/CheckIcon`) and render
  them through `#lib/Icon.svelte`.

## Local adaptations

Keep these when comparing with or updating from upstream:

- **Focus:** upstream `focus-visible:ring-*`/`border-ring` classes are removed; the
  unlayered global rule in `src/app.css` is the only focus style. Cards do not clip
  descendant focus rings. Focused sidebar items paint above neighbouring rows.
- **Sizes:** default buttons and inputs are 48px; compact buttons, menu items,
  `Command` items, tabs and toast dismiss targets keep 44px. Input text is ≥ 16px,
  content text ≥ `text-sm`. Button text wraps. Radii only from `sm`/`md`/`lg`/`xl`/`full`.
- **Disabled state:** readable colour plus a visible dashed border, never opacity.
  Disabled buttons (including disabled `href` buttons) paint their background under
  the dashed border; disabled `Slider` dashes its track and thumbs.
- **`control.ts`** shares the surface and states of Input, Textarea, NativeSelect and
  InputGroup. InputGroup takes the focus ring for the whole group; its inner input has
  none, embedded buttons keep their own. `Input` forwards a supplied `data-slot` so
  InputGroup selectors work. Field descriptions have no implicit margins.
- **`Button`:** framed variants (`default`, `outline`, `night`) are square with
  sans sentence-case labels, no mono or uppercase; `link` is link blue with no padding; `night` is the hero primary;
  only `default`/`sm`/`icon`/`icon-sm` sizes remain.
- **`ButtonLabel`** reserves idle and pending label sizes in overlapping grid cells;
  only the active label is exposed. `reserveLabels` covers save/retry alternatives.
- **`Badge`** is a `rounded-sm` chip (never a pill), `text-sm`, with `success`/`warning` variants.
  **`Alert`** has `warning`, `appearance="inline"` and `Alert.Message` (keeps the
  caller's announcement semantics). **`Empty.Root`** is start-aligned by default.
- **`Separator`** is decorative by default (`decorative={false}` for a meaningful
  break), with no extra margin. `Item.Group` removes gaps around direct
  `Item.Separator` children. `Item.Title`/`Description` wrap without line clamping.
  `Table` has no overflow wrapper.
- **`Toggle`** sets `aria-pressed` and `aria-checked` with fill and underline.
  `Slider` fills with `--foreground` and exposes `thumbProps(index)` for localized
  names and `aria-valuetext`. `Checkbox` is a plain check on the control surface.
  `Field.Field orientation="horizontal"` keeps a compact-size row.
- **`Dialog`:** `Content` defaults to `preventScroll={false}` (the site never locks
  scrolling) and no automatic close button; supply a localized close, or both
  `showCloseButton` and `closeLabel`. Centered content is bounded to `100dvh - 2rem`;
  portaled text wraps and bar-header close controls do not shrink. When content can
  overflow, use `auto minmax(0,1fr) auto` rows with a named, focusable `sheetBody`
  scroll region between header and footer, so title and actions stay reachable in
  landscape. `Dialog.Title` is `text-xl`; `Content`/`Footer` take `variant="sheet"`;
  `Dialog.Header` has `layout="bar"` and `density="compact"` (the scanner at 360×640).
- **`AlertDialog`:** no close icon, `preventScroll={false}`, initial focus on the
  enabled `Cancel`. `Cancel` closes; `Action` leaves closing to the caller after
  success. Content fits the dynamic viewport; Description wraps its warning in a
  contained, focusable scroll region between the title and actions. Supply its
  localized `aria-label` or `aria-labelledby`; this names the wrapper so the warning
  text still supplies the dialog's accessible description.
- **`Sidebar`:** below 48rem the upstream mobile branch uses our shared `Dialog` as a
  left sheet with localized title/close. `Sidebar.Content` is the named navigation
  scroll region (`overflow-y-auto overscroll-contain`).
- **`Command`/`Popover`** (admin order product combobox): search input on the shared
  control surface, with a nonshrinking input row; the combobox caps content to the
  popover's available height and lets the contained result list shrink. Its virtual
  anchor clips the trigger to the visual viewport when a keyboard covers it. Selected items keep
  a visible check. This project has no `CommandDialog` or `CommandLinkItem`.
- **`Menubar`:** no interior scroll region; callers keep action lists short.
- **`Sonner`:** `theme="system"`, semantic popover colours, localized container and
  close labels, dismiss icon on the right.
- **`Chart`** follows OS colour-scheme media queries in `ChartStyle`; `SalesChart`
  is the example (accessible daily-data disclosure, no animation). **`Tabs`** keep
  hidden panels mounted.
- **`ShelfDiagram`** (domain) uses Bits `Slider` directly for drawer resizing. Bits
  2.18 does not end a document drag on `pointercancel`, so the component resets the
  instance on cancellation, selection or disabled changes. Keep that guard when
  updating Bits.

## Adding and updating

```sh
bunx --no-install shadcn-svelte add <component>
```

Review the added source and lockfile changes, and apply the adaptations above.
Dependency upgrades do not update copied recipes: compare upstream with the current
files before applying changes, and never blindly overwrite local adaptations or
uncommitted work. After changing a shared control, run `bun run check`, build, and
the relevant browser workflow.
