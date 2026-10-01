# Saved checkout

`/checkout` resumes the active preparing attempt; `/checkout/[id]` retrieves a saved
checkout. Implemented in `src/routes/[[locale=locale]]/checkout/` and
`src/lib/CheckoutPage.svelte`. [checkout-recovery.md](checkout-recovery.md) owns
persistence and retries; this page covers presentation and which actions are allowed.

## Data

- The ID in the path is not authorization. The page posts the stored request binding to
  `/api/checkouts/[id]`; only the Worker sends the guest secret. A missing binding or
  cookie shows assisted recovery, never a new purchase.
- The only payment basis is a validated saved snapshot, held in page memory. An invalid
  response is unavailable, never a free checkout. Never use current catalog prices.
- Responses are no-store and noindex with a restrictive referrer policy. References and
  contact never enter metadata, analytics or help URLs.

## Layout and payment

At 360 px: status, support reference, read-only saved lines and total, payment
instructions, registration action, retry/help. The reference (checkout ID, else the
request ID) stays readable when later requests fail.

When unregistered and `payment_required=true`: recipient **47322**, the exact saved NOK
amount, the [verified QR/link](../assets/payments/README.md) (freeform amount, typed by
the buyer) and an explicit "I have paid" action. Visiting Vipps changes nothing. Never
send a buyer to Vipps before the ID is saved and read back and a snapshot read has
succeeded. When `payment_required=false`, omit Vipps and offer direct registration.
Success means items are registered; the [payment rule](website-guide.md#4-guest-checkout) applies.

`payment_required` stays true after registration, so check registration and local
attempt state first: registered checkouts are read-only, and an attempted confirmation
never shows another payment action.

Reconcile the original saved checkout on tab return, reconnect and local attempt
changes. Keep its lines and references mounted while reading, and gate payment until
the read succeeds. Before opening Vipps, check the same checkout again; a registration
by another tab or a volunteer runs the normal completion and cleanup path.
Revalidation never creates a replacement checkout.

## States

| State | Actions and presentation |
|---|---|
| Recovering | Placeholders, known reference, no payment controls |
| Prepared, payment required | Snapshot, recipient/amount, Vipps, "I have paid" |
| Prepared, zero total | Snapshot and direct registration |
| Confirm in flight | Keep layout; announce pending; block new commands |
| Confirmation unknown | Read or retry the same confirmation; never pay again |
| Registered | Result, read-only lines, cart cleanup, optional receipt email, explicit new purchase |
| Missing/changed credentials | No cookie replacement; reference and `/help` |
| Different active attempt | Reading is safe; resolve the attempt before acting |
| Unavailable snapshot | Retry or help; never invent a total or advise re-payment |

Persist the move to confirmation before sending it; if that fails, do not send. A late
registration response applies only to its own attempt; retries reuse the same
credentials and request ID. Duplicate confirmations and staff recovery converge on one
sale; disabled buttons are not that guarantee. Staff logout keeps guest credentials.

## Receipt

A registered checkout opened with its saved binding shows an optional email field and
Send receipt. Success turns the button into a checked "Sent" with an `sr-only`
announcement; editing the address allows another send. A rejected address is a field
error, any other failure a retryable message. Nothing is stored in the browser or the
database. Transport and limits: [website-guide.md](website-guide.md) §4.2.

## Help

When registration stays unresolved, ask the buyer to note the amount, items and
reference and link `/help`. If the snapshot is unavailable, show the known IDs; a cart
total cannot rebuild it. Screenshots help identify but never authorize or prove
payment. If browser storage is gone, a volunteer must find the checkout; there is no
guessed match or upload. Saved checkouts never expire.

## Acceptance

`./scripts/test-web.sh --checkout`, plus Vipps app switching on real phones and
scanning the attached paper QR. Results and open checks:
[VALIDATION.md](../VALIDATION.md).
