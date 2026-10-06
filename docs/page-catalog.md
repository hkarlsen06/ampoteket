# `/p`: catalog

Implemented in `src/routes/[[locale=locale]]/(sales)/p/+page.{server.ts,svelte}`; URL parsing
and search in `src/lib/catalog-search.ts`, reads in `src/lib/catalog.ts`. Also at
`/en/p`.

## 1. Job and layout

Find an active product by code, name, category, specifications or cabinet/drawer, then
open its [product page](page-product.md). Cards have no quick-add: quantities are
chosen on the product page or in the [scanner](scanner.md) confirmation. Scanning alone
never changes a basket.

At 360 px: heading; one search field with a submit button; reserved error feedback;
product cards; «Vis flere» / "Show more". A query that is exactly one existing code
opens that product (also without JavaScript). A «Filtre» button opens a shared
`Dialog` with category, specification and location controls;
dismissing it discards the draft and returns focus. No match-count or refresh toolbar;
retry appears only on failure.

Each card is one link with name, code, category (omitted when the name starts with it),
price and unit, coordinates and recorded quantity with a status icon. Long text wraps,
never truncates. One, two (48rem) or three (64rem) columns, same DOM order; controls
stay above the results. Updates never move scroll or focus. Category images come from
`src/lib/CategoryGraphic.svelte` ([sources](../assets/components/README.md)); add an
asset and mapping when a new family needs one.

## 2. Loading and ownership

The server validates the URL and fetches the first page with `readCatalogPage` (50
rows). SQL filters before paging and stock aggregation, so search and exact lookup work
without JavaScript or a full-catalog read.

The browser reads `amp_catalog_facets` for category choices and the selected category's
recorded values. Only filter controls wait for facets; failures get a retry in the
dialog, and late responses never replace a draft. Main search changes only `q` and keeps
the submitted filters. Search text typed but not submitted survives reload and Back
(a SvelteKit `snapshot`).

Opening the dialog reads `amp_shelf_map`. Location uses `LabelShelfSelection`, shared
with [label printing](page-labels.md). Locations combine with OR; none means no
constraint. Whole cabinets serialize as cabinet IDs, partial ones as drawer IDs, so a
cabinet filter follows its current drawers and a drawer filter follows a moved drawer.
A saved location that no longer exists stays an error until cleared, never silently
broadening results.

**Paging.** Within 300 px of the end, or on "Show more", fetch the page after the last
code; keep cards, focus and scroll. Only an empty page proves the end (a short page may
be the Data API row cap). Duplicate rows or a failed page stop loading and retry that
page; never restart and mix traversals. Appends are announced politely. A new query
resets the rows. Back restores rows before scroll, and the submitted query, not an
unsaved draft. The count covers visible products only. A vanished cursor offers a
return to page one. Without JavaScript, next-page links replace infinite loading.

## 3. URL and matching rules

Build query strings with `URLSearchParams` and links with `i18n.href`; the same query
works in both locales. Saved data is plain text; never interpret markup.

| Parameter | Meaning |
|---|---|
| `code` | Homepage code form. Trim, uppercase, validate the 1–40 character code grammar, redirect to `/p/[code]`. Wins over browse parameters. Invalid input shows an error. |
| `q` | Text, at most 200 characters. Exactly one existing code (no filters, no cursor) redirects to `/p/[code]`; otherwise, or if the probe fails, it is a text search. |
| `category` | Exact saved `category_name` (the public response has no category ID). Repeatable, OR. |
| `cabinet`, `bin` | Lowercase UUIDs of live cabinets/drawers, up to 100 and 4,096. Repeatable, OR. |
| `eq.<attribute_code>` | Exact numeric, text or boolean value. |
| `min.<…>`, `max.<…>` | Inclusive numeric bounds in the canonical unit. |
| `after` | Last displayed code, for the next page. |

- Only `category`, `cabinet` and `bin` repeat. Duplicates, repeated other keys, exact
  plus range on one attribute, bad decimals or booleans, `min > max`, type mismatches
  and unknown or archived categories, attributes or locations are visible errors with a
  way to remove them. Never drop a filter and broaden results.
- Ignore unrecognized keys and allowlist the names above when serializing; never echo
  arbitrary parameters into canonical, alternate or social URLs.
- SQL validates `after` against published products.

**Search** splits `q` on whitespace, normalizes and case-folds, and requires every term
in the code (with or without hyphens), either name, description, category (both
languages) or a formatted specification. A measurement also matches without the space
before its unit (`10k`, `10kΩ` and `100n` find `10 kΩ` and `100 nF`). Substring only:
no fuzzy ranking, no guessing from model names. Results keep database code order.
Staff product search uses the same matcher (`catalogSearchText`).

**Compact codes.** Manual lookup trims and ignores case and tries the exact code first.
Only a valid empty response permits retrying eight characters as three letters, hyphen,
five hex digits (`res00026` → `RES-00026`). Never drop zeros, guess digits or treat a
failed read as missing. This applies to the homepage, catalog, product route and cart
input; scanned and pasted label URLs use exact lookup only.

**Filters.** Categories are OR; categories, locations, text and each specification
condition are AND. Specification controls appear when exactly one category is selected,
from values recorded for it. Text matches case-sensitively; booleans are any/yes/no.
Selected options stay visible at zero matches. A missing value matches no condition and
never becomes `0`, `false` or empty. Changing category clears its specification draft.

Numeric specifications use a two-handle `Slider` over the category's distinct recorded
values. A handle at either end removes that bound, so parts without the value are not
excluded. Joined handles submit `eq.`. A restored link keeps its exact values until a
handle moves.

**Decimals.** Conditions are decimal strings; the URL uses a dot and no grouping.
Compare normalized strings; never `parseFloat`, `Number` or the six-decimal quantity
validator (a slider handle is a tick index). SI prefixes come only from the explicit
unit table (`0.000000000005 F` → `5 pF`), shifting digits without rounding. Tests must
cover values below six fractional digits and beyond JavaScript's exact integer range.

## 4. States

| State | Page behavior |
|---|---|
| Facets loading | Rows and search work; only filter controls wait. |
| Matching products | Results, with more appended; zero/negative balances stay visible. |
| Empty catalog | Say no products are published, distinct from zero matches. |
| Zero matches | Keep the filters and offer to clear them. |
| HTTP, network, decoding or paging failure | Unavailable with retry; keep query and previous rows. |
| Camera denied or unknown QR | Manual entry stays usable in the scanner dialog. |

Stock badges pair a label with an icon. A negative balance is shown, never clamped to
zero. Buyers see no low-stock state; the minimum is staff-only.

## 5. Acceptance

`./scripts/test-web.sh --shop` covers catalog, product and cart in a browser
(1,000 products under a 37-row cap, filters, paging failures, no JavaScript). Results
and open checks are in [VALIDATION.md](../VALIDATION.md).
