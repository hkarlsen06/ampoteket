# Ampoteket: project overview

Start here. This page explains what the system does and how it is put together.
Rules for one area live in the document listed for it in
[§11](#11-where-to-read). What has been tested, and what is still open before
launch, is in [VALIDATION.md](../VALIDATION.md).

## 1. What Ampoteket is

A self-service shop and stock system for the student-run electronics workshop at
`ampoteket.no`. Buyers find components, scan QR codes on the drawers, pay with
Vipps on trust and register the purchase, which withdraws stock. Volunteers
("admins" in the UI) maintain products, prices, placement, purchasing, counts and
corrections, all with a full audit trail.

The guiding constraint: **new students must be able to understand, operate and
extend the solution without depending on the original developer.**

## 2. How it works

### Buyers (no account, phone first)

1. Scan a drawer's QR code or browse the catalog, and put quantities in the cart.
2. "Proceed to payment" freezes names, quantities and prices into a checkout.
   That snapshot is what the buyer pays.
3. For a positive total, the buyer pays in Vipps. A zero total skips payment.
4. The buyer presses "I have paid" (or "Register collection"). The server
   registers the checkout and withdraws stock exactly once.
5. The cart clears only after the registration is confirmed. If the network fails
   after paying, the buyer retries the *registration*, never the payment.

Payment is trust-based, and the site never presents it as verified
([rule](website-guide.md#4-guest-checkout)). A saved checkout can be resumed at
its saved price indefinitely. If a buyer loses it, staff find and recover the
original checkout with a recorded reason; they never create a replacement or ask
for payment again ([checkout-recovery.md](checkout-recovery.md)).

### Staff (one role)

Each volunteer has their own Supabase Auth login plus an explicit staff
membership. Staff maintain products, drawers and cabinets, record orders and
receipts, post corrections and withdrawals with a reason, run counts and erase
buyer contact details on request.
Active admins also invite and deactivate other admins from `/admin/admins`.
Only the first admin needs maintainer setup; new admins set their password from
the invitation email.

## 3. Architecture

```
Buyer browser ──► SvelteKit pages ──► Worker endpoints ──► Supabase Postgres (RPCs)
Staff browser ──► SvelteKit pages ──► Supabase PostgREST (own staff JWT) ──► Postgres
```

| Part | Responsibility |
| --- | --- |
| SvelteKit on Cloudflare Workers | All pages, checkout endpoints under `/api/checkouts`, and authenticated admin invitations. No separate backend. |
| Supabase Postgres 17 (Stockholm) | Data, integrity rules, history. One function call is one atomic stock operation. |
| Supabase Auth | Staff only. Buyers have no accounts. |
| PostgREST | Exposes only the `public` schema. The internal `app` schema is never exposed. |

Not in v1, on purpose: Edge Functions, an ORM, realtime updates, job queues,
offline registration, long-lived caching of stock. Pages load data when opened and
after a change.

## 4. Domain model in brief

Details are in [datamodell.md](datamodell.md).

- **Products, drawers (bins) and cabinets are separate.** A product has one
  current drawer; a drawer holds many products and sits at a position in one
  cabinet; cabinets sit on the shelf wall. Moving a drawer moves its products.
  Empty drawers and cabinets can be archived. Product codes are never reused.
- **Orders record purchases already placed elsewhere.** They add no stock.
  Receipts add stock and can be partial. Cancellations need a reason and can be
  reversed once.
- **Checkout freezes the payment basis.** No reservation and no expiry. Confirming
  posts all withdrawals exactly once; a retry returns the same result.
- **Counts post immediately.** The count must match the stock revision read
  earlier, otherwise it fails with `STALE_STOCK_COUNT` and needs a fresh recount.
  Zero-difference counts are kept as proof of checking. Pause handling of a drawer
  while counting it ([operating-procedures.md](operating-procedures.md)).
- **Corrections are new movements, never edits.** Withdrawals and adjustments need
  a reason. Stock may go negative; that is a visible discrepancy, not an error.
- **Money and quantities are exact.** The database computes NOK amounts
  ([datamodell.md](datamodell.md#4-units-quantities-and-rounding)); clients carry
  them as strings ([api-contract.md](api-contract.md#exact-json-values)).
- **History is immutable.** Ledger rows cannot be updated or deleted, and metadata
  edits are audited. A buyer's optional contact string is stored separately so it
  can be erased.
- **Times show in `Europe/Oslo`**, whatever the browser's time zone
  ([rules](website-guide.md#6-numbers-the-frontend-must-respect)).

## 5. Routes

Every page route also exists in English under `/en` ([i18n.md](i18n.md)). Printed QR
labels always use the Norwegian, unprefixed address.

| Route | Content |
| --- | --- |
| `/` | What the workshop is, then the parts shelf: how buying works, code lookup and a live drawer picker ([page-home.md](page-home.md)) |
| `/p` | Catalog: search, filters, code entry ([page-catalog.md](page-catalog.md)) |
| `/p/[code]` | Product page and QR target, e.g. `/p/RES-A3F09` ([page-product.md](page-product.md)) |
| `/cart` | The cart ([page-cart.md](page-cart.md)) |
| `/checkout/[id]` | Saved checkout, Vipps instructions, registration and retry ([page-checkout.md](page-checkout.md)) |
| `/help` | Volunteer contacts, maintained at `/admin/help`, and the Discord invite |
| `/privacy` | What buyers' data the shop stores, where, and how to have contact details deleted; linked from the footer |
| `/admin` | Overview, statistics, products, shelf, counts, labels, stock corrections, audit ([page-admin-stock.md](page-admin-stock.md), [page-labels.md](page-labels.md)) |
| `/admin/orders` | Orders and receipts ([page-admin-orders.md](page-admin-orders.md)) |
| `/admin/admins` | Invite, list, reactivate and deactivate admins ([website-guide.md](website-guide.md#59-admin-access)) |
| `POST /api/checkouts/…` | Worker-only checkout endpoints. Browsers never call the checkout RPCs directly. |
| `POST /api/admin/invitations` | Authenticated staff invitations ([api-contract.md](api-contract.md#staff-membership-and-invitations)) |
| `GET /api/discord`, `/api/discord/avatar/…` | Online members of the Ampoteket Discord server and their avatars, proxied and edge-cached so browsers never contact Discord |

Until `SALES_OPEN=true` is deployed, the buyer routes and the checkout API are closed
behind a "shop opens soon" page ([website-guide.md](website-guide.md#11-environments-and-secrets)).

One scanner dialog is shared by all shopping pages ([scanner.md](scanner.md)).
**Scanning never registers a purchase by itself.**

## 6. Access model

| Caller | Credential | Allowed |
|---|---|---|
| Visitor or logged-in non-staff | publishable key / own JWT | Public catalog, facets, shelf map and help directory |
| Staff | own staff JWT (never the secret key) | Staff views and RPCs, including audited admin management; no direct ledger or membership writes |
| Worker | secret key, server-side only | Public reads, three guest checkout RPCs, and Auth account creation/invitation for a verified active staff caller. Membership changes use the caller's JWT |
| Maintainer | direct database access | Migrations, first-admin bootstrap, emergency access recovery, backups |

The database identifies staff with `auth.uid()`; the browser never sends an actor
id. Removing a staff membership takes effect on the next request. A failed read
shows "Unavailable", never "0 in stock". Secrets never go in the repo, URLs or logs.

## 7. Shelf numbering and QR codes

QR codes contain only `ampoteket.no/p/CODE`, never prices, placement or Supabase
URLs. Drawers have no identity labels; they are found by cabinet and drawer
coordinates.

Both the wall and each cabinet number rows from 1 at the **bottom** and columns
from A at the **left**. A1 is bottom-left, and adding a row on top never renumbers
existing cells. A drawer spanning several cells is named from its bottom-left cell
(C3–D4 covers columns C–D, rows 3–4). The migration creates the workshop's 12
cabinets and 492 drawers.

## 8. Decisions made with the owner

| Topic | Decision |
|---|---|
| Staff sign-in | Email and password; active admins invite and manage other admins in the site, with maintainer setup for the first admin |
| Staff devices | Personal phones and laptops only; normal sign-in and sign-out |
| Vipps | Number 47322, QR `https://qr.vipps.no/vp/swDrxGWcp`; the buyer types the amount shown by the site |
| Product codes | Three-letter category prefix + five random hex digits, e.g. `RES-A3F09` |
| Categories | One fixed, translated list including Miscellaneous; the category picks the code prefix |
| Specifications | Standard suggestions plus custom types added in the product editor |
| Labels | Select cabinets or drawers on the map and print A4 sheets; single labels can go to the P-touch printer |
| Cart after checkout | One active cart and checkout at a time, locked across tabs |
| Help when nobody is there | Buyer notes the amount and reference, then uses `/help` |
| Retention | Unconfirmed checkouts' contact strings are cleared after 90 days; checkouts, sales and history are never purged ([runbook](runbook-contact-retention.md)) |

## 9. Out of scope for v1

Payment verification, refunds and returns, reservations, customer accounts, other
currencies, lot or serial tracking, stock for one product in several places,
purchase approvals, multi-person counts, realtime sync and offline registration.

## 10. Repository layout

```text
src/routes/[[locale=locale]]/   pages (Norwegian at /, English at /en)
src/lib/                        components, API clients, domain logic, unit tests
src/lib/i18n/{nb,en}.ts         all UI text
supabase/migrations/            the schema, functions, grants and RLS
supabase/tests/                 SQL and Python database tests
scripts/                        dev launcher, seeds, test runners, browser proofs
static/                         served files (fonts, photos, models, brand)
assets/                         sources for static/ (photos and models in Git LFS)
docs/                           the documents listed in §11
```

## 11. Where to read

Read the document for the area you are changing, not the whole set.

| Area | Document |
| --- | --- |
| Tables, RPCs, permissions, concurrency rules, money and quantity precision | [datamodell.md](datamodell.md) |
| Website architecture, checkout, staff screens, error catalog | [website-guide.md](website-guide.md), then the relevant `page-*.md` |
| JSON numbers, pagination, checkout retries, scanner | [api-contract.md](api-contract.md), [checkout-recovery.md](checkout-recovery.md), [scanner.md](scanner.md) |
| Palette, tokens, typography, logo, component conventions | [design-system.md](design-system.md), [assets/brand/README.md](../assets/brand/README.md), [ui/README.md](../src/lib/components/ui/README.md) |
| UI copy, languages, locale routing, links between pages | [i18n.md](i18n.md) |
| Races that must stay correct, real-API checks, test status | [concurrency-tests.md](concurrency-tests.md), [VALIDATION.md](../VALIDATION.md) |
| Running the workshop day to day | [operating-procedures.md](operating-procedures.md), [runbook-contact-retention.md](runbook-contact-retention.md) |
| Migrations, seeds, disposable validation | [README.md](../README.md), `scripts/test-database.sh` |
| Deploy, backup and restore, opening stock | [runbook-deploy.md](runbook-deploy.md), [runbook-backup-restore.md](runbook-backup-restore.md) |
