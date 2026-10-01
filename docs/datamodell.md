# Ampoteket database design

The database contract: model, invariants, precision, concurrency, permissions and RPCs. The migrations in `supabase/migrations/` are the final word on names, types, constraints and function bodies: where any document disagrees with them, the migration wins and the document has a bug. Appendix A is checked against the applied schema by `scripts/check-schema-docs.py`.

## 1. Domain decisions

- A product is a set of interchangeable components, not a supplier item. Staff curate product identity; equal names or values are not a safe uniqueness rule. Supplier SKU and purchase URL belong to the purchase line.
- A product has at most one current bin; a bin can hold many products. A bin is a drawer inside a cabinet; a cabinet stands at one position on the wall. A product without a bin can still be sold and may carry a public `location_note`.
- One operational staff role, individual Supabase Auth identities. Customers have no account and may give one optional, unverified contact string.
- There are no payment-verification, reconciliation, refund or return entities: payment is trust-based ([website-guide.md](website-guide.md#4-guest-checkout)).
- Prices and costs are historical NOK. A purchase unit cost uses the product's sale unit. Order-level extra costs are stored separately, never folded into unit cost.
- Purchase orders record orders already placed elsewhere; they reserve nothing and add no stock. Receipts can be partial or unplanned (donations are unplanned receipts). Outstanding quantity can be cancelled with a reason. A surplus delivery is a normal adjustment with a note.
- Negative recorded stock is allowed.
- Counts are open, not blind. Each count posts immediately; closing a batch posts nothing.

## 2. Sources of truth

- Product, bin and cabinet position are separate, so moving a bin updates one row.
- An ordered amount is not evidence of stock; only receipts add stock.
- A movement's quantity is stored once. Receipt allocations and correction links point at the movement.
- Checkout names and prices, and count expected/observed quantities, are historical facts, not caches of current values.
- Customer contact data is separate from immutable history.

Stock, latest purchase price/URL, last count, outstanding quantity, order status and checkout totals are never stored; views derive them. If summing movements ever proves too slow, add a rebuildable projection in a migration, not a second source of truth.

JSON is used only for RPC request envelopes, idempotency results and audit images.

## 3. Relations at a glance

| Area | Tables |
| --- | --- |
| Catalogue | `units`, `categories`, `cabinets`, `bins`, `products` |
| Component specifications | `attribute_definitions`, `product_attributes` |
| Public support | `help_contacts` |
| Staff | `staff_members` |
| Purchasing | `purchase_orders`, `purchase_order_lines`, `purchase_order_cancellations` |
| Checkout | `checkouts`, `checkout_lines`, `checkout_contacts`, `sales` |
| Counting | `count_batches`, `stock_counts` |
| Inventory | `inventory_events`, `inventory_movements`, `receipt_allocations`, `movement_corrections` |
| Infrastructure | `command_requests`, `audit_log` |

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
```

## 4. Units, quantities and rounding

`products.unit_code` (`pcs` or `m`) is both the stock and the sale unit. There is no pack conversion: a pack of 100 resistors is 100 pieces.

Each product has a `stock_step` and a `sale_step` (for example cable stocked to 0.001 m, sold per 0.1 m). `sale_step` must be a whole multiple of `stock_step`; the database checks precision and step.

Quantities and money are exact `numeric`, never float. The domains reject excess precision instead of rounding it:

| Domain | Used for | Rule |
| --- | --- | --- |
| `quantity`, `unit_price` | Command quantities and unit prices | At most 6 decimals, magnitude at most 999999999999. |
| `stock_quantity` | Balances and count values | At most 6 decimals, finite, no magnitude bound. |
| `nok_amount` | Extra costs | At most 2 decimals, same magnitude bound. |

Product code, unit and stock step are immutable; a change needs a migration or a new product. Name, price and sale step can change with audit; existing checkouts keep what they accepted.

```text
line total = round(quantity × saved unit price, 2)
checkout total = sum(line totals)
```

Round each line once (ties away from zero), then add. A checkout has one line per product. Unit prices may be below one øre.

The database computes every amount. Clients carry quantities, money, bigint IDs and revisions as strings ([api-contract.md](api-contract.md#exact-json-values)).

## 5. Stock, revisions and immutable history

```sql
quantity = coalesce(sum(inventory_movements.quantity_delta), 0)
revision = coalesce(max(inventory_movements.id), 0)
```

The revision is an opaque per-product concurrency token. Every movement changes it, so a withdrawal plus a compensating receipt still invalidates an earlier count.

A new product has zero **recorded** stock, which says nothing about the physical bin. Load opening stock through counts or documented adjustments.

`recorded_at` is set by the database. Backdating `occurred_at` does not reorder history or the revision.

| Kind | Delta | Meaning |
| --- | --- | --- |
| `receipt` | Positive | Goods actually added. Order link optional. |
| `sale` | Negative | Buyer registered or staff recovered the original frozen checkout; no payment verification. |
| `count` | Positive or negative; no movement for zero difference | Reconcile to a physical observation. |
| `withdrawal` | Negative | Staff use, giveaway or disposal, with required reason. |
| `adjustment` | Non-zero signed amount | Reasoned correction or exceptional adjustment. |

Posted events, movements, links, allocations, counts, checkout snapshots, sales and cancellations reject `UPDATE`, `DELETE` and `TRUNCATE`, and API roles cannot write them directly. A correction is a new movement linked to the one it corrects. Correcting a receipt from 60 to 10 posts -50 allocated to the same order line, so order progress updates too. Unlinked adjustments never touch order progress.

This stops application and accidental SQL changes, not a database owner, who can drop triggers. Restrict migration access and keep backups.

## 6. Orders and latest purchase

```text
received = sum(signed movement quantities allocated to the order line)
cancelled = sum(cancellations) - sum(cancellation reversals)
outstanding = max(ordered - received - cancelled, 0)
```

- Receipts and cancellations are aggregated separately before joining, to avoid row multiplication.
- Cancelling never reduces stock or changes `ordered_quantity`. A cancellation can be reversed once, with a reason.
- Order status is derived, never edited. "Receive everything" sends the remaining quantities, not the ordered ones.
- `placed_at` may be at most one day after recording (`ORDER_PLACED_IN_FUTURE`; constraint `placed_at_not_in_future` on edits). A mistyped year would otherwise pin the wrong latest price.
- Price, URL, supplier reference and extra cost can be corrected as audited metadata; ordered quantities and product links cannot.

Latest purchase is one line per product: newest `placed_at`, then recorded time, order ID and line number. A line counts if it has a positive cost and some quantity received or still expected. Donations never count. Price and URL come from the **same** line; if it has no URL, the result is null.

## 7. Checkout and customer data

The guest protocol and retries are owned by [checkout-recovery.md](checkout-recovery.md). Database rules:

- Proceeding to payment freezes one line per product, priced from the database under product locks. Show the returned snapshot before sending the buyer to Vipps.
- A checkout reserves no stock and never expires. Checkouts and retry records are kept forever. A `sales` row means registered (by staff when `recovered_by` and `recovery_reason` are set). No row means **unconfirmed**, not "unpaid".
- Confirmation writes all movements and the sale in one transaction and returns the existing result on repeat. It does not re-read prices, reject deactivated products, require stock or verify payment. A zero-total checkout registers without a payment claim.
- Payment is outside the transaction. Never tell a buyer to pay again because registration failed.
- Customers cannot revise a registered purchase; staff use linked corrections. The staff checkout view shows the prepare `request_id`, so staff can find an attempt whose response was lost.
- The database stores only the SHA-256 of the Worker's 64-hex-character checkout secret. Reading or confirming needs ID and secret. Guest RPCs are executable only by `service_role`. Keep secrets out of URLs and logs.
- The contact string is optional, unverified and not authentication. Contacts on unconfirmed checkouts are cleared after 90 days; others can be erased on request. It never enters audit snapshots, command logs, notes or application logs. See [operating-procedures.md](operating-procedures.md).

## 8. Atomic operations and concurrency

- Each stock-changing action is one RPC and one transaction; an error rolls everything back. Separate REST calls do not share a transaction.
- Inventory writers lock affected product rows `FOR NO KEY UPDATE` in sorted UUID order and read balances only after locking. Order operations lock the order first (several orders in sorted order), so receipts, cancellations and receipt corrections cannot race over outstanding amounts.
- Stock RPCs, staff-access changes and direct bin/cabinet placement writes require `READ COMMITTED` (else `READ_COMMITTED_REQUIRED`): they must see rows committed while they waited. No transaction stays open while a person counts or pays.

```text
idempotency request, where applicable
    -> order / checkout / count-batch header, where applicable
    -> affected products sorted by UUID
    -> movements and related records
```

- A count submits the revision it read. If stock has moved since, it raises `STALE_STOCK_COUNT`; the UI asks for a fresh count and never swaps in the new revision. Unregistered physical movements are invisible to this check, so pause the bin and settle pending registrations first ([operating-procedures.md](operating-procedures.md)).
- `command_requests` stores actor, input digest and result. Concurrent duplicates wait and get the same result. Reusing a key with other input or another actor fails.
- Confirmation, finishing a batch and clearing a contact are repeat-safe by object identity. Other RPCs: reuse the same `p_request_id` on retry. Product edits filter by `metadata_revision` (separate from the stock revision) and require exactly one updated row.

Staff-access changes take a `SHARE ROW EXCLUSIVE` lock on `staff_members` before the idempotency request and recheck the actor after waiting. This serializes invitations, reactivation and deactivation, including maintainer helpers; a deactivated actor cannot finish a waiting access change. No self-deactivation is allowed, so mutually revoking staff cannot remove every active account. Ordinary operations keep the lock order above.

The two-connection cases are in [concurrency-tests.md](concurrency-tests.md).

## 9. API and Supabase permissions

Keep `app` out of the Data API's exposed schemas; `public` holds only the explicit `amp_*` views and RPCs. The migration enables RLS itself.

| Caller | Permitted access |
| --- | --- |
| Public `anon` | `amp_catalog(...)`, `amp_catalog_facets(...)`, `amp_shelf_map()` and `amp_help_directory(...)` only. |
| Logged-in non-staff | Catalogue/facets, shelf map and published help directory; no staff rows or staff operations. |
| Active staff JWT | Staff read views, controlled master-data edits, membership management and authorised operational RPCs. |
| Worker `service_role` | Catalogue/facets, shelf map, published help directory and the three guest checkout RPCs; no blanket app-table grants. |
| Database maintainer | Migrations, first-staff bootstrap and emergency access recovery. Treat as privileged access outside ordinary operations. |

- Staff views are `security_invoker=true`. Public reads are narrow `SECURITY DEFINER` functions.
- Every grant is explicit, including for `service_role`; bypassing RLS does not grant object privileges.
- Privileged functions have an empty `search_path` and schema-qualified names. Every function has explicit revoke/grant statements, because default privileges cannot remove `PUBLIC` execute. `supabase/tests/permissions.sql` rejects unreviewed grants; update its allowlist when adding an API.
- The staff actor comes from `auth.uid()` via `staff_members`, never from the client. Staff RPCs use the staff member's own JWT, never the service key.
- Grants do not replace the Worker's request-size limits, rate limiting, origin/CSRF checks and credential storage.
- Runtime: PostgreSQL 17, UTF-8, bundled `und-x-icu` collation for Unicode search.

### Public volunteer directory

`help_contacts` is deliberately public and grants no access. Never put buyer contact data in it. Publishing requires at least one valid Discord username, email, phone or HTTPS URL (DNS hostname; no credentials, whitespace, control characters or backslashes). Render fields as text and validate links in the frontend too. `amp_help_directory` exposes only published rows. Staff edit through `amp_help_contacts` with an `edit_revision` guard ([protocol](api-contract.md#public-volunteer-directory)). Entries are unpublished, never deleted, and every change is audited.

### Staff provisioning

Active staff invite, reactivate and deactivate other members from the Admins page. The Worker validates the staff JWT, creates a missing Auth account, grants membership with that same JWT, then sends the invitation. Existing Auth accounts can be linked deliberately by email; invited users follow the email link to set their password. SMTP and the first account remain deployment tasks ([runbook-deploy.md](runbook-deploy.md)).

- `amp_list_staff()` returns the complete membership directory as a JSON array: `id`, `auth_user_id`, `display_name`, `email`, `is_active`, `email_confirmed`. Only active staff may call it. Deleted Auth accounts have null identity/email and `email_confirmed=false`.
- `amp_grant_staff_access(p_request_id,p_email,p_display_name,p_expected_staff_id DEFAULT NULL,p_expected_active DEFAULT NULL)` requires exactly one existing Auth account for the case-insensitive email, creates or reactivates its membership, and returns the staff UUID. An already-active membership is a no-op and keeps its current name. Reactivation preserves the ID and applies the supplied name. Resend/reactivation from an existing row supplies its staff ID; if the email now belongs to another identity, it raises `INVITATION_SUPERSEDED` before membership writes. An existing row also supplies its expected active state: true for resend, false for explicit reactivation; a mismatch raises `INVITATION_SUPERSEDED`, so a stale resend cannot undo revocation. A null expected ID is a deliberate email-based invitation. Retry keys bind the normalized email/name, expected staff ID/state and acting staff member.
- `amp_deactivate_staff(p_request_id,p_staff_id)` returns the staff UUID and sets `is_active=false`. Repeated deactivation is a no-op. The caller cannot deactivate themselves (`STAFF_SELF_DEACTIVATION`); an unknown ID raises `STAFF_NOT_FOUND`. Access changes recheck the actor under the shared lock described in §8.
- Both writes use `command_requests`, preserve historical foreign keys and audit the acting staff member. Neither anonymous users nor the Worker service key can execute these RPCs. A deleted Auth account nulls `auth_user_id`; recreating that email creates a new identity and never relinks old history automatically.

For the first member or emergency recovery, create the Auth user and run as a database maintainer:

```sql
SELECT app.grant_staff_access('person@example.no', 'Staff display name');
SELECT app.revoke_staff_access('person@example.no');
```

These helpers remain unavailable to API roles. Granting reactivates a revoked membership; an active membership raises `STAFF_ALREADY_ACTIVE`. Privileged revocation can remove the final member, so use it only with a deliberate recovery plan. Never delete staff rows.

## 10. RPC contracts

All RPCs are in `public`; helpers in `app` are not client APIs. Signatures are in the migrations.

| Function | Caller | Result |
| --- | --- | --- |
| `amp_catalog`, `amp_catalog_facets` | Public | Product pages and filter choices ([details](api-contract.md#catalog-and-topology)). |
| `amp_shelf_map` | Public | Complete live cabinets and bins with `has_products`. |
| `amp_help_directory` | Public | Published support contacts. |
| `amp_admin_statistics` | Staff | Sales summary and overview ([response](api-contract.md#staff-statistics)). |
| `amp_list_staff` | Staff | Complete membership directory and Auth invitation state. |
| `amp_grant_staff_access`, `amp_deactivate_staff` | Staff | Add/reactivate or deactivate another member; returns their staff UUID. |
| `amp_prepare_checkout`, `amp_get_checkout`, `amp_confirm_checkout` | Worker | Freeze, read and register a checkout. |
| `amp_recover_checkout` | Staff | Register the original checkout with a reason; converges with guest retries. |
| `amp_record_order` | Staff | Record an already-placed order. |
| `amp_record_receipt` | Staff | Receive goods, with or without an order. |
| `amp_cancel_order_quantities`, `amp_reverse_cancellation` | Staff | Cancel outstanding quantity; reverse one cancellation. |
| `amp_adjust_stock`, `amp_withdraw_stock` | Staff | Signed adjustments; non-sale withdrawals. |
| `amp_start_count_batch`, `amp_record_count`, `amp_finish_count_batch` | Owner | Batch counting. |
| `amp_record_single_count` | Staff | One count in its own finished batch. |
| `amp_correct_movement_and_count` | Staff | Linked correction plus fresh count, atomically. |
| `amp_close_abandoned_count_batch` | Staff | Close a batch whose owner is gone. |
| `amp_save_shelf_layout`, `amp_archive_empty_cabinet` | Staff | Save or retire a whole cabinet. |
| `amp_swap_bins`, `amp_swap_cabinets` | Staff | Exchange two occupied positions. |
| `amp_clear_checkout_contact` | Staff | Remove the optional contact. |

### JSON items

```json
{"product_id":"<uuid>","quantity":"0.5"}
{"product_id":"<uuid>","quantity":"100","unit_cost_nok":"0.20","purchase_url":"https://example.invalid/item","supplier_sku":"SUPPLIER-123"}
{"product_id":"<uuid>","order_line_id":"<uuid>","quantity":"60"}
{"order_line_id":"<uuid>","quantity":"40"}
{"product_id":"<uuid>","quantity_delta":"-90","corrects_movement_id":"123","expected_revision":"456"}
```

In order: cart line, order line, receipt line, cancellation, adjustment. A withdrawal is `{"product_id":"<uuid>","quantity":"3"}` with a positive quantity.

- One receipt call covers one order or none. An unplanned receipt needs a note.
- A linked correction needs the `expected_revision` read with the history (`STALE_STOCK_CORRECTION` if stale). If any count followed the target movement, it fails with `CORRECTION_REQUIRES_RECOUNT`; use `amp_correct_movement_and_count`.

### Shelf layouts and storage

Coordinates and spans are described under `cabinets` and `bins` in Appendix A.

- `amp_save_shelf_layout` takes the exact original cabinet and live drawers (null/empty for a new cabinet) plus the desired ones. Objects have exactly the table's columns; unexpected keys, coerced types, overlaps or duplicates raise `INVALID_SHELF_LAYOUT`. Any intervening change raises `STALE_SHELF_LAYOUT`: refresh and review, never resubmit with a new snapshot automatically.
- The client assigns drawer UUIDs and codes once and keeps them across retries. Retained drawers keep their identity; omitted drawers are archived.
- An assigned drawer (inactive products count) can only grow at its anchor over whole unassigned neighbours. Removing, shrinking or moving it raises `LAYOUT_HAS_PRODUCTS`.
- Move a bin or cabinet into free cells by updating `amp_bins`/`amp_cabinets` filtered by ID and the displayed position, and require one updated row. Swap two occupied positions with `amp_swap_bins` (positions and spans) or `amp_swap_cabinets`; stale forms raise `STALE_BIN_POSITION`/`STALE_CABINET_POSITION`. Moves leave vacant cells.
- Retire storage with `is_archived=true`. A bin must have no assigned products; a cabinet no live bins. Archiving frees the position; the audit keeps it. `amp_archive_empty_cabinet` retires a cabinet and all its empty drawers at once (`BIN_STILL_HAS_PRODUCTS` if any is assigned). `amp_archived_bin_locations` shows where archived drawers used to be.

### Count batches

Only the owner can post to or finish a batch. If the owner is disabled or loses their Auth account, another staff member can call `amp_close_abandoned_count_batch` with a reason; this keeps `owner_id`, records who closed it and posts no stock. An active owner cannot be bypassed.

### Metadata edits

The views `amp_help_contacts`, `amp_products`, `amp_bins`, `amp_cabinets`, `amp_categories`, `amp_attribute_definitions` and `amp_product_attributes` allow controlled CRUD, audited by triggers. Column grants block product code and unit changes. Use explicit inserts and updates, not an upsert of every returned column. Purchase corrections are limited to supplier, reference, placement, extra cost, note, line cost, URL and SKU.

## 11. Read models

`app.inventory` (quantity, revision, last count), `app.purchase_line_progress`, `app.latest_purchase` and `app.checkout_totals` derive the stored-nowhere values from §2. Staff see matching `public.amp_*` views. Token digests and command requests are never exposed. The public catalogue never shows the ledger or incoming orders.

Never add quantities across units. Staff statistics are defined in [api-contract.md](api-contract.md#staff-statistics). Add indexes or caching only after measuring query plans.

## 12. Testing

`./scripts/test-database.sh` runs every database check, including `scripts/check-schema-docs.py` for Appendix A; see [README.md](../README.md) and [VALIDATION.md](../VALIDATION.md). SQL cannot prove the real REST boundary; see [concurrency-tests.md](concurrency-tests.md) §7.

## Appendix A. Complete table definitions

Current table contracts; update them with any forward migration. Quantities and prices are in the product's unit; money is NOK. Foreign keys use the default `NO ACTION` unless stated.

### `units`

Changed only through migrations.

```sql
CREATE TABLE app.units (
  code text PRIMARY KEY,
  name text NOT NULL,
  symbol text NOT NULL,
  is_discrete boolean NOT NULL,
  CHECK (code ~ '^[a-z][a-z0-9_]{0,23}$')
);
```

### `staff_members`

Internal staff IDs survive Auth-account removal. Active staff manage access through audited RPCs; maintainers bootstrap or recover access (§9).

```sql
CREATE TABLE app.staff_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
```

### `help_contacts`

Public volunteer directory (§9). Unpublish to remove an entry.

```sql
-- Public support contacts are independent of staff access and Auth identities.
-- These are intentionally publishable directory details, not buyer contact data.
CREATE TABLE app.help_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL CHECK (length(btrim(display_name)) >= 1 AND length(btrim(display_name)) <= 120
    AND display_name !~ '[[:cntrl:]]'),
  email text CHECK (email IS NULL OR (length(email) <= 254
    AND email ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$')),
  phone text CHECK (phone IS NULL OR (length(phone) >= 3 AND length(phone) <= 40
    AND phone ~ '^\+?[0-9][0-9 ()-]*[0-9]$'
    AND length(regexp_replace(phone,'[^0-9]','','g')) >= 3)),
  contact_url text CHECK (contact_url IS NULL OR (length(contact_url) <= 500
    AND contact_url ~ '^https://([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}(:[0-9]{1,5})?([/?#][^[:space:]\\]*)?$'
    AND contact_url !~ '[[:cntrl:]]'
    AND coalesce(substring(contact_url FROM '^https://[^/:?#]+:([0-9]+)')::integer,443) <= 65535)),
  display_order integer NOT NULL DEFAULT 0 CHECK (display_order >= 0),
  is_published boolean NOT NULL DEFAULT false,
  edit_revision bigint NOT NULL DEFAULT 1 CHECK (edit_revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  responsibility text CHECK (responsibility IS NULL OR (length(btrim(responsibility)) BETWEEN 1 AND 80
    AND responsibility !~ '[[:cntrl:]]')),
  -- Current Discord usernames: 2–32 of a-z, 0-9, '_' and '.', never two periods in a row.
  discord text CHECK (discord IS NULL OR (discord ~ '^[a-z0-9_.]{2,32}$' AND discord !~ '\.\.')),
  CHECK (NOT is_published OR num_nonnulls(email,phone,contact_url,discord) > 0)
);
```

### `categories`

```sql
CREATE TABLE app.categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (length(btrim(name)) BETWEEN 1 AND 100)
);
```

### `cabinets`

One cabinet at an open-ended position on the single shelf wall. `inner_rows`/`inner_cols` give that cabinet's own drawer grid; cabinets may differ.

Coordinates, on the wall and inside a cabinet, viewed from the front: row 1 is the bottom and rows increase upward; column 1 is the left. Columns display as A, B, …, Z, AA, … followed by the row, so `A1` is bottom-left at both levels. A new cabinet row above `A1–F2` becomes `A3–F3`; growing `inner_rows` adds positions on top. Existing coordinates never shift.

The initial migration installs the physical wall from `Bok.xlsx`: 12 cabinets in two rows of six, 496 unit cells, 492 drawers. A1, B1, C1, D1, B2, D2, E2 and F2 are 12 rows × 4 columns; A2, E1 and F1 are 8 × 3; C2 is 10 × 4 with a full-width drawer at A1–D1 and a two-column drawer at C2–D2. It creates no staff, products, stock or audit rows. `supabase/tests/initial-layout.sql` checks it.

```sql
CREATE TABLE app.cabinets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  outer_row integer CHECK (outer_row > 0),
  outer_col integer CHECK (outer_col > 0),
  inner_rows integer NOT NULL CHECK (inner_rows > 0),
  inner_cols integer NOT NULL CHECK (inner_cols > 0),
  label text,
  is_archived boolean NOT NULL DEFAULT false,
  CHECK ((is_archived AND outer_row IS NULL AND outer_col IS NULL)
      OR (NOT is_archived AND outer_row IS NOT NULL AND outer_col IS NOT NULL)),
  CONSTRAINT cabinets_position_key UNIQUE (outer_row, outer_col) DEFERRABLE INITIALLY IMMEDIATE,
  CHECK (length(btrim(code)) BETWEEN 1 AND 64)
);
```

### `bins`

One drawer or bulk position. `(inner_row, inner_col)` is the bottom-left unit cell; `row_span` extends upward and `col_span` rightward, so a 2×2 drawer at C3 covers C3–D4. Uncovered cells are vacant positions (`app.cabinet_free_cells`); moves do not refill them. The public map's `has_products` is true if any product, active or not, is assigned.

```sql
CREATE TABLE app.bins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (length(btrim(code)) BETWEEN 1 AND 64),
  cabinet_id uuid REFERENCES app.cabinets(id),
  inner_row integer CHECK (inner_row > 0),
  inner_col integer CHECK (inner_col > 0),
  row_span integer NOT NULL DEFAULT 1 CHECK (row_span > 0),
  col_span integer NOT NULL DEFAULT 1 CHECK (col_span > 0),
  label text,
  is_archived boolean NOT NULL DEFAULT false,
  CHECK ((is_archived AND cabinet_id IS NULL AND inner_row IS NULL AND inner_col IS NULL)
      OR (NOT is_archived AND cabinet_id IS NOT NULL AND inner_row IS NOT NULL AND inner_col IS NOT NULL))
);
```

### `products`

Stable identity and current master data. No stock or latest-purchase counters (§2).

```sql
CREATE TABLE app.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{0,39}$'),
  name_nb text NOT NULL CHECK (length(btrim(name_nb)) BETWEEN 1 AND 200),
  name_en text NOT NULL CHECK (length(btrim(name_en)) BETWEEN 1 AND 200),
  description text,
  category_id uuid REFERENCES app.categories(id),
  bin_id uuid REFERENCES app.bins(id),
  location_note text CHECK (location_note IS NULL OR length(btrim(location_note)) BETWEEN 1 AND 200),
  unit_code text NOT NULL REFERENCES app.units(code),
  stock_step app.quantity NOT NULL CHECK (stock_step > 0),
  sale_step app.quantity NOT NULL CHECK (sale_step > 0),
  sale_unit_price_nok app.unit_price NOT NULL,
  minimum_stock app.quantity NOT NULL DEFAULT 0 CHECK (minimum_stock >= 0),
  datasheet_url text CHECK (datasheet_url IS NULL OR datasheet_url ~ '^https?://'),
  purchase_url text CHECK (purchase_url IS NULL OR purchase_url ~ '^https?://'),
  is_active boolean NOT NULL DEFAULT false,
  metadata_revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (mod(sale_step, stock_step) = 0),
  CHECK (mod(minimum_stock, stock_step) = 0),
  CHECK (bin_id IS NULL OR location_note IS NULL)
);
```

- `minimum_stock`: staff-only restock level. An active product with positive stock below it needs attention; `0` means only sold out does. Never public.
- `location_note`: public finding hint for a product with no drawer, shown instead of coordinates. Without a note, the buyer asks staff.
- `purchase_url`: staff-only standing reorder link, so opening stock needs no invented orders. Order lines keep their own URL, and `latest_purchase` still derives from history.

### `attribute_definitions`

Meaning, type and canonical unit of one component property.

```sql
CREATE TABLE app.attribute_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]{0,63}$'),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 100),
  value_type text NOT NULL CHECK (value_type IN ('number','text','boolean')),
  canonical_unit text,
  CHECK (canonical_unit IS NULL OR value_type = 'number')
);
```

### `product_attributes`

One typed value per product and attribute.

```sql
CREATE TABLE app.product_attributes (
  product_id uuid NOT NULL REFERENCES app.products(id),
  attribute_id uuid NOT NULL REFERENCES app.attribute_definitions(id),
  number_value numeric,
  text_value text,
  boolean_value boolean,
  PRIMARY KEY (product_id, attribute_id),
  CHECK (num_nonnulls(number_value, text_value, boolean_value) = 1),
  CHECK (number_value IS NULL OR
    (number_value > '-Infinity'::numeric AND number_value < 'Infinity'::numeric)),
  CHECK (text_value IS NULL OR length(text_value) <= 2000)
);
```

### `command_requests`

Private retry record, completed in the operation's transaction. Raw inputs and secrets are not kept.

```sql
CREATE TABLE app.command_requests (
  id uuid PRIMARY KEY,
  command_name text NOT NULL,
  actor_id uuid REFERENCES app.staff_members(id),
  request_digest bytea NOT NULL CHECK (octet_length(request_digest) = 32),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
```

### `purchase_orders`

Header of an already-placed order.

```sql
CREATE TABLE app.purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE REFERENCES app.command_requests(id),
  supplier_name text NOT NULL CHECK (length(btrim(supplier_name)) BETWEEN 1 AND 200),
  supplier_reference text,
  placed_at timestamptz NOT NULL,
  additional_cost_nok app.nok_amount NOT NULL DEFAULT 0,
  note text,
  created_by uuid NOT NULL REFERENCES app.staff_members(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Orders record what was already placed; a far-future placement time is a typo.
  CONSTRAINT placed_at_not_in_future CHECK (placed_at <= recorded_at + interval '1 day')
);
```

### `purchase_order_lines`

One line of a placed order. The same product may appear on several lines.

```sql
CREATE TABLE app.purchase_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES app.purchase_orders(id),
  line_number integer NOT NULL CHECK (line_number > 0),
  product_id uuid NOT NULL REFERENCES app.products(id),
  ordered_quantity app.quantity NOT NULL CHECK (ordered_quantity > 0),
  unit_cost_nok app.unit_price NOT NULL,
  purchase_url text CHECK (purchase_url IS NULL OR purchase_url ~ '^https?://'),
  supplier_sku text,
  UNIQUE (order_id, line_number)
);
```

### `purchase_order_cancellations`

Append-only cancellations and their reversals.

```sql
CREATE TABLE app.purchase_order_cancellations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES app.command_requests(id),
  order_line_id uuid NOT NULL REFERENCES app.purchase_order_lines(id),
  quantity app.quantity NOT NULL CHECK (quantity > 0),
  -- A mistaken cancellation can be neutralised once, without deleting it.
  reverses_id uuid UNIQUE REFERENCES app.purchase_order_cancellations(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  created_by uuid NOT NULL REFERENCES app.staff_members(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (request_id, order_line_id)
);
```

### `checkouts`

Immutable checkout identity. No expiry or paid field. The digest is never exposed.

```sql
CREATE TABLE app.checkouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE REFERENCES app.command_requests(id),
  token_digest bytea NOT NULL CHECK (octet_length(token_digest) = 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
```

### `checkout_lines`

Frozen names, quantities and prices, one line per product.

```sql
CREATE TABLE app.checkout_lines (
  checkout_id uuid NOT NULL REFERENCES app.checkouts(id),
  product_id uuid NOT NULL REFERENCES app.products(id),
  product_name_nb_snapshot text NOT NULL,
  product_name_en_snapshot text NOT NULL,
  quantity app.quantity NOT NULL CHECK (quantity > 0),
  unit_price_nok app.unit_price NOT NULL,
  PRIMARY KEY (checkout_id, product_id)
);
```

### `checkout_contacts`

Optional unverified contact, removable through `amp_clear_checkout_contact`.

```sql
CREATE TABLE app.checkout_contacts (
  checkout_id uuid PRIMARY KEY REFERENCES app.checkouts(id),
  contact_text text NOT NULL CHECK (length(btrim(contact_text)) BETWEEN 1 AND 300)
);
```

### `count_batches`

Groups count observations under one owner. A product may be counted repeatedly; observations are never overwritten.

```sql
CREATE TABLE app.count_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE REFERENCES app.command_requests(id),
  owner_id uuid NOT NULL REFERENCES app.staff_members(id),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  finished_by uuid REFERENCES app.staff_members(id),
  finish_reason text CHECK (finish_reason IS NULL OR length(btrim(finish_reason)) BETWEEN 1 AND 2000),
  CHECK (finished_at IS NULL OR finished_at >= started_at),
  CHECK ((finished_at IS NULL) = (finished_by IS NULL)),
  CHECK (finish_reason IS NULL OR finished_at IS NOT NULL)
);
```

### `inventory_events`

Header for one atomic stock operation. A matching count has no movement.

```sql
CREATE TABLE app.inventory_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid UNIQUE REFERENCES app.command_requests(id),
  kind text NOT NULL CHECK (kind IN ('receipt','sale','count','adjustment','withdrawal')),
  actor_id uuid REFERENCES app.staff_members(id),
  purchase_order_id uuid REFERENCES app.purchase_orders(id),
  note text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((kind = 'sale' AND actor_id IS NULL) OR (kind <> 'sale' AND actor_id IS NOT NULL)),
  CHECK (kind = 'receipt' OR purchase_order_id IS NULL),
  CHECK (kind NOT IN ('adjustment','withdrawal') OR (note IS NOT NULL AND length(btrim(note)) > 0)),
  CHECK (kind <> 'receipt' OR purchase_order_id IS NOT NULL OR (note IS NOT NULL AND length(btrim(note)) > 0)),
  CHECK (note IS NULL OR length(note) <= 2000)
);
```

### `inventory_movements`

Signed stock changes; the only source of balances.

```sql
CREATE TABLE app.inventory_movements (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES app.inventory_events(id),
  product_id uuid NOT NULL REFERENCES app.products(id),
  quantity_delta app.stock_quantity NOT NULL CHECK (quantity_delta <> 0)
);
```

### `movement_corrections`

Links a later movement to the earlier one it corrects. Links cannot point forwards.

```sql
CREATE TABLE app.movement_corrections (
  movement_id bigint PRIMARY KEY REFERENCES app.inventory_movements(id),
  corrects_movement_id bigint NOT NULL REFERENCES app.inventory_movements(id),
  CHECK (movement_id > corrects_movement_id)
);
```

### `receipt_allocations`

Links a movement to a purchase line.

```sql
CREATE TABLE app.receipt_allocations (
  movement_id bigint PRIMARY KEY REFERENCES app.inventory_movements(id),
  order_line_id uuid NOT NULL REFERENCES app.purchase_order_lines(id)
);
```

### `sales`

One registration per checkout, by buyer or by staff recovery (with actor and reason). Not payment verification.

```sql
CREATE TABLE app.sales (
  checkout_id uuid PRIMARY KEY REFERENCES app.checkouts(id),
  event_id uuid NOT NULL UNIQUE REFERENCES app.inventory_events(id),
  recovered_by uuid REFERENCES app.staff_members(id),
  recovery_reason text,
  CHECK ((recovered_by IS NULL AND recovery_reason IS NULL)
      OR (recovered_by IS NOT NULL AND length(btrim(recovery_reason)) BETWEEN 1 AND 2000
          AND recovery_reason IS NOT NULL))
);
```

### `stock_counts`

Immutable count observation. Expected may be negative; counted may not.

```sql
CREATE TABLE app.stock_counts (
  event_id uuid PRIMARY KEY REFERENCES app.inventory_events(id),
  batch_id uuid NOT NULL REFERENCES app.count_batches(id),
  product_id uuid NOT NULL REFERENCES app.products(id),
  expected_quantity app.stock_quantity NOT NULL,
  counted_quantity app.stock_quantity NOT NULL CHECK (counted_quantity >= 0),
  expected_revision bigint NOT NULL CHECK (expected_revision >= 0)
);
```

### `audit_log`

Immutable metadata history. Checkout contact values are never included.

```sql
CREATE TABLE app.audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name text NOT NULL,
  row_key jsonb NOT NULL,
  action text NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE','CONTACT_CLEARED')),
  before_data jsonb,
  after_data jsonb,
  actor_id uuid REFERENCES app.staff_members(id),
  database_role text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
```
