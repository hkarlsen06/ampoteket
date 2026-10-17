# Ampoteket website guide

The build contract for the SvelteKit site, its Worker endpoints and how they use
the Convex backend: what you need to wire the site correctly without reading every
function. Project context is in [prosjektoversikt.md](prosjektoversikt.md); data
rules are in [datamodell.md](datamodell.md), and `convex/schema.ts` with the
functions in `convex/` wins over any doc that disagrees.

## 1. Architecture

```
Buyer browser ──► SvelteKit pages ──► SSR loads (ConvexHttpClient) ──► Convex public queries
Buyer browser ──► Worker /api/checkouts/* (checkout gateway) ──► checkout.prepare / get / confirm (CHECKOUT_SERVER_KEY)
Staff browser ──► ConvexClient (WebSocket, Convex Auth session) ──► Convex staff queries, mutations and actions
Invitations and password resets ──► Convex actions ──► Resend
```

- One Convex mutation is one serializable transaction and one atomic stock
  operation. Convex retries a transaction that conflicts with another, so there are
  no locks to order ([datamodell.md](datamodell.md) §8,
  [concurrency-tests.md](concurrency-tests.md)).
- Clients reach Convex only through the native clients and the generated, typed
  `api` (`src/lib/convex.ts`); transport rules are in
  [api-contract.md](api-contract.md). Public data comes from the five `catalog.*`
  queries; sign-in, the password-link functions and `members.me` also need no staff
  session (§2). Every other function requires a signed-in active staff member, the
  Worker's `CHECKOUT_SERVER_KEY`, or the deployment admin key (internal functions).
- Convex queries are reactive. The staff product list, product editor, counts,
  count detail, audit log, drawer neighbours and the product page `/p/[code]`
  subscribe with `useQuery` and update as data changes. Other screens read on open,
  after a registered change, and on focus, visibility and reconnect. There is no
  offline purchase registration, and the checkout snapshot is read through the
  Worker on demand, never subscribed or cached.

### 1.1 Environments and secrets

Never commit secrets; `.env.example` holds placeholders. The Worker reads its
values through `src/env.ts`; production values come from `wrangler.jsonc` vars and
Worker secrets.

| Worker variable | Used by | Notes |
|---|---|---|
| `PUBLIC_CONVEX_URL` | Browser + server | The Convex deployment URL, `https://<name>.<region>.convex.cloud` (`<region>.` is absent in the default region). Production: `https://useful-bass-249.eu-west-1.convex.cloud`. |
| `CHECKOUT_SERVER_KEY` | Worker secret | Same value as the Convex variable below, at least 32 characters. Proves that checkout calls come from this Worker. Missing or short: `/api/checkouts/…` answers `503 CHECKOUT_UNAVAILABLE`. Never in the browser bundle, repo, logs or URLs. |
| `RESEND_API_KEY` | Worker secret | Sends buyer receipts and the staff copy (§4.2); never in logs or the browser bundle. Missing: receipts are unavailable. |
| `CHECKOUT_ALLOWED_ORIGIN` | Checkout Worker | Exact HTTPS origin for checkout POSTs. Never derive trust from the request Host header. |
| `SALES_OPEN` | Worker/server only | Exactly `true` opens buying. Anything else, including unset, closes it: `/p`, `/cart` and `/checkout` (the `(sales)` route group) render a 503 "closed for maintenance" page, `/api/checkouts/…` answers `503 CHECKOUT_UNAVAILABLE`, and the header, footer, scanner and homepage hide their buying entry points. Admin is unaffected. `bun run development` sets it to `true`. |
| `CONVEX_DEV_PROXY` | Development only | Set by `bun run development` to the local backend. The server calls it directly; the browser reaches it at `/_convex` on the page's own origin, so `dev.ampoteket.no` and phones work. |

| Convex environment variable | Used by | Notes |
|---|---|---|
| `CHECKOUT_SERVER_KEY` | `convex/checkout.ts` | Compared in constant time with the key the Worker sends; otherwise `CHECKOUT_SERVER_REQUIRED`. |
| `SITE_URL` | `convex/lib/email.ts` | Public origin for invitation and reset links, `https://ampoteket.no` in production. |
| `RESEND_API_KEY` | `convex/lib/email.ts` | Sends invitations and password resets. Missing: invitations fail with `INVITATION_EMAIL_FAILED` and resets send nothing. |
| `JWT_PRIVATE_KEY`, `JWKS` | Convex Auth | Signing keys for staff sessions. `CONVEX_SITE_URL` is built in and names the token issuer (`convex/auth.config.ts`). |
| `ALLOW_TEST_FIXTURES` | Test functions | `true` only on disposable backends. Production never sets it. |

The Worker also needs the native `CHECKOUT_SESSION_LIMIT` and
`CHECKOUT_OPERATION_LIMIT` bindings from `wrangler.jsonc`: 20 initializations per
minute per IP, and 120 other checkout operations per minute per IP and browser
fingerprint. Missing bindings fail closed. Limits apply per Cloudflare location.
Bodies are capped at 32 KiB for prepare and 1 KiB otherwise, with a 10-second body
deadline and a 15-second deadline for each backend call. A timeout keeps the
original attempt for retry; it never proves the backend rolled back.

Invitations and password resets run in Convex actions with their own rate limits;
transport and retry rules are in [api-contract.md](api-contract.md#staff-membership-and-invitations).

Local setup, the disposable backend and the trusted HTTPS proxy that checkout needs
are in [README](../README.md).

## 2. Identity, roles and the access matrix

Staff sign in with individual email/password Convex Auth accounts
(`convex/auth.ts`). Sign-up is refused; accounts exist only through an invitation
from active staff. Active admins manage access at `/admin/admins` (§5.9).
Setting a password uses a single-use emailed link: `passwords.checkLink` checks it
before the form, and `passwords.complete` sets the password with the link token,
not with a session. It returns the account email, and the page signs in with the
new password.
Signed-out admin visits redirect (replacing history) to the same locale's
`/admin/login?next=<path>`. Unavailable Auth and missing/revoked access are
distinct error states: `session.signIn` answers `INVALID_CREDENTIALS` alike for a
wrong password, an unknown address and too many failed attempts, and any other
failure reads as unavailable, so sign-in never reveals whether an account exists.
`AdminContext` (`src/lib/admin-context.svelte.ts`) subscribes to `members.me`, so
sign-in, sign-out and revocation show in every open tab. The public header's Admin
link shows only after membership is confirmed; that visibility never replaces
backend authorization. Admin routes themselves use a reduced header and no public
footer ([design-system.md](design-system.md), Header and menu).

A Convex Auth account alone grants nothing. Production memberships arrive with the
[cutover](runbook-cutover.md) import; after that any active admin can invite
others or deactivate another admin ([staff provisioning](datamodell.md#staff-provisioning)).
Deactivation keeps the membership and history; history also survives a deleted
Auth account. Admins cannot deactivate themselves.

| Caller | Credential | Allowed |
|---|---|---|
| Public visitor | none | `catalog.page`, `catalog.product`, `catalog.facets`, `catalog.shelfMap` and `catalog.helpDirectory` (published contacts only); `session.signIn`, `passwords.requestReset`, and `passwords.checkLink`/`passwords.complete` with a link token |
| Signed-in non-staff | own Convex Auth session | Same as public. `members.me` returns `membership: null`; every staff function rejects with `STAFF_REQUIRED` |
| Staff | own Convex Auth session | Every staff function (`requireStaff` in `convex/lib/staff.ts`): staff reads, audited master-data edits, stock, order and count commands, checkout recovery and contact erasure, and audited membership management. Ledger rows and audit images are written only by the backend's own helpers. Optional contacts are staff-only and erasable |
| Website backend ("Worker") | `CHECKOUT_SERVER_KEY`, server-side only | Public reads and the three guest checkout functions `checkout.prepare`, `checkout.get` and `checkout.confirm`; no staff identity |
| Maintainer | deployment admin key or deploy key | Deploys, environment variables, internal functions (`migration.*`, `seed.*`, `retention.*`, `members.grantAccess`, `passwords.storeToken`, `passwords.resetTarget`) through `bunx convex run`, backups ([runbook](runbook-backup-restore.md)). Dashboard data edits bypass the audit; change data through functions |

The backend resolves the signed-in Convex Auth user to an active `staff_members`
row on every call; the actor always comes from that identity, never from an
argument. Deactivation takes effect on the next call, and open subscriptions
update at once.

## 3. Public catalog

Public reads are `catalog.page`, `catalog.product`, `catalog.facets` and
`catalog.shelfMap`; see the [API contract](api-contract.md#catalog-and-topology)
and [page-catalog.md](page-catalog.md).

- `quantity` is the recorded balance and may be negative (a visible discrepancy,
  not an error). `last_counted_at` null means never counted.
- Products stored off the drawer wall have null coordinates and an optional
  `location_note`; show the note (or ask-staff copy) instead.
- The catalog has no costs, contacts, token digests, staff identities, checkout
  history or internal notes. What is not in its fields does not exist for the frontend.
- Fetch errors render as "unavailable", never as "0 in stock".

## 4. Guest checkout

Payment is trust-based Vipps: the system only knows the buyer **claims to have
paid**. Never display payment as confirmed by Vipps. Reconciliation must never
post a second withdrawal, and a missing payment must never restock automatically.

### 4.1 Flow (browser → Worker → Convex)

1. The buyer fills a local cart, optionally with one contact string.
2. With credentials established per [checkout recovery](checkout-recovery.md), the
   Worker calls `checkout.prepare`, reusing the same request ID and secret on
   every retry. The backend freezes names, quantities and unit prices.
3. Show the **returned snapshot** with the Vipps recipient, amount and instructions.
   Discard the pre-prepare cart display.
4. If `payment_required`, the buyer pays in Vipps and presses "I have paid". If the
   total is `0.00` (free price or per-line rounding), skip Vipps and offer
   "Complete purchase"; never invent a minimum charge.
5. The Worker calls `checkout.confirm`. Only on success show "Purchase
   registered" and clear the cart.
6. On network failure after payment, **never advise paying again**. Re-read with
   `checkout.get` and retry confirm; duplicates return the same result without
   a second withdrawal.

No stock reservation and no expiry: old checkouts stay confirmable at their frozen
price, even after product deactivation. Never hold a transaction open while the
human pays. Function arguments and results are in `convex/checkout.ts` and
[datamodell.md](datamodell.md) §7.

### 4.2 Cart, money and contact

- Cart line: `{"product_id":"<uuid>","quantity":"<decimal string>"}`. One line per
  product, 1–200 lines, quantity > 0 in the product's **sale step**. The browser
  keeps these (plus display fields) in `localStorage` key `ampoteket:cart`.
- One basket/checkout is active per browser; its attempt locks basket editing in
  every tab. Coordination rules are in [checkout recovery](checkout-recovery.md).
- Product details and scanner confirmation share `ProductPurchase`; keep purchase
  logic there so both change together.

The backend computes money; the Worker never invents totals. Rounding is in
[datamodell.md](datamodell.md#4-units-quantities-and-rounding) and string transport in
[api-contract.md](api-contract.md#exact-json-values).

The contact is optional, unverified, 1–300 chars and not authentication. It is
stored separately so staff can erase it (`checkout.clearContact`). Never copy
it into notes or logs.

Receipts are requested after registration, not from the contact. The registered
checkout page offers an optional email field; the browser posts the saved binding
plus `email` to `/api/checkouts/[id]/receipt`. The Worker reads the checkout with
`checkout.get`, requires `status=confirmed` (`CHECKOUT_NOT_REGISTERED`
otherwise) and sends a bilingual receipt through the Resend HTTP API
(`src/lib/server/receipt-email.ts`). It lists items (names link to the localized
`/p/[code]` page) and total and says payment is not checked. The address is used
for that one send and never stored or logged. `RECEIPT_LIMIT` allows 3 sends per
checkout per minute on top of the checkout limits; the Resend idempotency key
(checkout ID plus address hash) turns a repeated send to the same address within
24 hours into one email. Errors: `INVALID_RECEIPT_EMAIL` (400),
`CHECKOUT_RATE_LIMITED` (429), `RECEIPT_UNAVAILABLE` (503: no key, no binding or
Resend failed).

Every successful buyer confirm also sends the same receipt to the staff archive
`ampoteket.kvittering@outlook.com` (`STAFF_RECEIPT_COPY` in `receipt-email.ts`).
It runs in the background (`waitUntil`) after the response, so it never delays or
fails registration and a failed send is not retried; the idempotency key turns
duplicate confirms within 24 hours into one email. It needs the same key and
binding as buyer receipts. Staff recovery (`checkout.recover`) goes from the
admin browser to Convex and sends no copy.

### 4.3 Secrets, persistence and retries

[checkout-recovery.md](checkout-recovery.md) owns the credential, persistence and
retry protocol. The essentials:

- The backend stores only the SHA-256 digest of the per-attempt secret. A checkout
  ID alone authorizes nothing (`CHECKOUT_NOT_FOUND_OR_NOT_AUTHORISED`).
- Prepare retries reuse the request ID. Same key with a changed payload fails
  (`IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT`). For confirm, ID + secret are the
  idempotency key.
- Lost credentials or another device go through staff recovery of the original
  checkout, never an automatic replacement.

### 4.4 Payment recipient and QR

Vipps number **47322**. Its QR encodes exactly `https://qr.vipps.no/vp/swDrxGWcp`,
which opens the recipient with a freeform amount. Show it only at checkout, with
the saved amount and instructions to enter it. Returning from the app is
not payment verification. The NOK 150 membership instructions in the source PDF do
not belong in the shop. Assets: [assets/payments/README.md](../assets/payments/README.md).

### 4.5 Help when registration cannot be completed

Show the checkout and request references, ask for a screenshot of amount and
items, keep the retry available, and direct the buyer to `/contact`
([details](checkout-recovery.md#staff-recovery-uses-the-original-checkout)). Never
put references or contacts in its query string. Admins maintain `/contact` contacts at
`/admin/contacts` through the audited `help.list`, `help.save` and `help.reorder`;
the public reads only published entries through `catalog.helpDirectory`. Empty and
unavailable are distinct states, and the app never invents contacts.

## 5. Staff screens

Staff call Convex with their own session through the browser `ConvexClient`
(`admin.credentials()` returns it with the signed-in user's Auth UUID), never with
the Worker key. Keep quantities, money and revisions as decimal strings and
validate every result's shape ([API contract](api-contract.md)). Screen behavior
is in [page-admin-stock.md](page-admin-stock.md),
[page-admin-orders.md](page-admin-orders.md) and [page-labels.md](page-labels.md).
Function arguments are in `convex/*.ts`; the rules behind them are in
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

Products and their specifications are written by `products.save` (the product and
its specification changes in one transaction), `products.setAttribute`,
`products.rename` (a category name or specification label) and
`products.createDefinition`; storage by the `shelf.*` mutations; limited purchase
metadata by §5.5. Each function validates its input and records the audit image
(`convex/lib/audit.ts`).

- **Products** save by ID + `metadata_revision`, and each specification change
  names the value the editor showed. A mismatch raises `STALE_PRODUCT` and changes
  nothing; a retry of a save that already applied returns the product.
  `metadata_revision` is unrelated to the stock revision (§6).
- `code`, `unit_code` and `stock_step` never change
  (`PRODUCT_IDENTITY_AND_STOCK_UNIT_ARE_IMMUTABLE`). `sale_step` is an integer
  multiple of `stock_step`; `pcs` requires whole steps.
- New codes are a family prefix plus five random hex digits (`RES-A3F09`), set by
  the [standard category](page-admin-stock.md#products). Recategorizing keeps the
  code. Retry a definite collision (`PRODUCT_CODE_TAKEN`) with a new code, but never
  retry an uncertain save with a new code.
- Standard categories and [specification fields](page-admin-stock.md#predefined-specifications)
  are created on demand with predefined stable IDs. Pending commands keep actor,
  IDs and exact payload for retry. Never default missing values to zero/false.
- Attributes are typed scalars in canonical units (ohm, never `1k`).
- Active products may have no bin, with an optional public location note. Shelf and
  count reads include those products. Deactivate instead of deleting anything with history.

Shelf layouts ([editor](page-admin-stock.md#cabinets-and-drawers)):

- `shelf.saveLayout` saves a cabinet and its drawers atomically, guarded by
  the original snapshot (`before`, `beforeBins`). Unknown outcomes retry with the
  same request ID and payload.
- Drawer IDs stay attached to their products. An assigned drawer (inactive products
  count) may grow into unassigned neighbors but never shrink, split or disappear.
- Move a bin into **empty** cells with `shelf.updateBin`, guarded by the row as
  shown: `'stale'` means it changed meanwhile, `'saved'` also answers a retry that
  already applied. Swap two **occupied** positions with `shelf.swapBins` and one
  stable request ID. Cabinets use `shelf.updateCabinet` and `shelf.swapCabinets`
  the same way.
- Archive with `is_archived`: products out first, then bins, then the empty
  cabinet; `shelf.archiveCabinet` retires an empty cabinet with all its empty
  drawers at once. Never delete historical storage.

### 5.2 Purchasing (placed orders, never stock)

`orders.recordOrder` records orders **already placed externally**. They reserve
nothing and add no stock. Unit cost is per product sale unit; freight goes in
`additionalCostNok`, never into unit cost. "Receive everything" sends the
**remaining** quantities.

### 5.3 Receipts, cancellations, reversals

- One `orders.recordReceipt` call covers one order or no order. Planned receipts
  need a matching line within the outstanding quantity. Unplanned (donation)
  receipts send `orderId: null` and `orderLineId: null` and require a source note.
- `orders.cancelQuantities` reduces the outstanding commitment, never stock.
  `orders.reverseCancellation` neutralises a mistaken cancellation once; a reversal
  cannot itself be reversed.
- `outstanding = max(ordered − received − cancelled, 0)` is derived, never stored.

### 5.4 Corrections and withdrawals (reason required, 1–2000 chars)

- `stock.adjust` posts signed corrections as new movements linked to the one
  they correct (a receipt correction also fixes order progress). Unlinked
  adjustments cover surplus. `stock.withdraw` takes positive quantities
  (staff use, giveaway, disposal) and posts them negative.
- A linked correction sends the `expectedRevision` read with the history.
  `STALE_STOCK_CORRECTION` means review current history, never auto-replace the revision.
- If a count followed the movement, `CORRECTION_REQUIRES_RECOUNT`: pause the bin
  and call `stock.correctAndCount` with the delta and a **new counted
  quantity**. Never precompute an offset against an old count.

### 5.5 Purchase metadata corrections (audited, limited)

Only these fields are editable, through `orders.updateOrder` and
`orders.updateOrderLine` with the row as shown (`expected`) and the new values
(`next`): order `supplierName`, `supplierReference`, `placedAt`,
`additionalCostNok`, `note`; line `unitCostNok`, `purchaseUrl`, `supplierSku`.
`'stale'` means someone else changed the row. Product links and ordered quantities
are immutable; fix quantity problems with receipts, cancellations or corrections.

### 5.6 Counts

- Count one bin at a time: pause taking and shelving there, settle pending
  registrations, then count and post. Recount if a delayed posting turns up; no
  transaction can detect unregistered physical movement ([procedures](operating-procedures.md)).
- Send the revision captured when stock was read. `STALE_STOCK_COUNT` means a
  **fresh physical recount**, never a resubmit with a new revision.
- Each count posts immediately. Grouped counts use `stock.startCountBatch` /
  `stock.recordCount` / `stock.finishCountBatch` (owner-only, posts nothing).
  `stock.recordSingleCount` makes its own finished batch with `product_id` set and the
  product code as title; the pages render «Telling av …» / “Count of …” from `product_id`. Prompt for a note when
  the difference is non-zero.
- `stock.closeAbandonedCountBatch` is only for an owner who is deactivated or has
  no Auth account; another staff member closes it with a reason.

### 5.7 Checkout recovery and contact erasure

`/admin/purchases` ("Find purchase") looks a purchase up by the buyer's support reference,
the checkout ID or the backup reference (`checkout.staffLookup`), and shows only what
staff match against the buyer's account: time, items, total and whether it is registered.
It also holds the buyer's contact detail (`checkout.staffContact`), which staff can show
and erase behind a destructive confirmation.

`checkout.recover` registers the **original** saved checkout with a
non-sensitive reason; see [checkout recovery](checkout-recovery.md#staff-recovery-uses-the-original-checkout)
and [operating procedures](operating-procedures.md).

`checkout.clearContact` (staff only) removes a contact without rewriting
history; the audit records only that a clearance happened (`CONTACT_CLEARED`).

### 5.8 Audit browsing

`/admin/audit` subscribes to the newest page of `auditLog.page`, so new entries
appear as they are recorded, and loads older pages with `before` (the last entry
ID), 200 entries per page, newest first, until `more` is false. Each load continues
until one more Oslo calendar day is whole, and the oldest loaded day stays hidden
until it is, so a day never shows a partial count. A failed page keeps loaded
entries and the cursor for retry. Each page carries the names its entries refer to
(`references`). `describeAudit()` in `src/lib/admin-audit.ts` turns each entry into
a named subject (product code and name, supplier, count, contact, drawer), the
actor's name (entries without a staff actor read as «System», or «Selvbetjent kjøp»
for imported self-service history) and the changed fields with translated labels
and formatted before and after values.

`groupAudit()` then folds rows so a day of catalogue entry reads as a few lines:

- **Event**: one person's rows on one thing with no more than 30 minutes between
  them. A product's specifications and product-linked counts join the product, and
  order lines join their order. A product created with its specification, opening count
  and drawer is one «Opprettet» event; each field shows its net change.
- **Batch**: a day's events by one person with the same kind and action, such as
  «Opprettet 26 produkter» with the time span, the actor and the first names. «Vis alle»
  lists the events; each has its own «Vis endringer» disclosure.
- **Day**: batches sit under a heading per Oslo calendar day, newest first.

Staff never see row ids, record keys, role names or JSON. There is no contact search.
Movements, orders, counts and checkout recovery live on their own screens.

### 5.9 Admin access

`/admin/admins` lists memberships (`members.list`) with name, email and a visible
status: active, invitation pending, inactive or Auth account deleted. This is
private staff data. Any active admin can invite or reactivate a person by name and
email, resend a pending invitation, or deactivate another admin. There is one staff role.

Invitations use the `members.invite` action described in the
[API contract](api-contract.md#staff-membership-and-invitations). New admins follow
an email link to the localized `/admin/password` page and set their password.
An existing confirmed account keeps its password and can sign in immediately
after access is granted. Email delivery failure keeps the saved membership and
offers a delivery retry; it does not claim the invitation was sent.

Deactivation (`members.deactivate`) is confirmed in an alert dialog and preserves
its audit history. It refuses self-deactivation, and every access change rereads
the caller's own membership in its transaction, so two admins cannot deactivate
each other concurrently and leave nobody able to sign in. Pending commands keep
their original actor, request ID and exact payload for retry. A retry after a
later deactivation never silently restores access.

### 5.10 News and events

`/admin/news` lists articles and events, an article and its event as one entry.
One editor holds an article section and an event section; images, links and tagged
people are shared by both. Creating both at once, linking an existing unlinked
row, unlinking and publishing are one `news.save` command, persisted with its
request ID before it is sent and retried unchanged
([page-news.md](page-news.md#4-admin)). Images are re-encoded in the browser and
uploaded once each with a fixed id. Only people who have agreed may appear in
uploaded photographs.

## 6. Numbers the frontend must respect

- **Steps:** `stock_step` is recording precision, `sale_step` the sellable
  increment (a multiple of it). Cable: `0.001` / `0.1`. Resistor: `1` / `1`.
- **Precision:** quantities and unit prices ≤ 6 decimals; totals and costs ≤ 2.
  Excess precision is **rejected**, not rounded. Unit prices may be sub-øre.
- **Formats:** product codes `^[A-Z0-9][A-Z0-9-]{0,39}$`; unit codes
  `^[a-z][a-z0-9_]{0,23}$`; attribute codes `^[a-z][a-z0-9_]{0,63}$`. Datasheet and
  purchase URLs must be `http(s)://`.
- **Revisions:** stock `revision` (the newest movement ID) is an opaque token that
  any movement invalidates; `metadata_revision` is the master-data guard. Never mix them.
- **Derived values** (balances, outstanding, latest purchase, totals) come from the
  backend; never compute local equivalents.
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
  prices or placement or point labels at the backend. Codes are never reused. One code
  serves buyers and staff. **Scanning never registers a purchase by itself.**
  Scanners and parsing rules: [scanner.md](scanner.md).
- **Shelf map:** read topology from `catalog.shelfMap`, never by guessing from
  product rows. Derive placement from stored coordinates (highest row on top,
  column A left) with no parallel coordinate state. `has_products` counts inactive
  assignments and ignores stock. Presentation: [page-product.md](page-product.md),
  [page-home.md](page-home.md).
- **Freshness:** the public map revalidates on focus, visibility and reconnect; no
  refresh button or polling. Background reads keep map, selections, input and
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
- The guest checkout functions require `CHECKOUT_SERVER_KEY`; browsers reach them
  **only** through the Worker, which validates every guest input and enforces size
  limits, rate limits and origin/CSRF checks. Prices and totals come from the backend.
- Invitations and resets are rate limited in the backend (10 invitations per
  minute per inviter; resets 20 per minute overall and 1 per minute per address),
  and a reset request answers alike whether or not the address has an account.
- No keys, passwords, deploy keys or checkout secrets in the repo, URLs or logs.
- Error mapping: stale → conflict needing user action; retry-same → silent success;
  validation → field error; auth/privilege → access error with re-login. A failure
  without an error code (network, timeout) means "retry the same request", never
  "pay again".
- Buyer privacy: no accounts, names or stored emails. The contact string is optional
  and erasable; a receipt address is used once and never stored. Staff actions are
  attributed through their own session.

### 8.1 Error catalog (database → UI mapping)

Every deliberate backend rejection is a `ConvexError` whose `code` is one of the
names below (`fail()` in `convex/lib/errors.ts`; the message may add a detail after
`:`). Clients read it with `errorCode(error)` from `src/lib/convex.ts`. Map each
category as §8 describes. An error not in this table is a bug: report it, do not
cover it with friendly copy. No automated check compares this table with the code;
list the raised codes with `grep -rhoE "fail\('[A-Z_]+'" convex | sort -u` when you
add one.

| Category → UI treatment | Error names |
|---|---|
| **Retry-safe conflict**: same request already done with other input; a client bug, never auto-retried | `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT` |
| **Partial success**: the write committed, a follow-up failed; retry the same command | `INVITATION_EMAIL_FAILED` (membership saved, email not sent) |
| **Rate limited**: wait, then retry the same command | `RATE_LIMITED` |
| **Stale form / conflict**: someone else changed state; refresh, show current data, ask the user to confirm again | `INVITATION_SUPERSEDED`, `STALE_PRODUCT`, `STALE_SHELF_LAYOUT`, `LAYOUT_HAS_PRODUCTS`, `STALE_HELP_CONTACT`, `STALE_HELP_ORDER`, `STALE_NEWS`, `NEWS_SLUG_TAKEN`, `EVENT_ARTICLE_TAKEN`, `STALE_STOCK_COUNT`, `STALE_STOCK_CORRECTION`, `PRODUCT_BIN_UNAVAILABLE`, `BIN_STILL_HAS_PRODUCTS`, `CABINET_STILL_HAS_BINS`, `BIN_ARCHIVED`, `CABINET_ARCHIVED`, `CORRECTION_REQUIRES_RECOUNT`, `STALE_BIN_POSITION`, `STALE_CABINET_POSITION`, `BIN_POSITION_OCCUPIED`, `CABINET_POSITION_OCCUPIED`, `BIN_DOES_NOT_FIT_CABINET_GRID`, `RECEIPT_EXCEEDS_OUTSTANDING_QUANTITY`, `RECEIPT_ORDER_LINE_MISMATCH`, `INVALID_CANCELLATION_QUANTITY`, `RECEIPT_CORRECTION_OUT_OF_RANGE`, `COUNT_BATCH_FINISHED`, `CANCELLATION_ALREADY_REVERSED`, `CANNOT_REVERSE_A_REVERSAL`, `COUNT_BATCH_OWNER_STILL_ACTIVE`, `PRODUCT_CODE_TAKEN` (retry a new product with a new code) |
| **Validation**: reject the field/form with a specific message | `INVALID_SHELF_LAYOUT`, `INVALID_CATALOG_PAGE_SIZE`, `INVALID_CATALOG_QUERY`, `UNKNOWN_CATALOG_CATEGORY`, `UNKNOWN_CATALOG_ATTRIBUTE`, `INVALID_CATALOG_FILTER`, `CATALOG_CURSOR_MISSING`, `INVALID_PRODUCT` (detail names the field), `INVALID_URL`, `INVALID_ATTRIBUTE`, `ATTRIBUTE_VALUE_TYPE_MISMATCH`, `DUPLICATE_PRODUCT_SPECIFICATION`, `INVALID_CATEGORY`, `CATEGORY_NAME_TAKEN`, `INVALID_DEFINITION`, `DEFINITION_CODE_TAKEN`, `INVALID_HELP_CONTACT` (detail names the field), `HELP_CONTACT_NOT_REACHABLE`, `INVALID_NEWS`, `INVALID_NEWS_IMAGE`, `INVALID_NEWS_PAGE_SIZE`, `INVALID_NEWS_CURSOR`, `INVALID_EVENT_RANGE`, `STAFF_EMAIL_REQUIRED`, `STAFF_DISPLAY_NAME_REQUIRED`, `INVALID_ADMIN_INVITATION`, `INVALID_EMAIL`, `PASSWORD_TOO_SHORT`, `PASSWORD_TOO_LONG`, `CORRECTION_REVISION_REQUIRED`, `DUPLICATE_CORRECTION_REFERENCE`, `INVALID_ITEM_COUNT`, `PRODUCT_ID_REQUIRED`, `QUANTITY_REQUIRED`, `INVALID_QUANTITY`, `INVALID_PRICE`, `INVALID_AMOUNT`, `INVALID_QUANTITY_STEP`, `DISCRETE_UNIT_REQUIRES_WHOLE_QUANTITIES`, `POSITIVE_CART_QUANTITY_REQUIRED`, `POSITIVE_ORDER_QUANTITY_REQUIRED`, `POSITIVE_RECEIPT_QUANTITY_REQUIRED`, `DUPLICATE_OR_MISSING_CART_PRODUCT`, `DUPLICATE_OR_MISSING_ORDER_LINE`, `RECEIPT_ORDER_LINE_REQUIRED`, `UNPLANNED_RECEIPT_REQUIRES_SOURCE_NOTE`, `UNPLANNED_RECEIPT_CANNOT_HAVE_ORDER_LINE`, `RECOVERY_REASON_REQUIRED`, `REASON_REQUIRED`, `CLOSURE_REASON_REQUIRED`, `COUNT_TITLE_REQUIRED`, `SUPPLIER_NAME_REQUIRED`, `PLACED_AT_REQUIRED`, `INVALID_OCCURRED_AT`, `ORDER_PLACED_IN_FUTURE`, `TEXT_TOO_LONG`, `NOTE_TOO_LONG`, `NEGATIVE_PHYSICAL_COUNT`, `INVALID_WITHDRAWAL`, `INVALID_CHECKOUT_TOKEN`, `INVALID_CHECKOUT_REFERENCE`, `CONTACT_TOO_LONG`, `TWO_DISTINCT_BINS_AND_POSITIONS_REQUIRED`, `TWO_DISTINCT_CABINETS_AND_POSITIONS_REQUIRED`, `REQUEST_ID_REQUIRED` |
| **Not found**: the referenced object does not exist (bad ID, deleted link, wrong order); refresh and re-select | `PRODUCT_NOT_FOUND`, `STAFF_USER_NOT_FOUND`, `STAFF_NOT_FOUND`, `PRODUCT_NOT_FOR_SALE`, `ORDER_NOT_FOUND`, `ORDER_LINE_NOT_FOUND`, `BIN_NOT_FOUND`, `CABINET_NOT_FOUND`, `CANCELLATION_NOT_FOUND`, `COUNT_BATCH_NOT_FOUND`, `CORRECTED_MOVEMENT_NOT_FOUND`, `NEWS_NOT_FOUND`, `NEWS_IMAGE_NOT_FOUND`, `NEWS_PERSON_NOT_FOUND`, `INVALID_PASSWORD_LINK` (used, expired or unknown link) |
| **Access**: sign-in/permission problem; access error, offer re-login where applicable | `STAFF_REQUIRED`, `STAFF_SELF_DEACTIVATION` (another admin must deactivate this account), `INVALID_CREDENTIALS` (refused sign-in, same answer for every reason), `SIGN_IN_ONLY` (sign-up is refused), `CHECKOUT_NOT_FOUND_OR_NOT_AUTHORISED` (an ID without its secret is treated as not found), `COUNT_BATCH_BELONGS_TO_ANOTHER_STAFF_MEMBER` |
| **Guarded invariant**: the operation tried to change something immutable or break the ledger; this is a client bug, never a user-facing retry | `STORAGE_IDENTITY_IS_IMMUTABLE`, `PRODUCT_IDENTITY_AND_STOCK_UNIT_ARE_IMMUTABLE`, `DEFINITION_ID_TAKEN` (a standard specification ID already means something else; the editor locks specifications), `INVALID_CORRECTION_REFERENCE`, `INVALID_RECEIPT_ALLOCATION`, `INVALID_MOVEMENT_SIGN`, `ZERO_MOVEMENT`, `INVALID_EVENT_ACTOR`, `INVALID_EVENT_ORDER` |
| **Configuration**: deployment misconfiguration, page an operator | `CHECKOUT_SERVER_REQUIRED` (the Worker's key is missing or differs; the Worker answers `503 CHECKOUT_UNAVAILABLE`) |

Some guarded edits answer `'stale'` instead of throwing: `shelf.updateCabinet`,
`shelf.updateBin`, `orders.updateOrder` and `orders.updateOrderLine`. Treat it as
a stale form.

A failure without a code is not a rejection: a network failure, a timeout, an
argument that fails the function's validator, or a server bug. Production hides the
message of a plain `Error`, so internal functions' errors (`SEQUENCE_EXHAUSTED`,
`TEST_FIXTURES_FORBIDDEN`, `IMPORT_TARGET_NOT_EMPTY` and the like) and a missing
`SITE_URL` reach clients without a code. For a write the outcome is unknown: keep
the request ID and retry the same command ([API contract](api-contract.md)).

## 9. Acceptance criteria (must all hold in production)

These need the real deployment with real staff and non-staff sign-ins; tests on a
disposable backend prove the rules, not the production configuration.

| Situation | Expected |
|---|---|
| Same purchase confirmed twice / after network break | One sale, one withdrawal set, identical response |
| Price changes after payment basis saved | Ongoing purchase keeps shown amount |
| Partial operation failure | Nothing posted (header + lines + movements roll back together) |
| Stock moves during a count / batch closes mid-count | `STALE_STOCK_COUNT` / `COUNT_BATCH_FINISHED`; no silent overwrite |
| Signed out, non-staff, wrong checkout secret, wrong Worker key, deactivated staff | Rejected, including outside the UI ([checks](concurrency-tests.md#7-real-http-and-convex-auth-boundary)) |
| Stock reconciled against history | Balances equal movement sums (`migration:verifyStockLevels` returns nothing) |
| QR scanned on a physical phone with app-switching | Correct object opens; full buy flow survives |
| Admin invited or reactivated | Caller is audited; new account can set its password through the localized email link; confirmed account keeps its password |
| Invitation email fails or a response is lost | Membership remains, retry uses the same command, and later deactivation is never undone by a replay |
| Self-deactivation / concurrent mutual deactivation | Rejected / one admin remains active |
| Box swap retried / from stale form | Executes once / rejected without double-move |
| Abandoned batch closed | Owner preserved, closer + reason audited, stock untouched |
| Article and event saved together, retried after a lost response | Both rows exist once and are linked; a stale editor gets `STALE_NEWS`; an unpublished row and its images are not public |

## 10. Rollout

Validate locally (`./scripts/test-convex.sh`, `./scripts/test-web.sh`), verify §9
on the real deployment, and rehearse phone → Vipps → registration on synthetic
stock before deploying. Production data arrives once through the
[cutover](runbook-cutover.md) import; after that, stock changes only through
counts, receipts and adjustments, never by editing `stock_levels` or data in the
dashboard ([runbook-deploy.md](runbook-deploy.md),
[runbook-backup-restore.md](runbook-backup-restore.md)). Open launch gates:
[VALIDATION.md](../VALIDATION.md).
