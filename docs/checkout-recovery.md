# Checkout credentials, retries and assisted recovery

The contract for the browser/Worker guest checkout. The flow itself is in
[website-guide.md](website-guide.md) §4. A saved checkout is unconfirmed or
registered, never proof of payment. Saved checkouts do not expire.

## Identifiers and credentials

- **Prepare request ID:** a random UUIDv4 the browser creates before prepare. It
  names one immutable attempt and all its retries.
- **Checkout ID:** returned by the database. Buyer confirmation and staff recovery
  share it, so either path can register the checkout only once.
- **Checkout secret:** derived in the Worker and sent only to the database. IDs and
  contact text never replace it.

The Worker keeps a random 32-byte session root in the cookie `__Host-amp_checkout`
(`Secure; HttpOnly; SameSite=Lax; Path=/`, no `Domain`, `Max-Age=31536000`). Renew
it with the **same value**, never rotate it. Losing it is credential loss, not
checkout expiry. Staff logout must not remove it. Only the explicit
session-initialization POST creates it; it returns a public fingerprint.

`src/lib/server/checkout-credentials.ts` implements the derivation:

```text
session fingerprint = hex(SHA-256(UTF8("ampoteket:checkout-session:v1:") || root bytes))
checkout secret = hex(HMAC-SHA-256(root bytes, UTF8("ampoteket:checkout-token:v1:" + request UUID)))
```

Both are lowercase hex; the request UUID is canonical lowercase UUIDv4. The secret
never appears in responses, browser storage, URLs, analytics or logs. There is no
global pepper or server-side session store. **Keep the `v1` derivation for existing
attempts**; changing it makes their saved digests unreachable.

Every prepare/read/confirm/receipt request sends its saved request ID and fingerprint, and
the Worker checks them against the cookie before calling an RPC. The fingerprint is
a binding value, not authentication. `CHECKOUT_SESSION_MISSING`,
`CHECKOUT_SESSION_CHANGED`, `INVALID_CHECKOUT_SESSION` and `INVALID_CHECKOUT_ATTEMPT`
are visible errors; they must never trigger a new prepare with new credentials.

## Browser persistence

| What | Where |
|---|---|
| Basket lines | localStorage `ampoteket:cart` (`src/lib/cart.ts`) |
| Cross-tab lock | Web Lock `ampoteket:cart-and-checkout:v1` |
| Active attempt pointer | IndexedDB `ampoteket:checkout` v1, store `attempts`, key `active` |
| Attempt records (non-sensitive) | same store, `attempt:<request UUID>` and `checkout:<checkout UUID>` (`src/lib/checkout.ts`) |
| Exact prepare body | initiating tab's sessionStorage, `ampoteket:prepare:<request UUID>` |

- Every basket mutation and attempt transition re-reads lines and pointer under the
  Web Lock. Any active attempt, including registered-but-not-cleaned-up, locks edits.
- Claim the active attempt in **one IndexedDB read-write transaction**
  (localStorage read-then-write is not atomic), never held across a network
  request. Updates and clearing compare the request ID inside the transaction, so
  a late response cannot clear a newer attempt.
- Freeze the exact prepare payload (decimal strings, item order, contact) once;
  retries re-read and resend exactly it. Contact text never goes to IndexedDB,
  localStorage, notes or logs; attempt records hold no contact or snapshot.
- Other tabs see the attempt but not the payload. They resume, wait or use
  recovery; they never mint a second request ID.

| Durable state | Allowed next action |
| --- | --- |
| No active attempt | Read the cookie fingerprint, freeze the payload, atomically claim one request ID. |
| Preparing; no checkout ID | Retry the same prepare ID, fingerprint, payload and derived secret. A timeout leaves this ambiguous. |
| Prepared; checkout ID saved | Read the original snapshot through the Worker. Never prepare again to retrieve it. |
| Snapshot read and ID persistence verified | Show saved names, quantities and prices. Offer Vipps only if `payment_required`; otherwise offer registration. |
| Confirmation outcome unknown | Read or confirm the original checkout again with the same credentials. Never advise another payment. |
| Registered | Show registration, clear the active pointer and transient payload. A late response must match its request ID before touching the UI. |
| Credential/payload missing or changed | Stop automatic retries and offer the support reference and staff recovery. |

Before offering Vipps or zero-total registration, persist and read back the
checkout ID, then read the snapshot with `amp_get_checkout`; a prepare response
alone is not enough. Then clear the frozen payload. If browser storage fails, do
not start payment; there is no volatile-only fallback.

A new attempt needs an explicit new-purchase action. Set an unconfirmed checkout
aside only once nothing was paid or collected; uncertain attempts go to recovery.
A failed request never creates a fresh cart automatically.

## Worker rules

- Reject bodies that supply a guest token. Derive it from the cookie and request ID
  and send it only to `amp_prepare_checkout`, `amp_get_checkout` or
  `amp_confirm_checkout`. A mismatched checkout ID simply fails token validation.
- Never treat a client-supplied price, total, state or fingerprint as a database
  fact. Parse API responses through `requestApiJson`.
- All checkout responses send `Cache-Control: no-store` and bypass CDN and
  service-worker caches.
- Accept same-origin JSON POST only. Check `Origin` against the configured origin,
  reject cross-origin requests and restrict CORS. `Sec-Fetch-Site` is an extra
  check, not the only CSRF control. The Host header never defines the trusted origin.
- Validate body size, item count and string formats before database calls, and
  rate-limit both initialization and checkout operations (limits in
  [website-guide.md](website-guide.md) §1.1).
- Never log Cookie headers, derived tokens, contact-bearing bodies or raw checkout
  responses.

## Failures and races

| Situation | Required behavior |
| --- | --- |
| Prepare response lost (committed or not) | Retry the saved payload and request ID. The same cookie derives the same secret, so the database returns the original checkout or creates it now. |
| Worker restart or deploy | Nothing to recover; derivation needs only cookie, version and request ID. |
| Payload lost before acknowledgement (browser restart, new tab) | Never rebuild a possibly different payload. Keep the request ID and use staff lookup; a checkout may already exist. |
| Two tabs initialize cookies at once | One root may replace the other. Fingerprint checks reject the stranded attempt; payment is only offered after a successful snapshot read, and the saved checkout ID still allows staff recovery. |
| Cookie blocked, removed, expired or malformed | Fail visibly. Never create a new root on the attempt route or send a new secret for the same request ID. |
| Another device, or all browser storage gone | No guest recovery by contact or checkout ID. Staff identify the original checkout; if ambiguous, stop and investigate, never create a replacement withdrawal. |

No browser protocol survives cleared site data, device loss or cookie eviction, so
staff recovery is part of the normal design. The database never treats a missing
credential as payment failure.

## Staff recovery uses the original checkout

The support reference is the checkout ID when known and always the prepare request
ID; neither is a secret. Active staff can look up `amp_checkouts` by `request_id`,
even when the prepare response was lost. The projection excludes the token digest.

The buyer screenshots or notes amount, items and references, and goes to `/contact`.
Never invent a total when the snapshot is unavailable. Amounts, screenshots and
contact text help identification but prove neither ownership nor payment.

Staff check the original items, prices and sale status, then call
`amp_recover_checkout` for the **original checkout ID** with a command UUID (reused
on retry) and a required reason. It shares the sale identity with buyer
confirmation, so nothing is withdrawn twice. It is registration help, not payment
verification. If a count may already include the goods, follow
[website-guide.md](website-guide.md) §5.6.

## Launch checks

Fault injection must cover every row above plus dropped confirm responses, tab
reload, denied IndexedDB/sessionStorage and returning from Vipps. Assert: no
payment action before snapshot/ID verification, stable request IDs and payloads,
visible credential failures, one withdrawal, and no secrets or contact in
responses, caches or logs. Status: [VALIDATION.md](../VALIDATION.md).

Run them on a trusted HTTPS origin set as the exact allowed origin; plain HTTP does
not exercise the `__Host-`/`Secure` cookie. Never drop `Secure`, change the prefix
or loosen origin checks to make a development test pass.
