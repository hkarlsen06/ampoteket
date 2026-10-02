# Ampoteket website guide

The build contract for the SvelteKit site and its Worker endpoints: what you need
to wire the site correctly without reading the migrations. Project context is in
[prosjektoversikt.md](prosjektoversikt.md).

## 1. Architecture

```
Buyer browser ──► SvelteKit pages ──► Worker / server endpoints ──► Supabase Postgres (RPCs)
Staff browser ──► SvelteKit pages ──► Supabase PostgREST directly (staff JWT) ──► Postgres
Staff invitations ──► Worker (verified staff JWT) ──► Supabase Auth admin API
```

- One database function call is one transaction and one atomic stock operation.
- The Data API exposes only `public`; `app` stays out of the exposed-schema list.
  New tables are not exposed automatically; every grant is explicit.
- Load data on page open and after registered changes. No long-lived caching of
  stock or payment basis, no live sync, no offline purchase registration.

### 1.1 Environments and secrets

Never commit secrets; `.env.example` holds placeholders.

| Variable | Used by | Notes |
|---|---|---|
| `PUBLIC_SUPABASE_URL` | Browser + server | Local: `http://127.0.0.1:54321`. |
| `PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Browser | Public, not a password. |
| `SUPABASE_SECRET_KEY` | Worker/server only | Bypasses RLS. Never in the browser bundle, repo, logs or URLs. |
| `RESEND_API_KEY` | Worker/server only | Sends buyer receipts and the staff copy (§4.2); never in logs or the browser bundle. Missing: receipts are unavailable. |
| `CHECKOUT_ALLOWED_ORIGIN` | Checkout and invitation Workers + Auth callbacks | Exact HTTPS origin. Never derive trust from the request Host header. |
| `SALES_OPEN` | Worker/server only | Exactly `true` opens buying. Anything else, including unset, closes it: `/p`, `/cart` and `/checkout` (the `(sales)` route group) render a 503 "shop opens soon" page, `/api/checkouts/…` answers `503 CHECKOUT_UNAVAILABLE`, and the header, footer, scanner and homepage hide their buying entry points. Admin is unaffected. `bun run development` sets it to `true`. |

The Worker also needs the native `CHECKOUT_SESSION_LIMIT` and
`CHECKOUT_OPERATION_LIMIT` bindings from `wrangler.jsonc`: 20 initializations per
minute per IP, and 120 other checkout operations per minute per IP and browser
fingerprint. Missing bindings fail closed. Limits apply per Cloudflare location.
Bodies are capped at 32 KiB for prepare and 1 KiB otherwise, with a 10-second body
deadline and a 15-second upstream deadline. A timeout keeps the original attempt
for retry; it never proves the database rolled back.

Admin invitations also require the native `ADMIN_INVITATION_LIMIT` binding.
The invitation endpoint fails closed when its configuration or binding is absent;
its transport and retry rules are in [api-contract.md](api-contract.md#staff-membership-and-invitations).

Local setup, the disposable seed and the trusted HTTPS proxy that checkout needs
are in [README](../README.md).

## 2. Identity, roles and the access matrix

Staff sign in with individual email/password Supabase Auth accounts, with password
setup and recovery, but no public registration. Active admins manage access at
`/admin/admins` (§5.9).
Password setup binds the verified callback to its user ID. Changing accounts in
another tab invalidates that form; the password write uses the checked identity's
explicit bearer token, never a fresh lookup of the browser's shared session.
Signed-out admin visits redirect (replacing history) to the same locale's
`/admin/login?next=<path>`. Unavailable Auth and missing/revoked access are
distinct error states. The header Admin link shows only after membership is
confirmed; that visibility never replaces database authorization.

A Supabase login alone grants nothing. A maintainer provisions the first admin
using the [deployment runbook](runbook-deploy.md#5-first-staff-member-and-opening-stock).
After that, any active admin can invite others or deactivate another admin.
Deactivation keeps the membership and history; history also survives a deleted
Auth account. Admins cannot deactivate themselves.

| Caller | Credential | Allowed |
|---|---|---|
| Public visitor | anon / publishable key | `amp_catalog`, `amp_catalog_facets`, `amp_shelf_map` and published `amp_help_directory` reads only |
| Logged-in non-staff | own user JWT | Same as public; zero staff rows, zero stock operations |
| Staff | own staff JWT (never the service key plus a hand-supplied user id) | Staff read views, controlled master-data edits, all staff RPCs including audited membership management. No direct ledger or membership writes, or token digests. Optional contacts are staff-only and erasable |
| Website backend ("Worker") | secret key, server-side only | Public reads, three guest checkout RPCs (prepare / get / confirm), and Auth account creation/invitation after checking the caller's staff JWT. Membership RPCs use that JWT; no direct table privileges |
| Maintainer | direct DB access | Migrations, first-admin bootstrap, emergency access recovery, backups |

The database resolves `auth.uid()` to a staff identity. The browser never sends
`created_by`/`actor_id`. Deactivation takes effect on the next request.

## 3. Public catalog

Public reads are `amp_catalog`, `amp_catalog_facets` and `amp_shelf_map`; see the
[API contract](api-contract.md#catalog-and-topology) and [page-catalog.md](page-catalog.md).

- `quantity` is the recorded balance and may be negative (a visible discrepancy,
  not an error). `last_counted_at` null means never counted.
- Products stored off the drawer wall have null coordinates and an optional
  `location_note`; show the note (or ask-staff copy) instead.
- The catalog has no costs, contacts, token digests, staff identities, checkout
  history or internal notes. What is not in its columns does not exist for the frontend.
- Fetch errors render as "unavailable", never as "0 in stock".

## 4. Guest checkout

Payment is trust-based Vipps: the system only knows the buyer **claims to have
paid**. Never display payment as confirmed by Vipps. Reconciliation must never
post a second withdrawal, and a missing payment must never restock automatically.

### 4.1 Flow (browser → Worker → database)

1. The buyer fills a local cart, optionally with one contact string.
2. With credentials established per [checkout recovery](checkout-recovery.md), the
   Worker calls `amp_prepare_checkout`, reusing the same request ID and secret on
   every retry. The database freezes names, quantities and unit prices.
3. Show the **returned snapshot** with the Vipps recipient, amount and instructions.
   Discard the pre-prepare cart display.
4. If `payment_required`, the buyer pays in Vipps and presses "I have paid". If the
   total is `0.00` (free price or per-line rounding), skip Vipps and offer
   "Complete purchase"; never invent a minimum charge.
5. The Worker calls `amp_confirm_checkout`. Only on success show "Purchase
   registered" and clear the cart.
6. On network failure after payment, **never advise paying again**. Re-read with
   `amp_get_checkout` and retry confirm; duplicates return the same result without
   a second withdrawal.

No stock reservation and no expiry: old checkouts stay confirmable at their frozen
price, even after product deactivation. Never hold a transaction open while the
human pays. RPC shapes are in [datamodell.md](datamodell.md).

### 4.2 Cart, money and contact

- Cart line: `{"product_id":"<uuid>","quantity":"<decimal string>"}`. One line per
  product, 1–200 lines, quantity > 0 in the product's **sale step**. The browser
  keeps these (plus display fields) in `localStorage` key `ampoteket:cart`.
- One basket/checkout is active per browser; its attempt locks basket editing in
  every tab. Coordination rules are in [checkout recovery](checkout-recovery.md).
- Product details and scanner confirmation share `ProductPurchase`; keep purchase
  logic there so both change together.

The database computes money; the Worker never invents totals. Rounding is in
[datamodell.md](datamodell.md#4-units-quantities-and-rounding) and string transport in
[api-contract.md](api-contract.md#exact-json-values).

The contact is optional, unverified, 1–300 chars and not authentication. It is
stored separately so staff can erase it (`amp_clear_checkout_contact`). Never copy
it into notes or logs.

Receipts are requested after registration, not from the contact. The registered
checkout page offers an optional email field; the browser posts the saved binding
plus `email` to `/api/checkouts/[id]/receipt`. The Worker reads the checkout with
`amp_get_checkout`, requires `status=confirmed` (`CHECKOUT_NOT_REGISTERED`
otherwise) and sends a bilingual receipt through the Resend HTTP API
(`src/lib/server/receipt-email.ts`, styled like `supabase/templates/`). It lists
items (names link to the localized `/p/[code]` page) and total and says payment
is not checked. The address is used for that one
send and never stored or logged. `RECEIPT_LIMIT` allows 3 sends per checkout per
minute on top of the checkout limits; the Resend idempotency key (checkout ID plus
address hash) turns a repeated send to the same address within 24 hours into one
email. Errors: `INVALID_RECEIPT_EMAIL` (400), `CHECKOUT_RATE_LIMITED` (429),
`RECEIPT_UNAVAILABLE` (503: no key, no binding or Resend failed).

Every successful buyer confirm also sends the same receipt to the staff archive
`ampoteket.kvittering@outlook.com` (`STAFF_RECEIPT_COPY` in `receipt-email.ts`).
It runs in the background (`waitUntil`) after the response, so it never delays or
fails registration and a failed send is not retried; the idempotency key turns
duplicate confirms within 24 hours into one email. It needs the same key and
binding as buyer receipts. Staff recovery (`amp_recover_checkout`) goes from the
admin browser to the database and sends no copy.

### 4.3 Secrets, persistence and retries

[checkout-recovery.md](checkout-recovery.md) owns the credential, persistence and
retry protocol. The essentials:

- The database stores only a digest of the per-attempt secret. A checkout id alone
  authorizes nothing (`CHECKOUT_NOT_FOUND_OR_NOT_AUTHORISED`).
- Prepare retries reuse `p_request_id`. Same key with a changed payload fails
  (`IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT`). For confirm, id + secret are the
  idempotency key.
- Lost credentials or another device go through staff recovery of the original
  checkout, never an automatic replacement.

### 4.4 Payment recipient and QR

Vipps number **47322**. Its QR encodes exactly `https://qr.vipps.no/vp/swDrxGWcp`,
which opens the recipient with a freeform amount. Show it only at checkout, with
the saved database amount and instructions to enter it. Returning from the app is
not payment verification. The NOK 150 membership instructions in the source PDF do
not belong in the shop. Assets: [assets/payments/README.md](../assets/payments/README.md).

### 4.5 Help when registration cannot be completed

Show the checkout and request references, ask for a screenshot of amount and
items, keep the retry available, and direct the buyer to `/contact`
([details](checkout-recovery.md#staff-recovery-uses-the-original-checkout)). Never
put references or contacts in its query string. Admins maintain `/contact` contacts at
`/admin/help` through the audited `amp_help_contacts` view; the public reads only
published rows through `amp_help_directory`. Empty and unavailable are distinct
states, and the app never invents contacts.

## 5. Staff screens

Staff use their own JWT for PostgREST and RPCs, never the service key. Parse all
numeric responses with the [lossless JSON client](api-contract.md), including
metadata and nested audit values. Screen behavior is in
[page-admin-stock.md](page-admin-stock.md), [page-admin-orders.md](page-admin-orders.md)
and [page-labels.md](page-labels.md). RPC signatures and item shapes are in
[datamodell.md](datamodell.md).

Unsaved staff input is a per-user draft in `localStorage` (`src/lib/drafts.ts`):
the product editor and its specifications, a new order or unplanned receipt,
receipt amounts per order, the shelf editor and the stock form. A reload, Back,
closed sheet or sign-in round trip gives it back. A draft returns only onto the
state it was typed against (product revision, stored specification values, shelf
unit, stock revision and any review still owed); otherwise it is dropped. Discard
or an acknowledged write removes it, and a pending command owns the form until it
resolves. The product list (search, state, sort) and the label selection, which
nothing saves, keep only for the tab. Signing out still leaves the page, so no
other staff member sees it on a shared computer.

### 5.1 Master data and shelf layouts

Editable views: `amp_categories`, `amp_cabinets`, `amp_bins`, `amp_products`,
`amp_attribute_definitions`, `amp_product_attributes`, plus limited purchase
metadata (§5.5). Column grants decide what is writable; triggers audit and validate.

- **Products** update by ID + `metadata_revision` and require exactly one changed
  row. `metadata_revision` is unrelated to the stock revision (§6).
- `code`, `unit_code` and `stock_step` never change. `sale_step` is an integer
  multiple of `stock_step`; `pcs` requires whole steps.
- New codes are a family prefix plus five random hex digits (`RES-A3F09`), set by
  the [standard category](page-admin-stock.md#products). Recategorizing keeps the
  code. Retry a definite collision, but never retry an uncertain save with a new code.
- Standard categories and [specification fields](page-admin-stock.md#predefined-specifications)
  are created on demand with predefined stable IDs. Pending commands keep actor,
  IDs and exact payload for retry. Never default missing values to zero/false.
- Attributes are typed scalars in canonical units (ohm, never `1k`).
- Active products may have no bin, with an optional public location note. Shelf and
  count reads include those products. Deactivate instead of deleting anything with history.

Shelf layouts ([editor](page-admin-stock.md#placement)):

- `amp_save_shelf_layout` saves a cabinet and its drawers atomically, guarded by
  the original snapshot. Unknown outcomes retry with the same request and payload.
- Drawer IDs stay attached to their products. An assigned drawer (inactive products
  count) may grow into unassigned neighbors but never shrink, split or disappear.
- Move a bin into **empty** cells with an `amp_bins` update guarded by the shown
  position, requiring exactly one row. Swap two **occupied** positions with
  `amp_swap_bins` and one stable request id. Cabinets use `amp_cabinets` and
  `amp_swap_cabinets` the same way.
- Archive with `is_archived`: products out first, then bins, then the empty
  cabinet. Never delete historical storage.

### 5.2 Purchasing (placed orders, never stock)

`amp_record_order` records orders **already placed externally**. They reserve
nothing and add no stock. Unit cost is per product sale unit; freight goes in
`additional_cost_nok`, never into unit cost. "Receive everything" sends the
**remaining** quantities.

### 5.3 Receipts, cancellations, reversals

- One `amp_record_receipt` call covers one order or no order. Planned receipts need
  a matching line within the outstanding quantity. Unplanned (donation) receipts
  omit `order_line_id` and require a source note.
- `amp_cancel_order_quantities` reduces the outstanding commitment, never stock.
  `amp_reverse_cancellation` neutralises a mistaken cancellation once; a reversal
  cannot itself be reversed.
- `outstanding = max(ordered − received − cancelled, 0)` is derived, never stored.

### 5.4 Corrections and withdrawals (reason required, 1–2000 chars)

- `amp_adjust_stock` posts signed corrections as new movements linked to the one
  they correct (a receipt correction also fixes order progress). Unlinked
  adjustments cover surplus. `amp_withdraw_stock` takes positive quantities
  (staff use, giveaway, disposal) and posts them negative.
- A linked correction sends the `expected_revision` read with the history.
  `STALE_STOCK_CORRECTION` means review current history, never auto-replace the revision.
- If a count followed the movement, `CORRECTION_REQUIRES_RECOUNT`: pause the bin
  and call `amp_correct_movement_and_count` with the delta and a **new counted
  quantity**. Never precompute an offset against an old count.

### 5.5 Purchase metadata corrections (audited, limited)

Only these columns are editable: order `supplier_name`, `supplier_reference`,
`placed_at`, `additional_cost_nok`, `note`; line `unit_cost_nok`, `purchase_url`,
`supplier_sku`. Product links and ordered quantities are immutable; fix quantity
problems with receipts, cancellations or corrections.

### 5.6 Counts

- Count one bin at a time: pause taking and shelving there, settle pending
  registrations, then count and post. Recount if a delayed posting turns up; no
  lock can detect unregistered physical movement ([procedures](operating-procedures.md)).
- Send the revision captured when stock was read. `STALE_STOCK_COUNT` means a
  **fresh physical recount**, never a resubmit with a new revision.
- Each count posts immediately. Grouped counts use `amp_start_count_batch` /
  `amp_record_count` / `amp_finish_count_batch` (owner-only, posts nothing).
  `amp_record_single_count` makes its own finished batch. Prompt for a note when
  the difference is non-zero.
- `amp_close_abandoned_count_batch` is only for a disabled or deleted owner; another
  staff member closes it with a reason.

### 5.7 Checkout recovery and contact erasure

`amp_recover_checkout` registers the **original** saved checkout with a
non-sensitive reason; see [checkout recovery](checkout-recovery.md#staff-recovery-uses-the-original-checkout)
and [operating procedures](operating-procedures.md).

`amp_clear_checkout_contact` (staff only) removes a contact without rewriting
history; the audit records only that a clearance happened.

### 5.8 Audit browsing

`/admin/audit` reads `amp_audit_log` with the staff JWT, newest first, paging with
`id < last_id` until complete. A failed page keeps loaded rows and the cursor for
retry. Rows expand to key and before/after JSON with exact numeric strings. There
is no contact search. Movements, orders, counts and checkout recovery live on their
own screens.

### 5.9 Admin access

`/admin/admins` lists memberships with name, email and a visible status: active,
invitation pending, inactive or Auth account deleted. This is private staff data.
Any active admin can invite or reactivate a person by name and email, resend a
pending invitation, or deactivate another admin. There is one staff role.

Invitations use the authenticated Worker endpoint described in the
[API contract](api-contract.md#staff-membership-and-invitations). New admins follow
an email link to the localized `/admin/password` page and set their password.
An existing confirmed account keeps its password and can sign in immediately
after access is granted. Email delivery failure keeps the saved membership and
offers a delivery retry; it does not claim the invitation was sent.

Deactivation is confirmed within the existing row and preserves its audit history.
The database forbids self-deactivation and serializes membership changes, so two
admins cannot deactivate each other concurrently and leave nobody able to sign in.
Pending commands keep their original actor, request ID and exact payload for retry.
A retry after a later deactivation never silently restores access.

## 6. Numbers the frontend must respect

- **Steps:** `stock_step` is recording precision, `sale_step` the sellable
  increment (a multiple of it). Cable: `0.001` / `0.1`. Resistor: `1` / `1`.
- **Precision:** quantities and unit prices ≤ 6 decimals; totals and costs ≤ 2.
  Excess precision is **rejected**, not rounded. Unit prices may be sub-øre.
- **Formats:** product codes `^[A-Z0-9][A-Z0-9-]{0,39}$`; unit codes
  `^[a-z][a-z0-9_]{0,23}$`; attribute codes `^[a-z][a-z0-9_]{0,63}$`. Datasheet and
  purchase URLs must be `http(s)://`.
- **Revisions:** stock `revision` is an opaque token that any movement invalidates;
  `metadata_revision` is the master-data lock. Never mix them.
- **Derived values** (balances, outstanding, latest purchase, totals) come from the
  database; never compute local equivalents.
- **Time:** show timestamps in `Europe/Oslo` regardless of device or language. Entry
  resolves in that zone, rejects nonexistent DST times and asks about ambiguous ones
  (an explicit offset). Exports include the offset or UTC. Sorting and staleness
  checks use stable IDs and revisions, not timestamps alone.

## 7. QR codes and shelf map

- **Coordinates:** row 1 is at the bottom, columns run left to right, on both the
  wall and inside a cabinet. Buyers see column letter + row number (A1 is
  bottom-left). Spanning drawers anchor bottom-left: C3–D4 covers columns C–D,
  rows 3–4. The UI generates drawers from the layout; bin IDs carry products and
  history when moved.
- **Model:** one product ↔ one bin; one bin ↔ many products and one cabinet
  position; one cabinet ↔ one wall position. Moving a bin moves its products.
- **QR payload** is a stable address like `ampoteket.no/p/AMP-00123`. Never encode
  prices or placement or point labels at Supabase. Codes are never reused. One code
  serves buyers and staff. **Scanning never registers a purchase by itself.**
  Scanners and parsing rules: [scanner.md](scanner.md).
- **Shelf map:** read topology from `amp_shelf_map()`, never by guessing from
  product rows. Derive placement from stored coordinates (highest row on top,
  column A left) with no parallel coordinate state. `has_products` counts inactive
  assignments and ignores stock. Presentation: [page-product.md](page-product.md),
  [page-home.md](page-home.md).
- **Freshness:** the map revalidates on focus, visibility and reconnect; no refresh
  button, polling or realtime. Background reads keep map, selections, input and
  focus. Failures show unavailable with a retry. The server-side topology read has
  a three-second deadline and falls back to the browser; it never fails the page.

### 7.1 Printable product labels

Staff print A4 label sheets and attach cut-out labels to drawers. Each label shows
**part number → QR → short specifications** (from attributes), top to bottom. Every
product in the selected drawers gets one, inactive included; copy count is explicit.

Label size awaits drawer measurements, so keep dimensions configurable. Keep QR
quiet zones, black on white, cut guides outside the code. Never split labels across
sheets or silently truncate or over-shrink specs. See [page-labels.md](page-labels.md).

## 8. Security obligations (Worker + frontend)

- The production apex and www hosts redirect HTTP to the HTTPS apex before
  rendering pages. HTTPS pages set `Strict-Transport-Security: max-age=31536000`;
  this does not include other subdomains or preload the domain. Local development
  keeps its configured HTTP/HTTPS origin.
- Pages forbid embedding with `Content-Security-Policy: frame-ancestors 'none'`,
  configured through SvelteKit, so another site cannot disguise staff controls.
- Guest RPCs are `service_role`-only; browsers reach them **only** through the Worker,
  which validates every guest input and enforces size limits, rate limits and
  origin/CSRF checks. Prices and totals come from the database.
- Admin invitations also check the exact allowed origin, input/body limits and a
  rate limit. Verify active staff with the caller's JWT before privileged Auth
  calls; use that same JWT for membership changes and audit attribution.
- No keys, passwords or checkout secrets in the repo, URLs or logs.
- Error mapping: stale → conflict needing user action; retry-same → silent success;
  validation → field error; auth/privilege → access error with re-login. Timeouts
  mean "retry the same request", never "pay again".
- Buyer privacy: no accounts, names or stored emails. The contact string is optional
  and erasable; a receipt address is used once and never stored. Staff actions are
  attributed through their own JWT.

### 8.1 Error catalog (database → UI mapping)

Every deliberate database rejection raises one of the names below (the message may
add a detail after `:`). Map each category as §8 describes. An error not in this
table is a bug: report it, do not cover it with friendly copy.
`scripts/test-database.sh` checks that this catalog covers every name the
migration can raise.

| Category → UI treatment | Error names |
|---|---|
| **Retry-safe conflict**: same request already done or racing; re-read state, show the saved result, never repost | `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT` (same key, different payload, a client bug, never auto-retried), `STAFF_ALREADY_ACTIVE` (maintainer helper: the account already has access) |
| **Stale form / conflict**: someone else changed state; refresh, show current data, ask the user to confirm again | `INVITATION_SUPERSEDED`, `STALE_SHELF_LAYOUT`, `LAYOUT_HAS_PRODUCTS`, `STALE_HELP_CONTACT`, `STALE_HELP_ORDER`, `STALE_STOCK_COUNT`, `PRODUCT_BIN_UNAVAILABLE`, `BIN_STILL_HAS_PRODUCTS`, `CABINET_STILL_HAS_BINS`, `BIN_ARCHIVED`, `CABINET_ARCHIVED`, `CORRECTION_REQUIRES_RECOUNT`, `STALE_STOCK_CORRECTION`, `STALE_BIN_POSITION`, `STALE_CABINET_POSITION`, `BIN_POSITION_OCCUPIED`, `BIN_DOES_NOT_FIT_CABINET_GRID`, `CABINET_SHRINK_WOULD_ORPHAN_BINS`, `RECEIPT_EXCEEDS_OUTSTANDING_QUANTITY`, `RECEIPT_ORDER_LINE_MISMATCH`, `INVALID_CANCELLATION_QUANTITY`, `RECEIPT_CORRECTION_OUT_OF_RANGE`, `COUNT_BATCH_FINISHED`, `CANCELLATION_ALREADY_REVERSED`, `CANNOT_REVERSE_A_REVERSAL`, `COUNT_BATCH_OWNER_STILL_ACTIVE` |
| **Validation**: reject the field/form with a specific message | `INVALID_SHELF_LAYOUT`, `INVALID_HELP_PAGE_SIZE`, `INVALID_HELP_CURSOR`, `INVALID_CATALOG_PAGE_SIZE`, `INVALID_CATALOG_QUERY`, `UNKNOWN_CATALOG_CATEGORY`, `UNKNOWN_CATALOG_ATTRIBUTE`, `INVALID_CATALOG_FILTER`, `CATALOG_CURSOR_MISSING`, `STAFF_EMAIL_REQUIRED`, `STAFF_DISPLAY_NAME_REQUIRED`, `CORRECTION_REVISION_REQUIRED`, `DUPLICATE_CORRECTION_REFERENCE`, `ITEMS_MUST_BE_ARRAY`, `INVALID_ITEM_COUNT`, `INVALID_ITEM`, `PRODUCT_ID_REQUIRED`, `QUANTITY_REQUIRED`, `INVALID_QUANTITY_STEP`, `POSITIVE_CART_QUANTITY_REQUIRED`, `POSITIVE_RECEIPT_QUANTITY_REQUIRED`, `DUPLICATE_OR_MISSING_CART_PRODUCT`, `DUPLICATE_OR_MISSING_ORDER_LINE`, `RECEIPT_ORDER_LINE_REQUIRED`, `UNPLANNED_RECEIPT_REQUIRES_SOURCE_NOTE`, `UNPLANNED_RECEIPT_CANNOT_HAVE_ORDER_LINE`, `RECOVERY_REASON_REQUIRED`, `REASON_REQUIRED`, `CLOSURE_REASON_REQUIRED`, `PLACED_AT_REQUIRED`, `ORDER_PLACED_IN_FUTURE`, `NEGATIVE_PHYSICAL_COUNT`, `INVALID_WITHDRAWAL`, `INVALID_CHECKOUT_TOKEN`, `DISCRETE_UNIT_REQUIRES_WHOLE_QUANTITIES`, `ATTRIBUTE_VALUE_TYPE_MISMATCH`, `TWO_DISTINCT_BINS_AND_POSITIONS_REQUIRED`, `TWO_DISTINCT_CABINETS_AND_POSITIONS_REQUIRED`, `REQUEST_ID_REQUIRED` |
| **Not found**: the referenced object does not exist (bad id, deleted link, wrong order); refresh and re-select | `PRODUCT_NOT_FOUND`, `STAFF_USER_NOT_FOUND`, `STAFF_NOT_FOUND`, `STAFF_NOT_ACTIVE`, `PRODUCT_NOT_FOR_SALE`, `ORDER_NOT_FOUND`, `ORDER_LINE_NOT_FOUND`, `BIN_NOT_FOUND`, `CABINET_NOT_FOUND`, `CANCELLATION_NOT_FOUND`, `COUNT_BATCH_NOT_FOUND`, `CORRECTED_MOVEMENT_NOT_FOUND` |
| **Access**: sign-in/permission problem; access error, offer re-login where applicable | `STAFF_REQUIRED`, `STAFF_SELF_DEACTIVATION` (another admin must deactivate this account), `CHECKOUT_NOT_FOUND_OR_NOT_AUTHORISED` (an id without its secret is treated as not found), `COUNT_BATCH_BELONGS_TO_ANOTHER_STAFF_MEMBER` |
| **Guarded invariant**: the operation tried to change something immutable; this is a client bug, never a user-facing retry | `STORAGE_IDENTITY_IS_IMMUTABLE`, `IMMUTABLE_RECORD`, `PRODUCT_IDENTITY_AND_STOCK_UNIT_ARE_IMMUTABLE`, `ORDER_LINE_IDENTITY_AND_ORDERED_QUANTITY_ARE_IMMUTABLE`, `ATTRIBUTE_MEANING_IS_IMMUTABLE`, `INVALID_CORRECTION_REFERENCE`, `INVALID_RECEIPT_ALLOCATION`, `INVALID_MOVEMENT_SIGN`, `INVALID_MANUAL_KIND`, `INVALID_COMMAND_COMPLETION` |
| **Configuration**: deployment misconfiguration, page an operator | `READ_COMMITTED_REQUIRED`, `UNREVIEWED_PUBLIC_FUNCTION` (migration-time only) |

Raw PostgreSQL errors (check-constraint or not-null violations, e.g.
`placed_at_not_in_future`) can surface for inputs the Worker should have validated
first; treat them as validation bugs in the calling code.

## 9. Acceptance criteria (must all hold in production)

These need real HTTP with real staff and non-staff JWTs; SQL alone cannot prove them.

| Situation | Expected |
|---|---|
| Same purchase confirmed twice / after network break | One sale, one withdrawal set, identical response |
| Price changes after payment basis saved | Ongoing purchase keeps shown amount |
| Partial operation failure | Nothing posted (header + lines + movements roll back together) |
| Stock moves during a count / batch closes mid-count | `STALE_STOCK_COUNT` / `COUNT_BATCH_FINISHED`; no silent overwrite |
| Anon, non-staff, wrong checkout secret, deactivated staff | Rejected, including outside the UI ([checks](concurrency-tests.md#7-real-http-and-supabase-auth-boundary)) |
| Stock reconciled against history | Balances equal movement sums |
| QR scanned on a physical phone with app-switching | Correct object opens; full buy flow survives |
| Admin invited or reactivated | Caller is audited; new account can set its password through the localized email link; confirmed account keeps its password |
| Invitation email fails or a response is lost | Membership remains, retry uses the same command, and later deactivation is never undone by a replay |
| Self-deactivation / concurrent mutual deactivation | Rejected / one admin remains active |
| Box swap retried / from stale form | Executes once / rejected without double-move |
| Abandoned batch closed | Owner preserved, closer + reason audited, stock untouched |

## 10. Rollout

Validate locally, verify §9 over real HTTP, and rehearse phone → Vipps →
registration on synthetic stock before deploying. Import real stock through
counts/adjustments, never a hidden counter ([runbook-deploy.md](runbook-deploy.md),
[runbook-backup-restore.md](runbook-backup-restore.md)). Open launch gates:
[VALIDATION.md](../VALIDATION.md).
