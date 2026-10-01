# API values and complete reads

How clients read and write database values without losing precision or silently truncating lists. SQL stays authoritative for quantities, money, checkout totals and revisions; tables, RPCs and permissions are in [datamodell.md](datamodell.md).

## Exact JSON values

- Decode every database and Worker JSON response with `requestApiJson` from `src/lib/api.ts`. It parses the raw text with `lossless-json`, so **every numeric token becomes a string** before JavaScript can round it, including nested audit images and attributes. Never use `Response.json()`, `JSON.parse` or an SDK's parsed result.
- Quantities, money, bigint IDs and revisions stay strings in client state and in requests (including RPC item arrays). Values such as `999999999998.999999` and `9007199254740993` must survive an unedited round trip. No decimal library is needed; the database computes amounts.
- Structural integers (coordinates, line numbers) also arrive as strings. Convert them only after checking format, `Number.isSafeInteger` and range; never convert quantities or money.
- The helper returns `unknown`. Each screen validates the shape and shows an unavailable state on invalid data. It throws on HTTP errors rather than returning an empty result.
- Deadline: 15 seconds for headers and body, 25 seconds for checkout, 60 seconds for admin invitations. A timeout means the write is uncertain, never that it rolled back.
- Requests use `redirect: 'manual'` and redirect responses are rejected, so keys, JWTs and checkout bodies never reach a redirect target. (Workers do not support `redirect: 'error'`.)
- The helper never logs URLs, tokens, contact text or bodies. Do not log `body` without removing personal data and credentials.
- `amp_catalog` and guest RPCs return decimals as SQL text; staff views return native numbers, which the parser keeps exact. When updating `lossless-json`, run `bun test src/lib/api.test.ts` and `bun run check`.

## Catalog and topology

`src/lib/catalog.ts` wraps `amp_catalog`: lookups, single pages and complete traversal. Transport, shape and cursor errors stay errors, distinct from an empty result.

- Results are active products in code order. `p_limit` is 1–200 (default 200). Code or QR lookup uses `p_code`.
- To page, send each page's last `code` as `p_after_code` and stop only at an **empty** page; a short page may be an API row cap. Reject repeated codes and non-advancing cursors. The visible count describes only rendered rows.
- `readCompleteCatalog` is for operations that need every matching row. A failed complete read never publishes a partial result.
- `p_cabinet_ids` and `p_bin_ids` select any listed location, intersected with the other filters before paging; both empty means everywhere. Null arrays or members, duplicates, more than 100 cabinets or 4,096 drawers, and unknown or archived IDs raise `INVALID_CATALOG_FILTER`, even when nothing else matches. Drawer selection follows the stable drawer identity across moves.
- SQL validates every condition (unknown categories or attributes, bad numeric bounds) before matching. `p_labels` comes from `catalogSearchLabels`, so bilingual and SI search matches what is displayed. Code search also matches codes without hyphens (`res00026` finds `RES-00026`).
- `amp_catalog_facets` returns all category names and typed values for the selected categories as one JSON object, never truncated by a row cap.
- The catalog is live; pages are not a point-in-time export. A lost saved cursor gives a return-to-start error.

`amp_shelf_map()` returns one JSON object with complete, ordered `cabinets` and `bins` arrays, including empty storage and excluding archived storage. Being one value, it cannot be truncated by the row cap. Each bin has `has_products`, true if any product (even inactive or zero stock) is assigned. Use that flag to show unassigned drawers; never infer emptiness from missing catalog rows or a failed read. `src/lib/shelf-map.ts` validates duplicates, parents, grid fit and overlaps. Only selecting an assigned drawer triggers a drawer-scoped catalog read. The map exposes placement only, never stock, costs, staff or contacts.

## Public volunteer directory

`amp_help_directory(p_after_order, p_after_id, p_limit)` returns published contacts ordered by `(display_order, id)` with exactly `id`, `display_name`, `responsibility`, `email`, `phone`, `contact_url`, `discord` and `display_order`. `p_limit` is 1–1000 (default 100; otherwise `INVALID_HELP_PAGE_SIZE`). Send both cursor fields or neither (`INVALID_HELP_CURSOR`). Page until empty, reject duplicate IDs and non-advancing tuples, and keep "unavailable" distinct from "empty".

Staff edit through `amp_help_contacts` with their own JWT:

- Insert with a fresh client UUID, so a lost response can be reconciled.
- PATCH filters `id=eq.<id>` and `edit_revision=eq.<original>`, sends the same original `edit_revision` in the body, and uses `Prefer: return=representation`. Only one returned row means saved. Zero rows or `STALE_HELP_CONTACT` means someone else edited: keep the draft, refresh and review, never overwrite.
- Send blank optional contact methods as `null`. Entries cannot be deleted; unpublish instead.

## Staff membership and invitations

All membership RPCs require the active staff member's own JWT. Anon and service
role have no execution grant; non-staff and inactive callers get `STAFF_REQUIRED`.
The actor comes from the JWT, never a submitted staff ID.

`amp_list_staff()` returns one JSON array, complete regardless of the API row cap:

```text
[{ id, auth_user_id: uuid | null, display_name, email: string | null,
   is_active: boolean, email_confirmed: boolean }]
```

The UI shows a deleted account when `auth_user_id` is null, inactive when
`is_active` is false, pending when the active account's email is unconfirmed, and
active otherwise. Email comes from Auth and is visible only to active staff.

- `amp_grant_staff_access(p_request_id uuid, p_email text, p_display_name text, p_expected_staff_id uuid = null, p_expected_active boolean = null)`
  returns the membership UUID, granting or reactivating access to an existing
  Auth account. The Worker creates an absent account first.
- `amp_deactivate_staff(p_request_id uuid, p_staff_id uuid)` returns the membership
  UUID and sets it inactive. `STAFF_SELF_DEACTIVATION` forbids deactivating the
  caller; `STAFF_NOT_FOUND` rejects an unknown target.
- Both writes use `command_requests` idempotency and audit the signed-in actor.
  Reuse the original actor, request ID and exact payload after an uncertain result.
  Membership writes serialize and recheck caller access, so mutual deactivation
  cannot disable both callers. A completed grant replay returns its result
  without undoing a later deactivation.

`POST /api/admin/invitations` requires `Authorization: Bearer <caller JWT>`, JSON,
the exact configured `CHECKOUT_ALLOWED_ORIGIN` and the `ADMIN_INVITATION_LIMIT`
binding. Request and success response:

```text
{ requestId: uuid, email: string, displayName: string, targetId: uuid | null, targetActive: boolean | null, locale: "nb" | "en" }
{ status: "invited" | "existing_account", staffId: uuid }
```

The Worker validates the request, limits its body and request rate, and verifies
active staff before using the secret key for Auth account creation/invitation.
The body is capped at 2,048 bytes. The native rate binding allows 10 requests per
minute for each IP and each authenticated actor. Upstream work has a shared
45-second deadline; the client allows 60 seconds for the complete request.
It grants membership with the caller's JWT. For resend/reactivation, `targetId`
binds the request to the listed membership and `targetActive` to its current
access state. The database rejects a changed/deleted identity or access state
before granting access, so stale resend actions cannot reactivate someone.
New invitations use null for both fields. New accounts remain unconfirmed until
the recipient follows the email link to set a password at the fixed localized
`/admin/password?next=%2Fadmin` URL. Existing confirmed accounts retain their
password and return `existing_account` without an invitation email.

Email delivery is separate from the database transaction. `INVITATION_EMAIL_FAILED`
means membership is saved but delivery failed; retry the same request to retry
delivery. Resending a pending invitation uses the same endpoint. A replay after
the membership was deactivated returns `INVITATION_SUPERSEDED` (409), preserving
that deactivation. An uncertain response never means access was rolled back.

## Staff statistics

`amp_admin_statistics(p_product_id uuid = null)` needs an active staff JWT (`staffRequest`). Non-staff and disabled staff get `STAFF_REQUIRED`; anon and service role have no grant. Staff access is checked before an unknown product raises `PRODUCT_NOT_FOUND`. The response is one JSON object from one statement snapshot:

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
- Without a product: quantities are null (units cannot be mixed), `products` is the top ten by NOK value (code breaks ties), and `overview` lists up to eight products needing attention (sold out first, negative before zero, then below `minimum_stock` by ascending `quantity / minimum_stock`) and up to five open count batches, oldest first. The two counts cover the full set, not just the listed rows.
- With a product: quantities are in its unit, `products` is empty and `overview` is null.
- A failed or invalid response is shown as unavailable, never as zero.

## Staff writes and complete reads

- Staff screens use `staffRequest` and `allStaffRows` from `admin-api.ts`: own JWT, 15-second deadline, returned representations. An aborted write is uncertain.
- Build scalar equality filters with `staffEquals` (`eq.<value>` or `is.null`). Do not quote the value; quotes change what is compared. Quoting inside `in` or logic expressions follows [different rules](https://github.com/PostgREST/postgrest/blob/v14.12/src/PostgREST/ApiRequest/QueryParams.hs#L639).
- Shelf layout and cabinet retirement: persist the exact command, generated UUIDs and codes, actor and request ID before sending, and retry with the same payload. The rules are in [datamodell.md](datamodell.md) §10.
- Label exports page `amp_product_attributes` by `(product_id, attribute_id)`. Any failed page blocks the file; never print a partial label set. See [page-labels.md](page-labels.md).

Every list has a deterministic order on a unique key (`id`, or a tuple like `(recorded_at, id)`; composite keys need every column in both order and cursor) and pages with keyset filters, never offsets. Page until empty. An unavailable page is never shown as the end. Compare IDs and quantities in SQL, not as JavaScript strings.

Operational scans (such as contact retention) record their cursor and counts, resume after failure and recheck eligibility before acting. An export that claims exact completeness needs one read-only `REPEATABLE READ` transaction or a backup; separate HTTP pages are not a snapshot. Write RPCs still require `READ COMMITTED`.

## Tests

- `src/lib/api.test.ts`: the parser and error boundary.
- `supabase/tests/numeric-read-models.sql`: JSON types, exact values, precision rejection, rounding, catalog pagination and shelf topology.
- `supabase/tests/admin-statistics.sql`: statistics dates, totals and ordering.
- `./scripts/test-api.sh`: real HTTP through isolated PostgreSQL and PostgREST containers with signed synthetic JWTs, a small row cap and the production parser. It does not exercise Supabase Auth login, refresh or deletion, or the deployed JWT configuration; see [concurrency-tests.md](concurrency-tests.md) §7.
