# API transport and exact values

How the frontend reaches the Convex backend and the Worker's checkout API without
losing precision, and what each shared read returns. The backend computes
quantities, money, checkout totals and revisions; tables, functions and access
rules are in [datamodell.md](datamodell.md), and `convex/schema.ts` with
`convex/*.ts` is the final word.

## Clients

- Clients reach Convex only through the native clients and the generated, typed
  `api` (`convex/_generated/api`, re-exported by `src/lib/convex.ts`). No raw HTTP
  calls to the deployment, no other SDK.
- Browser: one `ConvexClient` from convex-svelte, set up in
  `src/routes/[[locale=locale]]/+layout.svelte`. It carries the staff session token
  from `src/lib/convex-auth.svelte.ts` when someone is signed in. Staff code gets
  `{ client, userId }` from `admin.credentials()` (`src/lib/admin-context.svelte.ts`),
  which throws unless membership is confirmed.
- Server: `serverConvex()` in `src/lib/server/convex.ts` returns an
  unauthenticated `ConvexHttpClient` for SSR loads. The checkout gateway makes its
  own client whose every request gives up after 15 seconds.
- Modules take a `ConvexCaller` (`src/lib/convex.ts`), which both clients satisfy
  and tests replace with a stub.
- The deployment URL is `PUBLIC_CONVEX_URL`. In development `browserConvexConfig`
  sends the browser to `/convex` on the page's own origin instead
  (`CONVEX_DEV_PROXY`, [website-guide.md](website-guide.md) §1.1).
- Live queries: screens that must follow changes subscribe with convex-svelte's
  `useQuery` and pass `'skip'` until the admin context is ready. Today these are the
  admin audit, products, counts list and count detail pages, `AdminProductEditor`,
  `DrawerNeighbours` and the product page `/p/[code]` (seeded with the SSR result).
  A new result replaces the old one; keep input, selection and focus. Other reads
  are one-shot `client.query` calls on open, after a registered change, and on
  focus, visibility and reconnect.
- A Convex call cannot be cancelled. `abortable()` in `src/lib/catalog.ts` rejects
  at once when its signal aborts and drops the late result.

## Exact JSON values

- Quantities, prices, money, specification numbers, `metadata_revision`,
  `edit_revision`, stock revisions, movement IDs and audit entry IDs travel as exact
  decimal strings in both directions. Values such as `999999999998.999999` and
  `9007199254740993` must survive an unedited round trip. Never convert them to
  numbers; compare them with `src/lib/decimal.ts` or `BigInt`, not as JavaScript
  strings. No decimal library is needed; the backend computes amounts.
- One exception: `stock.inventory` returns `revision` as a number (a safe integer
  from the `counters` sequence). `inventoryStock()` in `src/lib/admin-products.ts`
  turns it into a string before anything else sees it.
- Structural integers are numbers: shelf coordinates, grid sizes and spans, order
  line numbers and help `display_order`. Check them with `Number.isSafeInteger` and
  their range before use.
- The backend checks every decimal it receives (`convex/lib/decimal.ts`):
  quantities ≤ 6 decimals and at most 999999999999 in magnitude, unit prices ≤ 6
  decimals, NOK amounts ≤ 2 decimals. Excess precision is rejected
  (`INVALID_QUANTITY`, `INVALID_PRICE`, `INVALID_AMOUNT` or the command's own code),
  never rounded. Totals are rounded per line to øre, half away from zero, by the backend.
- Timestamps are UTC ISO strings with six fractional digits, so string order is
  time order. Display them in `Europe/Oslo`.
- Optional fields are explicit `null`. A typed result is still validated: each
  screen checks the shape (parsers in `src/lib/catalog.ts`, `shelf-map.ts`,
  `help.ts` and `admin-*.ts`) and shows an unavailable state on invalid data, never
  an empty list or a zero.
- The Worker's own checkout JSON API is different: the browser decodes it with
  `requestApiJson` from `src/lib/api.ts`, which parses the raw text with
  `lossless-json` so **every numeric token becomes a string**. Never use
  `Response.json()` or `JSON.parse` there. Its deadline is 15 seconds by default
  and 25 seconds for checkout calls (`src/lib/checkout.ts`); a timeout means the
  write is uncertain, never that it rolled back. Requests use `redirect: 'manual'`
  and reject redirects, so checkout bodies never reach a redirect target. The
  helper never logs URLs, tokens, contact text or bodies. When updating
  `lossless-json`, run `bun test src/lib/api.test.ts` and `bun run check`.

## Errors and uncertain outcomes

- A rejected command throws `ConvexError({ code, message })` (`fail()` in
  `convex/lib/errors.ts`); the message may add a detail after `:`. Read the code
  with `errorCode(error)` and the message with `errorMessage(error)` from
  `src/lib/convex.ts`. The codes and their UI treatment are in
  [website-guide.md](website-guide.md) §8.1.
- Only a code proves that the whole mutation rolled back. No code (network failure,
  timeout, an argument the validator refused, a server bug) means the outcome of a
  write is unknown: keep the request ID and exact payload and retry the same command.
- `STAFF_REQUIRED` means access changed. Call `admin.permissionFailure(error)`; the
  live membership already shows the new state.
- `shelf.updateCabinet`, `shelf.updateBin`, `orders.updateOrder` and
  `orders.updateOrderLine` answer `'stale'` instead of throwing when the row as
  shown changed, and `'saved'` also for a retry that already applied.

## Idempotent commands

Commands that change stock, orders, storage, checkouts or membership take a
`requestId`: `stock.adjust`, `stock.withdraw`, `stock.recordSingleCount`,
`stock.correctAndCount`, `stock.startCountBatch`, `stock.recordCount`,
`stock.closeAbandonedCountBatch`, `orders.recordOrder`, `orders.recordReceipt`,
`orders.cancelQuantities`, `orders.reverseCancellation`, `shelf.saveLayout`,
`shelf.archiveCabinet`, `shelf.swapBins`, `shelf.swapCabinets`,
`checkout.prepare` (through the Worker), `checkout.recover`, `members.invite` and
`members.deactivate`.

- `convex/lib/commands.ts` stores the first completion in `command_requests`. A
  repeat with the same request ID, command, actor and input (SHA-256 of the
  key-sorted JSON) returns the stored result without acting again. Anything else
  with that ID fails with `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT`; an ID that
  is not a UUID fails with `REQUEST_ID_REQUIRED`. Concurrent duplicates serialize:
  one runs, the others find its result.
- Create a fresh UUID per intention. Persist the exact command (actor, request ID,
  payload, generated UUIDs and codes) before sending, and resend it unchanged after
  an uncertain result. The admin screens keep pending commands per user in
  `localStorage` (for example `ampoteket:admin-member-command:v1` and
  `ampoteket:admin-recovery:v1`).
- Other writes are repeat-safe by their guards: `products.save`,
  `products.setAttribute`, `products.rename` and `help.save` return success when
  the stored values already equal the new ones; `products.createDefinition` returns
  the existing ID for the same definition; `help.reorder` accepts an order that is
  already current; `stock.finishCountBatch`, `checkout.confirm` and
  `checkout.clearContact` may be repeated.

## Catalog and topology

`src/lib/catalog.ts` wraps the public catalog: lookups, single pages and complete
traversal. Transport, shape and cursor errors stay errors, distinct from an empty result.

- `catalog.page({ q?, categories?, conditions?, cabinetIds?, binIds?, binId?, afterCode?, limit? })`
  returns `{ products, complete, nextAfterCode }`: active products in catalog
  order. The backend owns the order, from `catalogSort` in
  `src/lib/product-specifications.ts`: listed categories first, in that order, each
  sorted by its primary attribute's value with missing values last; then other
  categories by name; uncategorised products last; ties by `name_nb`, then code
  ([order](page-catalog.md#3-url-and-matching-rules)). `limit` is 1–200 (default
  200; otherwise `INVALID_CATALOG_PAGE_SIZE`).
- `conditions` maps an attribute code to `{ eq }` or `{ min?, max? }` (numbers
  only). The backend validates the whole query before matching: more than 200
  search characters, more than 100 categories or duplicates raise
  `INVALID_CATALOG_QUERY`; unknown categories `UNKNOWN_CATALOG_CATEGORY`; an
  attribute no product in scope has `UNKNOWN_CATALOG_ATTRIBUTE`; a malformed
  condition or bound `INVALID_CATALOG_FILTER`. A number range matches a condition it overlaps.
- `q` is matched by `catalogSearchText` and `matchesSearch` from
  `src/lib/catalog-search.ts`, the same code the shop uses, so bilingual and SI
  search matches what is displayed. Code search also matches codes without hyphens
  (`res00026` finds `RES-00026`).
- `cabinetIds` (up to 100) and `binIds` (up to 4,096) select any listed location,
  intersected with the other filters; both empty means everywhere. Duplicates and
  unknown or archived IDs raise `INVALID_CATALOG_FILTER`, even when nothing else
  matches. `binId` selects one drawer. Drawer selection follows the stable drawer
  identity across moves.
- Each row's `attributes` maps codes to `{ label, unit, value_type, value, max }`.
  `max` is the upper bound of a number range as a decimal string (`value` is then
  the lower one) and null otherwise; text and boolean values carry no `max`.
- Each row's `distinguishing` lists up to two attribute codes that tell it from active look-alikes: products in its category with the same primary value or, without one, the same normalized `name_nb`. Codes come in the category's order from `catalogSort`, then the rest by code; one is kept only if it splits members that still look alike, until all differ. A missing or empty value counts as different. Every member gets the same list, computed over the whole active catalog, so it is the same for a lookup, a filter or any page. Empty when nothing looks alike; members with no differing specification stay alike until one is entered. A code may name a value the row lacks.
- To page, send `nextAfterCode` as `afterCode` with the same query and stop when
  `complete` is true. The next page starts after that product's current position in
  the whole catalog order, so a cursor outside the current filter still works; a
  cursor code that is no longer active raises `CATALOG_CURSOR_MISSING`, shown as a
  return-to-start error. If staff change a cursor product's primary value or name
  while someone pages, rows can repeat or be skipped: `readCatalogPage` rejects a
  page that repeats the cursor or is empty but incomplete, and `readCompleteCatalog`
  rejects repeated codes and offers the retry. The visible count describes only
  rendered rows.
- `readCompleteCatalog` is for operations that need every matching row (such as one
  drawer's contents). A failed complete read never publishes a partial result.
- `catalog.product({ code })` returns one active product or null.
  `lookupCatalogProduct` can also try the hyphenated form of a compact code.
- `catalog.facets({ categories? })` returns `{ categories, attributes }`: every
  category name with active products, and for the selected categories each
  attribute's definition and values (number values and range bounds ascending,
  distinct text values, none for booleans). One complete value, never truncated.
- The catalog is live; pages are not a point-in-time export.

`catalog.shelfMap()` returns `{ cabinets, bins }`, complete and ordered, including
empty storage and excluding archived storage. Each bin has `has_products`, true if
any product (even inactive or zero stock) is assigned. Use that flag to show
unassigned drawers; never infer emptiness from missing catalog rows or a failed
read. `parseShelfTopology` in `src/lib/shelf-map.ts` validates duplicates, parents,
grid fit and overlaps. Only selecting an assigned drawer triggers a drawer-scoped
catalog read. The map exposes placement only, never stock, costs, staff or contacts.

## Public volunteer directory

`catalog.helpDirectory()` returns every published contact in display order, one
complete list, with exactly `id`, `display_name`, `responsibility`, `email`,
`phone`, `contact_url`, `discord` and `display_order`. `readHelpDirectory` in
`src/lib/help.ts` rejects duplicates and unreachable entries; keep "unavailable"
distinct from "empty".

Staff edit with their own session:

- `help.list()` returns every contact, drafts included, in display order, with
  `edit_revision` as a decimal string.
- `help.save({ id, revision, fields })` creates a contact with a fresh client UUID
  and `revision: null`, so a lost response can be reconciled, or edits one with the
  `edit_revision` shown. `fields` holds `display_name`, `responsibility`, `email`,
  `phone`, `contact_url`, `discord` and `is_published`; send blank optional contact
  methods as `null`. If the stored values already equal `fields`, it returns the
  current row. Otherwise a different revision raises `STALE_HELP_CONTACT`: someone
  else edited, so keep the draft, refresh and review, never overwrite.
  `INVALID_HELP_CONTACT` names the bad field after `:`, and
  `HELP_CONTACT_NOT_REACHABLE` refuses a published contact without any contact
  method. Entries cannot be deleted; unpublish instead.
- Never send `display_order`: a new contact goes last. `help.reorder({ ids, expectedIds })`
  takes every contact ID, drafts included, in both the desired order and the order
  displayed before the move, and renumbers from 0. A move does not advance
  `edit_revision`. `STALE_HELP_ORDER` means contacts or their order changed: re-read
  and let the user move again. A retry whose desired order is already current
  succeeds without another write.

## News and events

Public reads run on the Worker during SSR with an unauthenticated `ConvexHttpClient`.
Every page reads only published rows; a failed read renders as unavailable, never as
"no news".

- `news.feed({ before, limit })` returns published articles newest first by
  `(published_at, id)` with `id`, `slug`, `title`, `summary`, `published_at`,
  `cover` (the first image) and `event` (the linked published event, else null).
  `limit` is 1–100 (`INVALID_NEWS_PAGE_SIZE`); `before` is null or the
  `{published_at, id}` of the last article shown (`INVALID_NEWS_CURSOR`). The
  newsroom reads one row more than it shows to know whether an older page exists.
- `news.calendar({ from, to, after, limit })` returns published events overlapping
  `[from, to)` by `(starts_at, id)`; the range is at most 400 days
  (`INVALID_EVENT_RANGE`) and `limit` 1–500. Page with `after` (`{starts_at, id}`
  of the last row) until a page is empty, and reject cursors that do not advance.
- `news.article({ slug })` and `news.event({ slug })` return one published row, or
  null. Images carry `id`, `alt`, `width` and `height`; people carry the
  `catalog.helpDirectory` fields of published contacts only, in tag order.
- `news.image({ id })` returns `content_type` and the bytes only while a published
  row uses the image. The Worker serves it at `/api/news/images/<id>` with
  `Cache-Control: public, max-age=3600`, `nosniff` and a sandboxing CSP.

Timestamps are UTC ISO strings with six fractional digits.

Staff write with their own session:

- `news.addImage({ id, contentType, data, width, height })` stores a re-encoded
  image (bytes, at most 1,000,000, WebP, JPEG or PNG whose signature matches the
  type). The client picks the ID; a retry with the same bytes returns it, other
  bytes raise `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT`.
- `news.save({ requestId, article, event })` takes each side as null (left
  untouched) or the complete row, plus `expected_revision` (null to create, else
  the `edit_revision` string the editor read). Unknown keys and wrong types fail
  argument validation; out-of-range text raises `INVALID_NEWS`. Event times are ISO
  instants with an offset; the editor converts Oslo wall time and asks again for a
  time that happens twice when the clocks go back. The event's `article_id` is the
  link: null unlinks, and when both sides are sent it must be the article beside
  it. A revision mismatch raises `STALE_NEWS` (refresh and review, never resubmit a
  rebuilt command automatically); a slug already in use raises `NEWS_SLUG_TAKEN`;
  an article that already has another event raises `EVENT_ARTICLE_TAKEN`. The
  result is `{ article: {id, slug, edit_revision} | null, event: {...} | null }`,
  and a retry with the same request ID returns it unchanged.
- Editors read `news.list` (every article and event, drafts included) and preview
  stored images with `news.adminImage`.

## Staff membership and invitations

Every membership function except `members.me` requires an active staff member's own
session; non-staff and inactive callers get `STAFF_REQUIRED`. The actor comes from
the session, never a submitted staff ID.

`members.me()` returns null when signed out, otherwise
`{ authUserId, email, membership: { id, authUserId, displayName } | null }`.
`AdminContext` subscribes to it, so revocation shows at once in every tab.

`members.list()` returns every membership, active first, then by name:

```text
[{ id, authUserId: uuid | null, displayName, email: string | null,
   isActive: boolean, emailConfirmed: boolean }]
```

The UI shows a deleted account when `authUserId` is null, inactive when
`isActive` is false, pending when the active account's email is unconfirmed, and
active otherwise. Email comes from the Auth account and is visible only to active staff.

`members.invite` is an action. Request and success result:

```text
{ requestId: uuid, email: string, displayName: string, locale: "nb" | "en", targetId: uuid | null, targetActive: boolean | null }
{ status: "invited" | "existing_account", staffId: uuid }
```

- It first runs the internal mutation `members.grantAccess`, one transaction that
  rechecks the inviter, applies the rate limit (10 per minute per inviter,
  `RATE_LIMITED`; retries count), trims and lower-cases the email
  (`STAFF_EMAIL_REQUIRED`, at most 254 characters), checks the name
  (`STAFF_DISPLAY_NAME_REQUIRED`, at most 120 characters) and is idempotent by
  `requestId`. It creates the Convex Auth user without a password if none exists,
  then grants or reactivates the membership, audited with the inviter as actor.
- For a resend or reactivation, `targetId` binds the request to the listed
  membership and `targetActive` to its current access state; send both or neither
  (`INVALID_ADMIN_INVITATION`). A changed identity or access state raises
  `INVITATION_SUPERSEDED` before any write, so a stale resend cannot reactivate
  someone, and a targeted address without an account raises `STAFF_USER_NOT_FOUND`.
  New invitations send null for both.
- A replay of a completed grant returns its result, but raises
  `INVITATION_SUPERSEDED` if the membership was deactivated afterwards, preserving
  that deactivation.
- An account whose email is already confirmed keeps its password: the result is
  `existing_account` and no email is sent. Otherwise the action stores a new
  single-use invite link (valid 7 days; it voids the user's earlier unused links)
  and sends it through Resend from `Ampoteket <noreply@notify.ampoteket.no>`
  (`convex/lib/email.ts`, templates in `convex/lib/emailTemplates.ts`).
- Email delivery is separate from the transaction. `INVITATION_EMAIL_FAILED` means
  membership is saved but delivery failed; retry the same command to send a new
  link. An uncertain result never means access was rolled back.

`members.deactivate({ requestId, staffId })` returns the membership UUID and sets it
inactive. `STAFF_SELF_DEACTIVATION` forbids deactivating the caller;
`STAFF_NOT_FOUND` rejects an unknown target. Each access change rereads the caller's
own membership in its transaction, so mutual deactivation cannot disable both callers.

Password links and sign-in:

- Links have the form
  `<SITE_URL>[/en]/admin/password?next=/admin&token_hash=<64 hex>&type=invite|recovery`.
  Only the SHA-256 of the token is stored.
- `passwords.requestReset({ email, locale })` (action) always returns null, whether
  or not the address has an account, and sends a reset link valid for one hour.
  `INVALID_EMAIL` refuses an empty or over-long address; `RATE_LIMITED` applies
  above 20 requests per minute overall or 1 per minute per address.
- `passwords.checkLink({ token })` returns `{ valid }` and consumes nothing.
  `passwords.complete({ token, password })` sets the password, consumes the link,
  marks the email confirmed and returns `{ email }`, so the page signs in at once.
  It raises `PASSWORD_TOO_SHORT` (under 8 characters), `PASSWORD_TOO_LONG` (over
  72 bytes) or `INVALID_PASSWORD_LINK` (used, expired or unknown).
- `session.signIn({ email, password })` (action) returns `{ token, refreshToken }`
  or raises `INVALID_CREDENTIALS`, alike for a wrong password, an unknown address
  and too many failed attempts.
- `src/lib/convex-auth.ts` keeps the access JWT (one hour) and the refresh token in
  `localStorage` under Convex Auth's keys, namespaced by deployment URL. It
  refreshes through `auth:signIn` under a cross-tab `navigator.locks` lock, adopts a
  token another tab stored meanwhile, and signs out locally when the backend
  rejects the refresh token. Sign-out calls `auth:signOut` and always forgets the
  local tokens.

## Staff statistics

`statistics.read({ productId: uuid | null })` needs an active staff session.
Non-staff and disabled staff get `STAFF_REQUIRED`, checked before an unknown
product raises `PRODUCT_NOT_FOUND`. The response is one object computed in one
query, so it is one consistent snapshot:

```text
{
  product_id: uuid | null,
  start_date: "YYYY-MM-DD", end_date: "YYYY-MM-DD",
  summary: { sale_count: string, total_nok: string, quantity: string | null },
  days: [{ date: "YYYY-MM-DD", sale_count: string, total_nok: string, quantity: string | null }],
  products: [{ product_id, code, name_nb, name_en, unit_code, sale_count, quantity, total_nok }],
  overview: {
    attention_count: string, open_count_count: string,
    attention: [{ product_id, code, name_nb, name_en, unit_code, quantity, minimum_stock }],
    open_counts: [{ id, title, started_at }]
  } | null
}
```

- All numbers are decimal strings. `days` is always 30 ascending rows: today (partial) in `Europe/Oslo` and the 29 days before, zero-filled.
- Sales are dated by the sale event's `recorded_at`, valued from frozen checkout lines with per-line rounding. Staff recoveries, free sales and inactive products count; unregistered checkouts and later stock corrections do not. `sale_count` counts checkouts. These are registrations, never verified payment or net revenue.
- Without a product: quantities are null (units cannot be mixed), `products` is the top ten by NOK value (code breaks ties), and `overview` lists up to eight active products needing attention (sold out first, negative before zero, then below `minimum_stock` by ascending `quantity / minimum_stock`) and up to five open count batches, oldest first. The two counts cover the full set, not just the listed rows.
- With a product: quantities are in its unit, `products` is empty and `overview` is null.
- A failed or invalid response is shown as unavailable, never as zero.

## Staff reads

- Staff reads return complete lists in one query, except
  `auditLog.page({ before? })`: 200 entries, newest first, older than
  the entry ID `before`, with `more` and the names the entries refer to. Page until
  `more` is false; an unavailable page is never shown as the end.
- Shelf layout and cabinet retirement: persist the exact command, generated UUIDs
  and codes, actor and request ID before sending, and retry with the same payload.
  The rules are in [datamodell.md](datamodell.md#shelf-layouts-and-storage).
- Label exports read `products.attributes({})` (every product's values) in one
  query. A failed read blocks the file; never print a partial label set. See
  [page-labels.md](page-labels.md).
- Backups are deployment snapshots, not client reads
  ([runbook-backup-restore.md](runbook-backup-restore.md)); contact retention runs
  in the backend ([runbook-contact-retention.md](runbook-contact-retention.md)).

## Tests

- `src/lib/api.test.ts`: the Worker JSON parser and error boundary.
- `src/lib/server/checkout-gateway.test.ts`: the checkout gateway with a stubbed client.
- `tests/convex/*.test.ts`, run by `./scripts/test-convex.sh` against a disposable
  local backend through the native client: exact decimal round trips, checkout,
  stock, orders, shelf and help guards, accounts, the Supabase import and catalog
  traversal of seeded data. `statistics.read` has no backend test yet.
- `./scripts/test-web.sh`: the browser boundary proof; see
  [concurrency-tests.md](concurrency-tests.md) §7.
