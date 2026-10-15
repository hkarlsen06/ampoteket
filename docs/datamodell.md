# Ampoteket database design

The data contract: model, invariants, precision, concurrency, access and functions. `convex/schema.ts` and the Convex functions in `convex/` are the final word on tables, fields, checks and behaviour: where any document disagrees with them, the code wins and the document has a bug. Production runs on Supabase until the cutover ([runbook-cutover.md](runbook-cutover.md)); the Supabase-era schema and SQL are in git history (last pre-migration commit `b83c41e`).

## 1. Domain decisions

- A product is a set of interchangeable components, not a supplier item. Staff curate product identity; equal names or values are not a safe uniqueness rule. Supplier SKU and purchase URL belong to the purchase line.
- A product has at most one current bin; a bin can hold many products. A bin is a drawer inside a cabinet; a cabinet stands at one position on the wall. A product without a bin can still be sold and may carry a public `location_note`.
- One operational staff role, individual Convex Auth identities. Customers have no account and may give one optional, unverified contact string.
- There are no payment-verification, reconciliation, refund or return entities: payment is trust-based ([website-guide.md](website-guide.md#4-guest-checkout)).
- Prices and costs are historical NOK. A purchase unit cost uses the product's sale unit. Order-level extra costs are stored separately, never folded into unit cost.
- Purchase orders record orders already placed elsewhere; they reserve nothing and add no stock. Receipts can be partial or unplanned (donations are unplanned receipts). Outstanding quantity can be cancelled with a reason. A surplus delivery is a normal adjustment with a note.
- Negative recorded stock is allowed.
- Counts are open, not blind. Each count posts immediately; closing a batch posts nothing.
- Nothing that history refers to is deleted. No function deletes staff, help contacts, news articles, events, news images, units, categories, cabinets, bins, products, attribute definitions, purchase orders and lines, count batches or any ledger or audit row, and ledger rows are never patched. The only deletes in application code are specification values (`product_attributes`, audited) checkout contacts (erasure and retention, audited as `CONTACT_CLEARED`) and the derived `news_image_uses` index. Retire a product with `is_active=false`, unpublish a contact, article or event, archive storage. A hard delete needs the owner's explicit request and a reviewed one-off procedure, not a workaround.

## 2. Sources of truth

- Product, bin and cabinet position are separate, so moving a bin updates one row.
- An ordered amount is not evidence of stock; only receipts add stock.
- A movement's quantity is stored once. Receipt allocations and correction links point at the movement.
- Checkout names and prices, and count expected/observed quantities, are historical facts, not caches of current values.
- Customer contact data is separate from immutable history.

Latest purchase price/URL, outstanding quantity, order status and checkout totals are never stored; queries derive them. Stock is the sum of the ledger. `stock_levels` holds a rebuildable projection of it (quantity, revision, last count), written in the same transaction as every movement ([§11](#11-read-models)); it is a cache of the ledger, not a second source of truth.

Arbitrary JSON is stored only in idempotency results and audit images; the image and link lists of news articles and events are typed in the schema.

## 3. Relations at a glance

| Area | Tables |
| --- | --- |
| Catalogue | `units`, `categories`, `cabinets`, `bins`, `products` |
| Component specifications | `attribute_definitions`, `product_attributes` |
| Public support | `help_contacts` |
| Newsroom and calendar | `news_articles`, `events`, `news_images`, `news_image_data`, `news_image_uses` |
| Staff | `staff_members` |
| Purchasing | `purchase_orders`, `purchase_order_lines`, `purchase_order_cancellations` |
| Checkout | `checkouts`, `checkout_lines`, `checkout_contacts`, `sales` |
| Counting | `count_batches`, `stock_counts` |
| Inventory | `inventory_events`, `inventory_movements`, `receipt_allocations`, `movement_corrections`, `stock_levels` |
| Infrastructure | `command_requests`, `audit_log`, `counters`, `rate_limits` |
| Accounts | Convex Auth tables (`users`, `authAccounts`, sessions and tokens), `password_tokens` |

```text
cabinet 1 ---- many bins 1 ---- many products
product  1 ---- many product_attributes ---- 1 attribute_definition
order    1 ---- many order_lines
order_line 1 ---- many receipt_allocations ---- 1 movement
order_line 1 ---- many cancellation entries
checkout 1 ---- many checkout_lines
checkout 1 ---- 0..1 optional contact
checkout 1 ---- 0..1 sale ---- 1 inventory event
count_batch 1 ---- many stock_counts ---- 1 inventory event
inventory_event 1 ---- many movements (a matching count has zero movements)
movement 1 ---- many later correction links
product 1 ---- 0..1 stock_levels row
staff_member 0..1 ---- 1 users row (by auth_user_id)
news_article 1 ---- 0..1 event (by events.article_id)
news_article/event ---- many tagged help_contacts and news_images (ordered lists in the row)
news_image 1 ---- 1 news_image_data row
```

Application rows refer to each other by the UUID in their `id` field, never by Convex `_id`; only `password_tokens` and the Convex Auth tables use `_id` references. There are no foreign-key constraints: the functions look up each referenced row before writing.

## 4. Units, quantities and rounding

`products.unit_code` (`pcs`, `m` or `g`) is both the stock and the sale unit. Grams are for goods sold by weight, such as 3D printer filament. There is no pack conversion: a pack of 100 resistors is 100 pieces.

Each product has a `stock_step` and a `sale_step` (for example cable stocked to 0.001 m, sold per 0.1 m). `sale_step` must be a whole multiple of `stock_step`, and a discrete unit (`pcs`) needs whole steps; `products.save` checks precision and step.

Quantities and money are exact decimal strings, never `number` or float. `convex/lib/decimal.ts` does the arithmetic with BigInt and rejects excess precision instead of rounding it:

| Helper | Used for | Rule |
| --- | --- | --- |
| `checkedQuantity` | Command quantities, steps, minimum stock | At most 6 decimals, magnitude at most 999999999999. |
| `checkedUnitPrice` | Sale prices and purchase unit costs | At most 6 decimals, from 0 to 999999999999. |
| `checkedStockQuantity` | Balances and count values | At most 6 decimals, no magnitude bound. |
| `checkedNokAmount` | Extra costs | At most 2 decimals, from 0 to 999999999999. |

Every stored quantity is also a whole multiple of the product's stock step (`INVALID_QUANTITY_STEP`); cart quantities are multiples of the sale step.

Product code, unit and stock step are immutable (`PRODUCT_IDENTITY_AND_STOCK_UNIT_ARE_IMMUTABLE`); a change needs a new product. Name, price and sale step can change with audit; existing checkouts keep what they accepted.

```text
line total = round(quantity × saved unit price, 2)
checkout total = sum(line totals)
```

Round each line once (half away from zero, `roundDecimal`), then add. A checkout has one line per product. Unit prices may be below one øre.

The backend computes every amount. Clients carry quantities, money, movement IDs and revisions as strings ([api-contract.md](api-contract.md#exact-json-values)).

Timestamps are UTC ISO strings with six fractional digits (`convex/lib/time.ts`), so string order is time order. `Date.now()` is fixed for the whole of one mutation.

## 5. Stock, revisions and immutable history

```text
quantity = sum(inventory_movements.quantity_delta for the product), 0 if none
revision = max(inventory_movements.id for the product), 0 if none
```

Movement IDs come from a gap-free global sequence (`counters`, `convex/lib/sequence.ts`). The revision is an opaque per-product concurrency token. Every movement changes it, so a withdrawal plus a compensating receipt still invalidates an earlier count.

A new product has zero **recorded** stock, which says nothing about the physical bin. Load opening stock through counts or documented adjustments.

`recorded_at` is set by the backend when the event is written. Backdating `occurred_at` (receipts only) does not reorder history or the revision.

| Kind | Delta | Meaning |
| --- | --- | --- |
| `receipt` | Positive | Goods actually added. Order link optional. |
| `sale` | Negative | Buyer registered or staff recovered the original frozen checkout; no payment verification. |
| `count` | Positive or negative; no movement for zero difference | Reconcile to a physical observation. |
| `withdrawal` | Negative | Staff use, giveaway or disposal, with required reason. |
| `adjustment` | Non-zero signed amount | Reasoned correction or exceptional adjustment. |

`convex/lib/inventory.ts` is the only writer of events, movements, correction links, receipt allocations and `stock_levels`; command modules insert counts, sales, checkout snapshots and cancellations. No function patches or deletes any of them. A correction is a new movement linked to the one it corrects. Correcting a receipt from 60 to 10 posts -50 allocated to the same order line, so order progress updates too. Unlinked adjustments never touch order progress.

Only the application enforces this. Anyone with the deployment admin key or dashboard access can write any table, and the test-only fixture functions can too where `ALLOW_TEST_FIXTURES=true`. Restrict that access and keep backups.

## 6. Orders and latest purchase

```text
received = sum(signed movement quantities allocated to the order line)
cancelled = sum(cancellations) - sum(cancellation reversals)
outstanding = max(ordered - received - cancelled, 0)
```

- `lineProgress` in `convex/lib/inventory.ts` computes these per line on every read.
- Cancelling never reduces stock or changes `ordered_quantity`. A cancellation can be reversed once, with a reason.
- Order status is derived, never edited. "Receive everything" sends the remaining quantities, not the ordered ones. A receipt line cannot exceed the line's outstanding quantity (`RECEIPT_EXCEEDS_OUTSTANDING_QUANTITY`).
- `placed_at` may be at most one day after the order is recorded (`ORDER_PLACED_IN_FUTURE`, on recording and on edits). A mistyped year would otherwise pin the wrong latest price.
- Supplier, reference, placement time, extra cost and note, and each line's cost, URL and SKU can be corrected as audited metadata; ordered quantities and product links cannot.

Latest purchase is one line per product: newest `placed_at`, then recorded time, order ID and line number. A line counts if it has a positive cost and some quantity received or still expected. Donations never count. Price and URL come from the **same** line; if it has no URL, the result is null. No current query returns latest purchase; one that does must follow this definition.

## 7. Checkout and customer data

The guest protocol and retries are owned by [checkout-recovery.md](checkout-recovery.md). Data rules:

- Proceeding to payment freezes one line per product, priced from the product rows in the same transaction. An inactive or borrow-only product raises `PRODUCT_NOT_FOR_SALE`. Show the returned snapshot before sending the buyer to Vipps.
- A checkout reserves no stock and never expires. Checkouts and retry records are kept forever. A `sales` row means registered (by staff when `recovered_by` and `recovery_reason` are set). No row means **unconfirmed**, not "unpaid".
- Confirmation writes all movements and the sale in one transaction and returns the existing result on repeat. It does not re-read prices, reject deactivated products, require stock or verify payment. A zero-total checkout registers without a payment claim (`payment_required` is false).
- Payment is outside the transaction. Never tell a buyer to pay again because registration failed.
- Customers cannot revise a registered purchase; staff use linked corrections. `checkout.staffLookup` finds a checkout by its ID or its prepare request ID, so staff can find an attempt whose response was lost.
- The backend stores only the SHA-256 of the Worker's 64-hex-character checkout token. Reading or confirming needs ID and token. The three guest functions require the Worker's `CHECKOUT_SERVER_KEY` ([§9](#9-access-and-permissions)). Keep tokens out of URLs and logs.
- The contact string is optional, unverified and not authentication. Contacts on unconfirmed checkouts are cleared 90 × 24 hours after the checkout by a nightly job; others can be erased on request with `checkout.clearContact`. It never enters audit images, notes or application logs, and the retry record keeps only a digest of the input. See [runbook-contact-retention.md](runbook-contact-retention.md) and [operating-procedures.md](operating-procedures.md).

## 8. Atomic operations and concurrency

- Each command is one Convex mutation, a serializable transaction; an error rolls everything back. Separate function calls do not share a transaction. No transaction stays open while a person counts or pays.
- Convex detects conflicting transactions and retries the loser, which then sees the winner's writes. Row locks, lock orders and isolation-level checks are therefore unnecessary; the rules they protected still hold:
  - A count submits the revision it read. If stock has moved since, it raises `STALE_STOCK_COUNT`; the UI asks for a fresh count and never swaps in the new revision. A linked correction is checked the same way (`STALE_STOCK_CORRECTION`). Unregistered physical movements are invisible to this check, so pause the bin and settle pending registrations first ([operating-procedures.md](operating-procedures.md)).
  - Receipts, cancellations and receipt corrections read the line's outstanding quantity in their own transaction, so they cannot overdraw it together.
  - A checkout has at most one `sales` row: a repeated or concurrent confirmation, or a staff recovery, returns the existing registration.
  - Nobody can deactivate themselves (`STAFF_SELF_DEACTIVATION`), and every access change re-reads the actor's own membership in its transaction, so two members cannot deactivate each other at once and a deactivated actor cannot finish an access change.
- `command_requests` (`convex/lib/commands.ts`) stores command name, actor, the SHA-256 of the canonical JSON input and the result. The request ID must be a UUID (`REQUEST_ID_REQUIRED`). A retry with the same ID, command, actor and input returns the stored result; concurrent duplicates act once and get the same result. Reusing an ID with other input or another actor raises `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT`.
- Confirmation, finishing a batch and clearing a contact are repeat-safe by object identity. Metadata edits are compare-and-set against the values the editor showed: product saves against `metadata_revision` (separate from the stock revision, `STALE_PRODUCT`), help contacts against `edit_revision` (`STALE_HELP_CONTACT`), orders, lines, bins and cabinets against their before-image (result `'stale'`). A retry whose change already applied succeeds without writing again. Other commands take a `requestId`; reuse it on retry.
- Directory moves compare the complete current order with the order the caller saw (`STALE_HELP_ORDER`); a retry that already matches the desired order changes nothing.
- An error with a code (`fail` in `convex/lib/errors.ts`, read with `errorCode` from `src/lib/convex.ts`) proves the command rolled back. No code (network, timeout, server bug) means the outcome is unknown: keep the request ID and retry.

`tests/convex/concurrency.test.ts` runs overlapping commands in parallel against a real backend: two counts against the same revision (exactly one posts), duplicate confirmations (one sale), concurrent duplicates of one request ID (same result, acts once), many sales of one product (exact ledger) and two members deactivating each other (one succeeds). The case list is in [concurrency-tests.md](concurrency-tests.md).

## 9. Access and permissions

| Caller | Permitted access |
| --- | --- |
| Anyone | `catalog.page`, `catalog.product`, `catalog.facets`, `catalog.shelfMap`, `catalog.helpDirectory`; the published newsroom reads `news.feed`, `news.article`, `news.calendar`, `news.event` and `news.image`; `members.me` (null when signed out); sign-in (`session.signIn`, built on Convex Auth's own `auth.*` functions) and the password-link functions (`passwords.requestReset`, `passwords.checkLink`, `passwords.complete`). |
| Signed-in non-staff | The same; `members.me` returns `membership: null` and every staff function raises `STAFF_REQUIRED`. |
| Active staff | Every function that starts with `requireStaff`: staff reads, audited master-data edits, operational commands and membership changes. |
| Worker gateway | `checkout.prepare`, `checkout.get`, `checkout.confirm`, with `serverKey`. |
| Deployment admin key | Internal functions (`bunx convex run`): `migration.*`, `seed.*`, `fixtures.*`, `retention.*`, `members.grantAccess`, `passwords.storeToken`, `passwords.resetTarget`. Treat as privileged access outside ordinary operations. |

- Public queries expose no costs, contacts, tokens, staff identities, checkout history or internal notes.
- `requireStaff` (`convex/lib/staff.ts`) maps the caller's Convex Auth user to `users.auth_user_id` and then to an active `staff_members` row. The actor always comes from the signed-in identity, never from an argument.
- The guest functions compare `serverKey` with the deployment's `CHECKOUT_SERVER_KEY` (at least 32 characters, constant-time) and raise `CHECKOUT_SERVER_REQUIRED` otherwise. Buyers never call Convex directly; the Worker keeps request-size limits, rate limiting, origin checks and the checkout cookie ([api-contract.md](api-contract.md)).
- `fixtures.*`, `seed.demo` and `migration.resetForRehearsal` refuse unless the deployment sets `ALLOW_TEST_FIXTURES=true`, which production never does. `seed.base` (units and the 12-cabinet wall; refuses a deployment with cabinets) and `seed.staff` are for fresh development and test deployments.
- Convex Auth (`convex/auth.ts`) uses the Password provider with bcrypt cost 10, so imported Supabase hashes keep working. Sign-up is refused (`SIGN_IN_ONLY`); passwords are 8 characters to 72 bytes (`PASSWORD_TOO_SHORT`, `PASSWORD_TOO_LONG`). `session.signIn` answers a wrong password, an unknown address and too many failed attempts alike with `INVALID_CREDENTIALS`.
- A new public function is a deliberate API: add it to §10.

### Public volunteer directory

`help_contacts` is deliberately public and grants no access. Never put buyer contact data in it. Publishing requires at least one valid Discord username, email, phone or HTTPS URL (DNS hostname; no credentials, whitespace, control characters or backslashes) (`HELP_CONTACT_NOT_REACHABLE`). Render fields as text and validate links in the frontend too. `catalog.helpDirectory` returns only published rows. Staff edit through `help.save` with an `edit_revision` guard and arrange the list with `help.reorder`; `display_order` is never typed ([protocol](api-contract.md#public-volunteer-directory)). Entries are unpublished, never deleted, and every change is audited.

### Newsroom and event calendar

Articles (`news_articles`) and events (`events`) are separate rows; an event may belong to one article through `events.article_id`, so the event owns the link, and `news.save` refuses a second event for the same article (`EVENT_ARTICLE_TAKEN`). Staff write both only through `news.save`, so an article and its event are created, linked, unlinked and published in one atomic, retry-safe command ([protocol](api-contract.md#news-and-events)). Rows are unpublished, never deleted, and every version is audited through `convex/lib/audit.ts`.

Images are stored as bytes in `news_image_data`, beside their metadata in `news_images`, so snapshot exports include them and lists read only the metadata. The browser re-encodes an upload to WebP or JPEG (at most 1600 px and 1 MB, which drops EXIF and GPS) before `news.addImage` stores it; the declared type must match the file signature. Image rows never change. `news_image_uses` records which article or event lists each image; `news.save` rewrites it with the row, and `news.image` returns an image only while a published article or event uses it, so an orphaned or unpublished upload is never public.

Tagged people are `help_contacts` IDs. Public reads return only published contacts, with the same fields as `catalog.helpDirectory`, so tagging someone not on `/contact` shows nothing publicly. Slugs are chosen once from the title and never change.

### Staff provisioning

Active staff invite, reactivate and deactivate other members from the Admins page ([protocol](api-contract.md#staff-membership-and-invitations)).

- `members.list` returns every membership: `id`, `authUserId`, `displayName`, `email`, `isActive`, `emailConfirmed`, active members first. A membership whose Auth user is missing has null `authUserId` and `email`.
- `members.invite` (action) takes `requestId`, `email`, `displayName`, `locale` (`nb`/`en`), `targetId` and `targetActive`. It first runs the internal mutation `members.grantAccess`, which re-reads the inviter's active membership (`STAFF_REQUIRED`), rate limits 10 invitations per minute per inviter (`RATE_LIMITED`), normalises the email (trimmed, lower case) and checks it (`STAFF_EMAIL_REQUIRED`) and the 1–120 character name (`STAFF_DISPLAY_NAME_REQUIRED`). In one transaction it creates the account without a password if the email has none, then creates or reactivates the membership. An already-active membership is a no-op and keeps its name; reactivation keeps the staff ID and applies the supplied name.
- A resend or reactivation from an existing row passes its staff ID and active state as `targetId`/`targetActive` (true for resend, false for reactivation; both null or both set, else `INVALID_ADMIN_INVITATION`). If the email now belongs to another identity, the row's state changed, or the account is gone (`STAFF_USER_NOT_FOUND`), it fails before writing; `INVITATION_SUPERSEDED` means a stale resend cannot undo a revocation. A replay of a completed grant also raises `INVITATION_SUPERSEDED` once the member has been deactivated. A null `targetId` is a deliberate email-based invitation, which also links an existing account by email.
- After the grant, a confirmed account keeps its password (result `existing_account`). Otherwise the action stores a single-use invitation link (7 days) and emails it through Resend; `INVITATION_EMAIL_FAILED` means access exists and the same request can be retried to send again.
- `members.deactivate` takes `requestId` and `staffId`, returns the staff UUID and sets `is_active=false`. Repeated deactivation is a no-op. The caller cannot deactivate themselves (`STAFF_SELF_DEACTIVATION`); an unknown ID raises `STAFF_NOT_FOUND`.
- Grants and deactivations use `command_requests`, keep historical references and audit the acting member. Staff rows are never deleted.
- Password links: `passwords.requestReset` (action, `email`, `locale`) gives the same answer whether or not the address exists and is rate limited 20 per minute overall and 1 per minute per address. Links are `<SITE_URL>[/en]/admin/password?next=/admin&token_hash=<64 hex>&type=invite|recovery`; a reset is valid one hour, and a new link voids the user's earlier unused links. `passwords.checkLink` reports whether a link is usable; `passwords.complete` sets the password, consumes the link, marks the email confirmed and returns the email so the page can sign in. Used, expired or unknown links raise `INVALID_PASSWORD_LINK`.

Production's members come from the Supabase import at cutover ([runbook-cutover.md](runbook-cutover.md)); `seed.staff` creates a member in development and test deployments. No function restores access when no active member remains; that recovery needs the deployment admin key and a deliberate plan.

## 10. Function contracts

Functions are called as `module.function` (`api.stock.adjust` in clients, `stock:adjust` on the CLI). Arguments and results are in the code; quantities, prices, revisions and movement IDs are decimal strings. Every staff command below starts with `requireStaff`.

| Function | Caller | Arguments | Result |
| --- | --- | --- | --- |
| `checkout.prepare` | Worker | `serverKey`, `requestId`, `token`, `contact`, `items[{productId, quantity}]` | Freeze a checkout; `{checkout_id}`. |
| `checkout.get`, `checkout.confirm` | Worker | `serverKey`, `checkoutId`, `token` | Read, or register once; the buyer snapshot. |
| `checkout.recover` | Staff | `requestId`, `checkoutId`, `reason` | Register the original checkout with a reason; converges with guest retries. |
| `checkout.clearContact` | Staff | `checkoutId` | Remove the optional contact; repeat-safe. |
| `orders.recordOrder` | Staff | `requestId`, `supplierName`, `placedAt`, `additionalCostNok`, `supplierReference`, `note`, `items[{productId, quantity, unitCostNok, purchaseUrl, supplierSku}]` | Record an already-placed order. |
| `orders.recordReceipt` | Staff | `requestId`, `orderId`, `note`, `occurredAt`, `items[{productId, orderLineId, quantity}]` | Receive goods, with or without an order. |
| `orders.cancelQuantities` | Staff | `requestId`, `orderId`, `reason`, `items[{orderLineId, quantity}]` | Cancel outstanding quantity. |
| `orders.reverseCancellation` | Staff | `requestId`, `cancellationId`, `reason` | Reverse one cancellation. |
| `orders.updateOrder`, `orders.updateOrderLine` | Staff | `id`, `expected`, `next` | Correct order metadata; `'saved'` or `'stale'`. |
| `stock.adjust` | Staff | `requestId`, `items[{productId, quantityDelta, correctsMovementId?, expectedRevision?}]`, `reason` | Signed adjustments, optionally linked corrections. |
| `stock.withdraw` | Staff | `requestId`, `items[{productId, quantity}]`, `reason` | Non-sale withdrawals; positive quantities. |
| `stock.recordSingleCount` | Staff | `requestId`, `productId`, `expectedRevision`, `counted`, `note` | One count in its own finished batch. |
| `stock.correctAndCount` | Staff | `requestId`, `correctsMovementId`, `expectedRevision`, `quantityDelta`, `counted`, `reason` | Linked correction plus fresh count, atomically. |
| `stock.startCountBatch` | Staff | `requestId`, `title` | Open a batch owned by the caller. |
| `stock.recordCount` | Batch owner | `requestId`, `batchId`, `productId`, `expectedRevision`, `counted`, `note` | Post one observation. |
| `stock.finishCountBatch` | Batch owner | `batchId` | Close the batch; repeat-safe. |
| `stock.closeAbandonedCountBatch` | Staff | `requestId`, `batchId`, `reason` | Close a batch whose owner is gone. |
| `products.save` | Staff | `payload`, `revision`, `attributes?`, `attributeBefore?` | Create (`revision` null) or edit a product with its specifications. |
| `products.setAttribute` | Staff | `productId`, `before`, `after` | Set or remove one specification. |
| `products.rename` | Staff | `kind` (`category`/`definition`), `id`, `before`, `after` | Rename a category or relabel a specification. |
| `products.createDefinition` | Staff | `id`, `code`, `label`, `value_type`, `canonical_unit` | A new specification type. |
| `help.save`, `help.reorder` | Staff | `id`, `revision`, `fields`; `ids`, `expectedIds` | Edit or rearrange volunteer contacts. |
| `news.addImage` | Staff | `id`, `contentType`, `data` (bytes), `width`, `height` | Store a re-encoded image; repeat-safe with the same ID and bytes. |
| `news.save` | Staff | `requestId`, `article`, `event` | Save an article, its event or both ([protocol](api-contract.md#news-and-events)). |
| `members.invite`, `members.deactivate` | Staff | See [Staff provisioning](#staff-provisioning) | Add/reactivate or deactivate another member. |
| `shelf.*` | Staff | See below | Layouts, moves, swaps and retirement. |

Command rules:

- Item lists hold 1–200 items (`INVALID_ITEM_COUNT`). Reasons are non-blank and at most 2000 characters (`REASON_REQUIRED`); an unplanned receipt needs a source note (`UNPLANNED_RECEIPT_REQUIRES_SOURCE_NOTE`).
- One receipt call covers one order or none. With an order, every item names a line of that order and product (`RECEIPT_ORDER_LINE_REQUIRED`, `RECEIPT_ORDER_LINE_MISMATCH`); without one, no item may (`UNPLANNED_RECEIPT_CANNOT_HAVE_ORDER_LINE`).
- A linked correction needs the `expectedRevision` read with the history (`STALE_STOCK_CORRECTION` if stale). If any count followed the target movement, it fails with `CORRECTION_REQUIRES_RECOUNT`; use `stock.correctAndCount`. A receipt correction inherits the receipt's order line and must keep received quantity between 0 and ordered minus cancelled (`RECEIPT_CORRECTION_OUT_OF_RANGE`).

### Shelf layouts and storage

Coordinates and spans are described under `cabinets` and `bins` in Appendix A.

- `shelf.saveLayout` (`requestId`, `before`, `cabinet`, `beforeBins`, `bins`) takes the exact original cabinet and live drawers (null/empty for a new cabinet) plus the desired ones. The argument validators reject unexpected keys and wrong types; invalid coordinates, codes, overlaps, duplicates, more than 4096 drawers or cells, or a changed drawer code raise `INVALID_SHELF_LAYOUT`. Any intervening change raises `STALE_SHELF_LAYOUT`: refresh and review, never resubmit with a new snapshot automatically.
- The client assigns drawer UUIDs and codes once and keeps them across retries. Retained drawers keep their identity; omitted drawers are archived.
- An assigned drawer (inactive products count) can only grow at its anchor over whole neighbours that the layout removes, and those must be unassigned. Removing, shrinking or moving it raises `LAYOUT_HAS_PRODUCTS`.
- `shelf.updateBin` and `shelf.updateCabinet` (`before`, `after`) move or relabel one drawer or cabinet into free cells and return `'saved'`, or `'stale'` when the row no longer matches `before`. Collisions raise `BIN_POSITION_OCCUPIED`, `CABINET_POSITION_OCCUPIED` or `BIN_DOES_NOT_FIT_CABINET_GRID`; codes and IDs are immutable (`STORAGE_IDENTITY_IS_IMMUTABLE`). Spans and cabinet grids change only through `shelf.saveLayout`.
- `shelf.swapBins` and `shelf.swapCabinets` (`requestId`, `first`, `second`) exchange two occupied positions; drawer spans travel with the drawers. Stale forms raise `STALE_BIN_POSITION`/`STALE_CABINET_POSITION`. Moves leave vacant cells.
- Retire storage with `is_archived=true`. A bin must have no assigned products (`BIN_STILL_HAS_PRODUCTS`); a cabinet no live bins (`CABINET_STILL_HAS_BINS`). Archiving frees the position; the audit keeps it. `shelf.archiveCabinet` (`requestId`, `before`, `beforeBins`) retires a cabinet and all its empty drawers at once. `shelf.archivedBinLocations` (`binIds`) shows where archived drawers used to be.

### Count batches

Only the owner can post to or finish a batch (`COUNT_BATCH_BELONGS_TO_ANOTHER_STAFF_MEMBER`, `COUNT_BATCH_FINISHED`). If the owner is deactivated or has no Auth identity, another staff member can call `stock.closeAbandonedCountBatch` with a reason; this keeps `owner_id`, records who closed it and posts no stock. An active owner cannot be bypassed (`COUNT_BATCH_OWNER_STILL_ACTIVE`).

### Metadata edits

Master-data writes go through `convex/lib/audit.ts` (`insertAudited`, `patchAudited`, `deleteAudited`), which writes the before/after image to `audit_log` in the same transaction; a patch that changes nothing writes nothing. Product edits cannot change code, unit or stock step. A standard category or specification (from `src/lib/product-specifications.ts`) is created with its fixed ID on first use; an existing ID or code that means something else raises `DEFINITION_ID_TAKEN`, `DEFINITION_CODE_TAKEN` or `CATEGORY_NAME_TAKEN`.

## 11. Read models

| Query | Caller | Returns |
| --- | --- | --- |
| `catalog.page` | Public | One page (at most 200) of active products in catalog order with stock, last count, placement and specifications, filtered by search, categories, specifications, cabinets or bins ([details](api-contract.md#catalog-and-topology)). |
| `catalog.product` | Public | One active product by exact code, or null. |
| `catalog.facets` | Public | Categories with active products and the specification values within the selected ones. |
| `catalog.shelfMap` | Public | Live cabinets and bins with `has_products` (any assigned product, active or not). |
| `catalog.helpDirectory` | Public | Published support contacts in display order. |
| `news.feed`, `news.article` | Public | Published articles, newest first, and one article with its images, links, tagged contacts and published event. |
| `news.calendar`, `news.event` | Public | Published events overlapping a range of at most 400 days, and one event with its published article. |
| `news.image` | Public | One image's bytes, only while a published row uses it; served by the Worker at `/api/news/images/<id>`. |
| `members.me` | Anyone | The signed-in user and their active membership, or null. |
| `stock.inventory` | Staff | Quantity, revision and last count per product (from `stock_levels`). |
| `stock.detail` | Staff | One product's balance, movements (newest first) with correction and order links, and counts. |
| `stock.countBatches`, `stock.countDetail` | Staff | Grouped count batches and their owners; one batch with its observations and products. |
| `orders.list`, `orders.detail` | Staff | Orders (open first) with line progress; one order with lines, cancellations, receipts and actors. |
| `orders.outstandingByProduct`, `orders.unplannedReceipts` | Staff | Quantity still expected per product; receipts without an order. |
| `products.list`, `products.get`, `products.createdSince`, `products.references`, `products.attributes` | Staff | Product master data, categories, definitions, units and specification values. |
| `shelf.admin` | Staff | Every cabinet and drawer, archived too, and every product's drawer assignment. |
| `help.list` | Staff | Every contact, drafts included, with `edit_revision`. |
| `news.list`, `news.adminImage` | Staff | Every article and event, drafts included, with `edit_revision`; any stored image for editor previews. |
| `members.list` | Staff | The membership directory ([Staff provisioning](#staff-provisioning)). |
| `checkout.staffLookup`, `checkout.staffContact` | Staff | A checkout by ID or prepare request ID; its contact, read only when staff choose to show it. |
| `statistics.read` | Staff | Sales summary and overview ([response](api-contract.md#staff-statistics)). |
| `auditLog.page`, `auditLog.productCreations` | Staff | 200 audit entries per page, newest first, with the names they refer to; product creations since a time. |

`stock_levels` is the projection of §5: `quantity` and `revision` per product, plus `last_counted_at`, the `recorded_at` of the product's latest count (also a count with no movement). A product without a row has quantity 0, revision 0 and no count. `migration.verifyStockLevels` lists products whose row disagrees with the ledger (it must return nothing) and `migration.rebuildStockLevels` recomputes rows from the ledger.

Order progress and checkout totals are computed on read from §6 and §4. Token digests, password tokens and command requests are never returned. The public catalogue never shows the ledger, costs or incoming orders.

Never add quantities across units. Staff statistics are defined in [api-contract.md](api-contract.md#staff-statistics). Add indexes or caching only after measuring.

## 12. Testing

`./scripts/test-convex.sh` starts a disposable local Convex backend with a fresh instance secret, its own Auth keys, `ALLOW_TEST_FIXTURES=true` and an email stub, deploys `convex/` with type checking, runs `bun test tests/convex`, then deletes everything. The files are `accounts`, `checkout`, `concurrency`, `migration`, `orders`, `seed`, `shelf-and-help` and `stock` (`*.test.ts`, with `harness.ts`). Setup is in [README.md](../README.md) and executed evidence in [VALIDATION.md](../VALIDATION.md).

The backend suite calls the functions through the native client but cannot prove the Worker, the browser or real sign-ins; the browser proofs (`./scripts/test-web.sh`) and production acceptance cover those ([concurrency-tests.md](concurrency-tests.md), [VALIDATION.md](../VALIDATION.md)).

After a restore or import, `bunx convex run migration:verifyStockLevels` must return an empty list.

## Appendix A. Complete table definitions

Current table contracts from `convex/schema.ts`; update them with any schema change. Field names match the former PostgreSQL columns. Quantities and prices are in the product's unit; money is NOK.

Notation: `uuid` is a UUID string, the row identity in `id` (index `uuid`) and in every reference; `decimal` is an exact decimal string; `timestamp` is a UTC ISO string with six fractional digits; `int` is a Convex number holding an integer; `?` marks a field that holds explicit `null` when empty. Every table also has Convex's own `_id` and `_creationTime`, which clients never use. The schema enforces only these types; each check listed below lives in the named file.

### `units`

`code text, name text, symbol text, is_discrete boolean`

Written only by `seed.base`, `seed.demo` and the import (`pcs`, `m`, `g`); no staff function changes units, and nothing checks the code format.

### `staff_members`

`id uuid, auth_user_id uuid?, display_name text, is_active boolean, created_at timestamp`

Internal staff IDs never change. `auth_user_id` is `users.auth_user_id`, the stable Auth UUID (imported from Supabase for existing accounts). `members.grantAccess` checks the trimmed name is 1–120 characters without control characters; one membership per Auth user. Active staff manage access through audited functions (§9).

### `help_contacts`

`id uuid, display_name text, email text?, phone text?, contact_url text?, display_order int, is_published boolean, edit_revision int, created_at timestamp, updated_at timestamp, responsibility text?, discord text?`

Public volunteer directory (§9). Unpublish to remove an entry. Checks in `convex/help.ts` (`INVALID_HELP_CONTACT` with the field name):

- `display_name`: 1–120 characters trimmed, no control characters. `responsibility`: 1–80 trimmed, no control characters.
- `email`: at most 254 characters, `local@domain.tld` shape.
- `phone`: 3–40 characters of digits, spaces, parentheses and hyphens, optional leading `+`, starting and ending with a digit, at least 3 digits.
- `contact_url`: at most 500 characters, `https://` with a DNS hostname, optional port up to 65535, no whitespace, backslashes or control characters.
- `discord`: current usernames, 2–32 of `a-z`, `0-9`, `_` and `.`, never two periods in a row.
- A published entry needs at least one of email, phone, URL or Discord (`HELP_CONTACT_NOT_REACHABLE`).
- `display_order` is assigned (last + 1 on create) and rewritten only by `help.reorder`; `edit_revision` starts at 1 and increases on each edit.

### `news_images`, `news_image_data`, `news_image_uses`

`news_images`: `id uuid, content_type text, width int, height int, created_by uuid, created_at timestamp`. `news_image_data`: `image_id uuid, data bytes`. `news_image_uses`: `image_id uuid, owner_id uuid`.

Newsroom images (§9). Checks in `convex/news.ts` (`INVALID_NEWS_IMAGE`): `content_type` is `image/webp`, `image/jpeg` or `image/png` and matches the file signature; 1 byte to 1,000,000 bytes (a Convex document holds at most 1 MiB); width and height 1–4096. Image rows never change. `news_image_uses` is derived from the `images` lists, rewritten by every save, and not audited.

### `news_articles`

`id uuid, slug text, title text, summary text?, body text, images [{id, alt}], links [{label, url}], people uuid[], is_published boolean, published_at timestamp?, edit_revision int, created_at timestamp, updated_at timestamp`

Checks in `convex/news.ts` (`INVALID_NEWS`), shared with `events` where the field exists:

- `slug`: `^[a-z0-9]+(-[a-z0-9]+)*$`, at most 80 characters, unique per table (`NEWS_SLUG_TAKEN`), never changed after creation.
- `title`: 1–160 characters trimmed; `summary`: 1–300 trimmed; no control characters. `body`: at most 20000 characters of plain text (a blank line starts a new paragraph), line breaks and tabs only.
- `images`: at most 8 distinct existing images (`NEWS_IMAGE_NOT_FOUND`), each with alt text of 1–300 characters; the first is the cover.
- `links`: at most 10, labels 1–80 characters, URLs with the `help_contacts.contact_url` rule.
- `people`: at most 20 distinct existing `help_contacts` (`NEWS_PERSON_NOT_FOUND`), in tag order.
- `published_at` is set on first publication and kept, so republishing keeps the original date. `edit_revision` starts at 1 and increases on each save.

### `events`

`id uuid, slug text, title text, description text, location text?, starts_at timestamp, ends_at timestamp?, article_id uuid?, images, links, people, is_published boolean, edit_revision int, created_at timestamp, updated_at timestamp`

Calendar events, optionally belonging to one article. `description`: at most 5000 characters, line breaks and tabs only; `location`: 1–160 trimmed. `starts_at` and `ends_at` arrive as ISO instants with an explicit offset and are stored in UTC; `ends_at` is optional, after `starts_at` and at most 62 days later, so a month view stays readable.

### `categories`

`id uuid, name text`

Name 1–100 characters trimmed and unique (`INVALID_CATEGORY`, `CATEGORY_NAME_TAKEN`), checked by `products.rename` and when `products.save` creates a standard category.

### `cabinets`

`id uuid, code text, outer_row int?, outer_col int?, inner_rows int, inner_cols int, label text?, is_archived boolean`

One cabinet at an open-ended position on the single shelf wall. `inner_rows`/`inner_cols` give that cabinet's own drawer grid; cabinets may differ.

Coordinates, on the wall and inside a cabinet, viewed from the front: row 1 is the bottom and rows increase upward; column 1 is the left. Columns display as A, B, …, Z, AA, … followed by the row, so `A1` is bottom-left at both levels. A new cabinet row above `A1–F2` becomes `A3–F3`; growing `inner_rows` adds positions on top. Existing coordinates never shift.

The physical wall from `Bok.xlsx` (installed by `seed.base` in development and test, imported in production): 12 cabinets in two rows of six, 496 unit cells, 492 drawers. A1, B1, C1, D1, B2, D2, E2 and F2 are 12 rows × 4 columns; A2, E1 and F1 are 8 × 3; C2 is 10 × 4 with a full-width drawer at A1–D1 and a two-column drawer at C2–D2. `tests/convex/shelf-and-help.test.ts` checks it (12 cabinets, 492 drawers).

Checks in `convex/shelf.ts`: code 1–64 characters trimmed and unique, never changed; positions and grid sizes are positive integers, at most 4096 cells per cabinet; two live cabinets never share a position (`CABINET_POSITION_OCCUPIED`). An archived cabinet has null `outer_row`/`outer_col`; a live one has both.

### `bins`

`id uuid, code text, cabinet_id uuid?, inner_row int?, inner_col int?, row_span int, col_span int, label text?, is_archived boolean`

One drawer or bulk position. `(inner_row, inner_col)` is the bottom-left unit cell; `row_span` extends upward and `col_span` rightward, so a 2×2 drawer at C3 covers C3–D4. Uncovered cells are vacant positions; moves do not refill them.

Checks in `convex/shelf.ts`: code 1–64 characters trimmed and unique, never changed; coordinates and spans are positive integers; a live drawer lies inside its live cabinet's grid and overlaps no other live drawer. An archived bin has null `cabinet_id`, `inner_row` and `inner_col` and no assigned products; a live one has all three.

### `products`

`id uuid, code text, name_nb text, name_en text, description text?, category_id uuid?, bin_id uuid?, location_note text?, unit_code text, stock_step decimal, sale_step decimal, sale_unit_price_nok decimal?, minimum_stock decimal, datasheet_url text?, purchase_url text?, is_active boolean, metadata_revision int, created_at timestamp, updated_at timestamp`

Stable identity and current master data. No stock or latest-purchase fields (§2). Checks in `convex/products.ts` (`INVALID_PRODUCT` with the field):

- `code` matches `^[A-Z0-9][A-Z0-9-]{0,39}$` and is unique (`PRODUCT_CODE_TAKEN`); `code`, `unit_code` and `stock_step` never change.
- `name_nb`, `name_en`: 1–200 characters trimmed. `location_note`: 1–200 trimmed, and only without a bin.
- `unit_code` names an existing unit; `category_id` an existing category; `bin_id` a live bin (`PRODUCT_BIN_UNAVAILABLE`).
- `stock_step` and `sale_step` positive, `minimum_stock` at least 0, all `checkedQuantity`; `sale_step` and `minimum_stock` are multiples of `stock_step`; a discrete unit needs whole steps (`DISCRETE_UNIT_REQUIRES_WHOLE_QUANTITIES`).
- `sale_unit_price_nok` null or `checkedUnitPrice`. `datasheet_url`, `purchase_url` null or `http(s)://` (`INVALID_URL`).
- `metadata_revision` starts at 1 and increases with each edit.

Field meanings:

- `sale_unit_price_nok`: null makes the product **borrow-only** (a breadboard the workshop lends, never sells). It is public with its stock and drawer, but checkout rejects it (`PRODUCT_NOT_FOR_SALE`), so only staff counts, receipts, withdrawals and adjustments change its stock. `sale_step` is kept but unused.
- `minimum_stock`: staff-only restock level. An active product with positive stock below it needs attention; `0` means only sold out does. Never public.
- `location_note`: public finding hint for a product with no drawer, shown instead of coordinates. Without a note, the buyer asks staff.
- `purchase_url`: staff-only standing reorder link, so opening stock needs no invented orders. Order lines keep their own URL, and latest purchase still derives from history.

### `attribute_definitions`

`id uuid, code text, label text, value_type 'number' | 'text' | 'boolean', canonical_unit text?`

Meaning, type and canonical unit of one component property. Checks in `convex/products.ts`: `code` matches `^[a-z][a-z0-9_]{0,63}$` and is unique; `label` 1–100 characters trimmed; `canonical_unit` only for numbers (`INVALID_DEFINITION`). Code, type and unit never change; only the label can be edited.

### `product_attributes`

`product_id uuid, attribute_id uuid, number_value decimal?, text_value text?, boolean_value boolean?, number_max decimal?`

One typed value per product and attribute. A number may be a range (250–400 V): `number_value` is then the lower bound and `number_max` the upper one, strictly greater; `number_max` is null for a single value. Filters match a range they overlap, search reads both bounds and facets offer both. A dual rating such as 250 VAC and 400 VDC is two attributes (`voltage_ac`, `voltage`), not a range.

Checks in `convex/products.ts` (`INVALID_ATTRIBUTE`): exactly one of the three values, matching the definition's type (`ATTRIBUTE_VALUE_TYPE_MISMATCH`); numbers are plain decimal strings without exponent; `number_max` only with a number and greater than it; text at most 2000 characters; one row per product and attribute (`DUPLICATE_PRODUCT_SPECIFICATION` within one save). Values are the only rows that can be deleted, always through `deleteAudited`.

### `command_requests`

`id uuid, command_name text, actor_id uuid?, request_digest text, result any?, created_at timestamp`

Private retry record, completed in the command's transaction (`convex/lib/commands.ts`). `id` is the client's request ID; `request_digest` is the SHA-256 (hex) of the canonical JSON input. Raw inputs and secrets are not kept. `actor_id` is null for guest checkout.

### `purchase_orders`

`id uuid, request_id uuid, supplier_name text, supplier_reference text?, placed_at timestamp, additional_cost_nok decimal, note text?, created_by uuid, recorded_at timestamp`

Header of an already-placed order; `request_id` is the recording command's request ID. Checks in `convex/orders.ts`: `supplier_name` 1–200 characters trimmed (`SUPPLIER_NAME_REQUIRED`); `supplier_reference` and `note` at most 2000 (`TEXT_TOO_LONG`); `additional_cost_nok` is `checkedNokAmount`; `placed_at` at most one day after recording (`ORDER_PLACED_IN_FUTURE`).

### `purchase_order_lines`

`id uuid, order_id uuid, line_number int, product_id uuid, ordered_quantity decimal, unit_cost_nok decimal, purchase_url text?, supplier_sku text?`

One line of a placed order, numbered from 1. The same product may appear on several lines. Checks in `convex/orders.ts`: `ordered_quantity` positive and a stock-step multiple; `unit_cost_nok` is `checkedUnitPrice`; `purchase_url` null or `http(s)://`; an empty URL or SKU is stored as null. Only cost, URL and SKU can be corrected.

### `purchase_order_cancellations`

`id uuid, request_id uuid, order_line_id uuid, quantity decimal, reverses_id uuid?, reason text, created_by uuid, recorded_at timestamp`

Append-only cancellations and their reversals, inserted by `convex/orders.ts`. A cancellation is positive, a stock-step multiple and at most the line's outstanding quantity (`INVALID_CANCELLATION_QUANTITY`); one per line per request. A reversal repeats the quantity with `reverses_id` set; a cancellation is reversed at most once and a reversal never (`CANCELLATION_ALREADY_REVERSED`, `CANNOT_REVERSE_A_REVERSAL`). `reason` is non-blank, at most 2000 characters.

### `checkouts`

`id uuid, request_id uuid, token_digest text, created_at timestamp`

Immutable checkout identity, inserted by `checkout.prepare`. No expiry or paid field. `token_digest` is the SHA-256 (hex) of the 64-hex token and is never returned.

### `checkout_lines`

`checkout_id uuid, product_id uuid, product_name_nb_snapshot text, product_name_en_snapshot text, quantity decimal, unit_price_nok decimal`

Frozen names, quantities and prices, one line per product (`DUPLICATE_OR_MISSING_CART_PRODUCT`). Checks in `convex/checkout.ts`: the product is active with a price; `quantity` positive and a sale-step multiple (`POSITIVE_CART_QUANTITY_REQUIRED`).

### `checkout_contacts`

`checkout_id uuid, contact_text text`

Optional unverified contact, trimmed, 1–300 characters (`CONTACT_TOO_LONG`). Removed by `checkout.clearContact` or the retention job (`convex/retention.ts`), each audited as `CONTACT_CLEARED` without the text.

### `count_batches`

`id uuid, request_id uuid, owner_id uuid, title text, started_at timestamp, finished_at timestamp?, finished_by uuid?, finish_reason text?, product_id uuid?`

Groups count observations under one owner. A product may be counted repeatedly; observations are never overwritten. A single-product count (`stock.recordSingleCount`) is its own batch, born finished, with `product_id` set and the product code as its title; the staff pages word it in the reader's language. Grouped stock counts leave `product_id` null.

Checks in `convex/stock.ts`: `title` 1–200 characters trimmed (`COUNT_TITLE_REQUIRED`); `finished_at` and `finished_by` are set together; `finish_reason` (trimmed, 1–2000, `CLOSURE_REASON_REQUIRED`) only when another member closes an abandoned batch.

### `inventory_events`

`id uuid, request_id uuid?, kind 'receipt' | 'sale' | 'count' | 'adjustment' | 'withdrawal', actor_id uuid?, purchase_order_id uuid?, note text?, occurred_at timestamp, recorded_at timestamp`

Header for one atomic stock operation. A matching count has no movement. Checks in `convex/lib/inventory.ts`: a sale has no actor and every other kind has one (`INVALID_EVENT_ACTOR`); only receipts link an order (`INVALID_EVENT_ORDER`); adjustments and withdrawals need a note (`REASON_REQUIRED`); a receipt needs an order or a note (`UNPLANNED_RECEIPT_REQUIRES_SOURCE_NOTE`); notes are at most 2000 characters (`NOTE_TOO_LONG`). `request_id` is null for sales.

### `inventory_movements`

`id int, event_id uuid, product_id uuid, quantity_delta decimal`

Signed stock changes; the only source of balances. `id` comes from the `inventory_movements` counter and is the stock revision. Checks in `convex/lib/inventory.ts`: `quantity_delta` non-zero (`ZERO_MOVEMENT`), at most 6 decimals and a stock-step multiple; receipts are positive and sales and withdrawals negative (`INVALID_MOVEMENT_SIGN`).

### `movement_corrections`

`movement_id int, corrects_movement_id int`

Links a later adjustment movement to the earlier movement of the same product it corrects. Links cannot point forwards (`INVALID_CORRECTION_REFERENCE`, `convex/lib/inventory.ts`); a command corrects each movement at most once (`DUPLICATE_CORRECTION_REFERENCE`).

### `receipt_allocations`

`movement_id int, order_line_id uuid`

Links a receipt movement, or an adjustment correcting one, to a purchase line of the same product (`INVALID_RECEIPT_ALLOCATION`, `convex/lib/inventory.ts`).

### `sales`

`checkout_id uuid, event_id uuid, recovered_by uuid?, recovery_reason text?`

One registration per checkout, by buyer or by staff recovery (with actor and reason). Not payment verification. Inserted once by `convex/checkout.ts`; a recovery reason is trimmed, 1–2000 characters (`RECOVERY_REASON_REQUIRED`), and set together with `recovered_by`.

### `stock_counts`

`event_id uuid, batch_id uuid, product_id uuid, expected_quantity decimal, counted_quantity decimal, expected_revision int`

Immutable count observation, inserted by `convex/stock.ts`. Expected may be negative; counted may not (`NEGATIVE_PHYSICAL_COUNT`) and is a stock-step multiple. `expected_quantity` and `expected_revision` are read from `stock_levels` in the same transaction.

### `audit_log`

`id int, table_name text, row_key any, action 'INSERT' | 'UPDATE' | 'DELETE' | 'CONTACT_CLEARED', before_data any?, after_data any?, actor_id uuid?, database_role text, recorded_at timestamp, row_id text?`

Immutable metadata history, written by `convex/lib/audit.ts`. Checkout contact values are never included. `id` comes from the `audit_log` counter. `row_key` is `{id}`, or `{code}` for units and `{product_id, attribute_id}` for specification values; `row_id` copies `row_key.id` so one row's history is one index range. `database_role` is `authenticated` (staff), `convex` (system, such as retention and seeds) or `service_role` (imported history).

### `stock_levels`

`product_id uuid, quantity decimal, revision int, last_counted_at timestamp?`

Rebuildable projection of the ledger (§2, §11), one row per product that has moved or been counted, written only by `convex/lib/inventory.ts` in the same transaction as each movement or count.

### `counters`

`name text, value int`

Gap-free sequences `inventory_movements` and `audit_log` (`convex/lib/sequence.ts`). The import continues them after the imported IDs (`migration.setSequences`).

### `password_tokens`

`user_id Id<'users'>, token_digest text, purpose 'invite' | 'reset', expires_at int, used_at int?`

Single-use invitation and reset links (`convex/passwords.ts`); only the SHA-256 of the token is stored. Times are milliseconds since the epoch. A new link sets `used_at` on the user's earlier unused links.

### `rate_limits`

`key text, window_start int, count int`

Fixed one-minute windows for invitation and reset email (`convex/lib/rateLimit.ts`).

### Convex Auth tables

`authTables` from `@convex-dev/auth`: `users`, `authAccounts`, `authSessions`, `authRefreshTokens`, `authVerificationCodes`, `authVerifiers` and `authRateLimits` (failed sign-in attempts). `users` adds `auth_user_id`, the stable UUID that `staff_members.auth_user_id` refers to. `authAccounts` holds the bcrypt password hash under provider `password`, keyed by the lower-case email. Only Convex Auth, `members.grantAccess`, `passwords.complete`, the seeds and the import write them.
