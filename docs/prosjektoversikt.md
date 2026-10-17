# Ampoteket: project overview

Start here. This page explains what the system does and how it is put together.
Rules for one area live in the document listed for it in
[§11](#11-where-to-read). What is live right now (deploy, sales open or closed, hosted data) is in
[AGENTS.md](../AGENTS.md#current-state). What has been tested, and what is still
open before launch, is in [VALIDATION.md](../VALIDATION.md).

## 1. What Ampoteket is

The website of Ampoteket, a student-run electronics workshop at Pilestredet 35
that has been running for about a year. Its audience is the workshop's members:
it presents the workshop and runs a self-service parts shelf with stock control.
Write about it as an existing workshop gaining a website, not a shop opening to
the public. Buyers find components, scan QR codes on the drawers, pay with
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

Each volunteer has their own Convex Auth login (email and password) plus an
explicit staff membership. Staff maintain products, drawers and cabinets, record orders and
receipts, post corrections and withdrawals with a reason, run counts and erase
buyer contact details on request.
Active admins also invite and deactivate other admins from `/admin/admins`.
New admins set their password from the invitation email. The existing admins and
their passwords move to Convex in the cutover import
([runbook-cutover.md](runbook-cutover.md)).

## 3. Architecture

```
Buyer browser ──► SvelteKit pages ──► Worker checkout endpoints ──► Convex (checkout functions, server key)
Staff browser ──► SvelteKit pages ──► Convex (own Auth session, staff functions)
Any page      ──► server load or browser client ──► Convex (public queries)
```

| Part | Responsibility |
| --- | --- |
| SvelteKit on Cloudflare Workers | All pages, server loads, the checkout endpoints under `/api/checkouts` and buyer receipt email. The Worker holds `CHECKOUT_SERVER_KEY`, the only credential for the guest checkout functions. |
| Convex (`convex/`) | Data, integrity rules, history and Auth. Each command is one mutation, a serializable transaction that Convex retries on conflict, so one call is one atomic stock operation. `convex/schema.ts` defines the tables. |
| Convex Auth | Staff only, email and password; sign-up is refused. Buyers have no accounts. Invitation and reset emails go through Resend. |

Clients use the native Convex clients with the generated typed `api`: the browser
`ConvexClient` (convex-svelte), with live subscriptions on the product page and on
the admin products, counts, audit and product editor views; the server
`ConvexHttpClient` (`src/lib/server/convex.ts`). The only scheduled job is the
nightly contact retention (`convex/crons.ts`).

Not in v1, on purpose: an ORM, a separate job queue, offline registration,
long-lived caching of stock.

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
- **Money and quantities are exact.** The backend computes NOK amounts with exact
  decimal arithmetic
  ([datamodell.md](datamodell.md#4-units-quantities-and-rounding)); clients carry
  them as strings ([api-contract.md](api-contract.md#exact-json-values)).
- **History is immutable.** Ledger rows are never updated or deleted, and metadata
  edits are audited in the same transaction. A buyer's optional contact string is stored separately so it
  can be erased.
- **Times show in `Europe/Oslo`**, whatever the browser's time zone
  ([rules](website-guide.md#6-numbers-the-frontend-must-respect)).

## 5. Routes

Every page route also exists in English under `/en` ([i18n.md](i18n.md)). Printed QR
labels always use the Norwegian, unprefixed address.

| Route | Content |
| --- | --- |
| `/` | What the workshop is, then the parts shelf: how buying works, code lookup and a live drawer picker ([page-home.md](page-home.md); the site-wide header, menu and footer are its §2.1) |
| `/p` | Catalog: search, filters, code entry ([page-catalog.md](page-catalog.md)) |
| `/p/[code]` | Product page and QR target, e.g. `/p/RES-A3F09` ([page-product.md](page-product.md)) |
| `/cart` | The cart ([page-cart.md](page-cart.md)) |
| `/checkout/[id]` | Saved checkout, Vipps instructions, registration and retry ([page-checkout.md](page-checkout.md)) |
| `/contact` | Contact us: the Discord invite, then volunteer contacts maintained at `/admin/contacts`. Linked from the header menu and footer; `/help` redirects here (posters and sent receipts). No page doc: [website-guide.md §4.5](website-guide.md#45-help-when-registration-cannot-be-completed), [volunteer directory protocol](api-contract.md#public-volunteer-directory), [`help_contacts`](datamodell.md#help_contacts) |
| `/privacy` | What buyers' data the shop stores, where, and how to have contact details deleted; linked from the footer |
| `/admin` | Overview (with products others added since your last review), statistics, products, shelf, counts, labels, stock corrections, audit ([page-admin-stock.md](page-admin-stock.md), [page-labels.md](page-labels.md)) |
| `/admin/orders` | Orders and receipts ([page-admin-orders.md](page-admin-orders.md)) |
| `/admin/purchases` | Find a purchase by its support reference, register an unregistered one and erase the buyer's contact detail ([website-guide.md](website-guide.md#57-checkout-recovery-and-contact-erasure)) |
| `/admin/contacts` | Edit, publish and reorder the `/contact` volunteer list (same documents as `/contact`) |
| `/admin/admins` | Invite, list, reactivate and deactivate admins ([website-guide.md](website-guide.md#59-admin-access), [api-contract.md](api-contract.md#staff-membership-and-invitations)) |
| `/admin/login`, `/admin/password` | Staff sign-in; setting a password from an invitation or reset link |
| `POST /api/checkouts/…` | Worker checkout endpoints. Browsers never call the checkout functions directly. |
| `GET /api/discord`, `/api/discord/avatar/…` | Online members of the Ampoteket Discord server and their avatars, proxied and edge-cached so browsers never contact Discord |

Until `SALES_OPEN=true` is deployed, the buyer routes and the checkout API are closed
behind a "closed for maintenance" page ([website-guide.md](website-guide.md#11-environments-and-secrets)).
The buyer pages live in the `src/routes/[[locale=locale]]/(sales)/` route group, whose
layout enforces this.

Private routes (`/checkout`, `/admin`, `/api/checkouts`, `/api/admin`, in either
locale) get `Cache-Control: no-store` and `Referrer-Policy: no-referrer`; the list is
`src/lib/private-route.ts`.

One scanner dialog is shared by all shopping pages ([scanner.md](scanner.md)).
**Scanning never registers a purchase by itself.**

## 6. Access model

| Caller | Credential | Allowed |
|---|---|---|
| Visitor or signed-in non-staff | none needed | Public queries: catalog, facets, shelf map and help directory, without costs, contacts, tokens or staff identities |
| Staff | own Convex Auth session | Staff functions, each starting with `requireStaff`, including audited admin management. Stock changes only through the ledger commands |
| Worker | `CHECKOUT_SERVER_KEY`, server-side only | The three guest checkout functions (prepare, get, confirm); public queries for server loads |
| Maintainer | Convex deploy key (`bunx convex run`, dashboard) | Deploys, internal functions (import, stock projection checks), backups and restore |

The backend identifies staff from the signed-in identity; the browser never sends
an actor id. Deactivating a staff membership takes effect on the next call. A
failed read shows "Unavailable", never "0 in stock". Secrets never go in the repo,
URLs or logs. Details: [datamodell.md](datamodell.md).

## 7. Shelf numbering and QR codes

QR codes contain only `ampoteket.no/p/CODE`, never prices, placement or backend
URLs. Drawers have no identity labels; they are found by cabinet and drawer
coordinates.

Both the wall and each cabinet number rows from 1 at the **bottom** and columns
from A at the **left**. A1 is bottom-left, and adding a row on top never renumbers
existing cells. A drawer spanning several cells is named from its bottom-left cell
(C3–D4 covers columns C–D, rows 3–4). The workshop has 12 cabinets and 492
drawers; `seed:base` creates the same wall in a fresh development or test backend.

## 8. Decisions made with the owner

| Topic | Decision |
|---|---|
| Staff sign-in | Email and password; active admins invite and manage other admins in the site |
| Staff devices | Personal phones and laptops only; normal sign-in and sign-out |
| Vipps | Number 47322, QR `https://qr.vipps.no/vp/swDrxGWcp`; the buyer types the amount shown by the site |
| Product codes | Three-letter category prefix + five random hex digits, e.g. `RES-A3F09` |
| Categories | One fixed, translated list including Miscellaneous; the category picks the code prefix |
| Specifications | Standard suggestions plus custom types added in the product editor |
| Labels | A4: select cabinets or drawers on the map and print sheets. Brother: pick one drawer and print its products one by one on the P-touch printer |
| Cart after checkout | One active cart and checkout at a time, locked across tabs |
| Help when nobody is there | Buyer notes the amount and reference, then uses `/contact` |
| Retention | Unconfirmed checkouts' contact strings are cleared automatically after 90 days; checkouts, sales and history are never purged ([runbook](runbook-contact-retention.md)) |

## 9. Out of scope for v1

Payment verification, refunds and returns, reservations, customer accounts, other
currencies, lot or serial tracking, stock for one product in several places,
purchase approvals, multi-person counts and offline registration.

## 10. Repository layout

```text
src/routes/[[locale=locale]]/   pages (Norwegian at /, English at /en)
src/lib/                        components, API clients, domain logic, unit tests
src/lib/i18n/{nb,en}.ts         all UI text
convex/                         backend: schema.ts, functions per area, crons, Auth
convex/lib/                     shared rules: decimals, audit, ledger, access, commands
tests/convex/                   backend tests (scripts/test-convex.sh)
scripts/                        dev launcher, seeds, test runners, browser proofs
static/                         served files (fonts, photos, models, brand)
assets/                         sources for static/ (photos and models in Git LFS)
docs/                           the documents listed in §11
```

## 11. Where to read

Read the document for the area you are changing, not the whole set.

| Area | Document |
| --- | --- |
| Tables, Convex functions, access checks, concurrency rules, money and quantity precision | [datamodell.md](datamodell.md) |
| Website architecture, checkout, staff screens, error catalog | [website-guide.md](website-guide.md), then the relevant `page-*.md` |
| Exact values, checkout retries, scanner | [api-contract.md](api-contract.md), [checkout-recovery.md](checkout-recovery.md), [scanner.md](scanner.md) |
| Palette, tokens, typography, logo, component conventions | [design-system.md](design-system.md), [assets/brand/README.md](../assets/brand/README.md), [ui/README.md](../src/lib/components/ui/README.md) |
| UI copy, languages, locale routing, links between pages | [i18n.md](i18n.md) |
| Races that must stay correct, real-API checks, test status | [concurrency-tests.md](concurrency-tests.md), [VALIDATION.md](../VALIDATION.md) |
| Running the workshop day to day | [operating-procedures.md](operating-procedures.md), [runbook-contact-retention.md](runbook-contact-retention.md) |
| Schema or function changes, seeds, disposable validation | [README.md](../README.md), `scripts/test-convex.sh` |
| The Supabase-to-Convex cutover | [runbook-cutover.md](runbook-cutover.md) |
| Deploy, backup and restore, opening stock | [runbook-deploy.md](runbook-deploy.md), [runbook-backup-restore.md](runbook-backup-restore.md) |
