# Ampoteket showcase, 2026-10-01

Meeting prep for the Ampoteket workshop. Not a project document; delete or keep as you like.

## Before you leave

1. Restart your dev session with sample data (the running one has an empty database):
   `Ctrl-C`, then `bun run development -- --workshop`. That gives 174 sample products
   in the real shelf layout and a year of fictional sales, so statistics have content.
2. Use `https://dev.ampoteket.no` (tailnet) on both phone and laptop. Checkout only
   works over HTTPS: on `http://localhost:5174` "Gå til kassen" fails with
   `CHECKOUT_UNAVAILABLE`. Browsing and admin work on localhost.
3. Sign in on the laptop at `/admin/login` as `test@test.no` / `test`.
4. Print: the buyer poster (`assets/poster/kjopsplakat-a4.pdf`, 100 %) and one A4
   label sheet from `/admin/products/labels` (select one cabinet, Generate). Scanning
   a real printed label with your phone is the best moment of the demo.
5. Backup screenshots are in `showcase/screenshots/` if wifi or Docker misbehaves.

## The pitch (30 seconds)

The shelf has 12 cabinets and 492 drawers. Today nobody knows what is in stock or
what has been paid for. Ampoteket is a self-service shop on the buyer's own phone:
scan the drawer, pay with Vipps, press "Jeg har betalt", and stock goes down by
itself. Volunteers get a stock system with orders, counts and a full history, so
they know when to reorder. No accounts for buyers, no app to install.

## Demo, buyer (phone, about 5 minutes)

1. `/`: the hero, then scroll to "Delehylla" for the three steps (the same steps as the poster).
2. `/p`: open "Filtre", tick "Kondensator", "Vis resultater". Then search "motstand".
3. Open `RES-00005` (1 kΩ motstand, 0,50 kr), quantity 10, "Legg i handlekurven".
   Or scan its printed label with "Skann".
4. Add `CAP-00069` (100 nF kondensator) × 2 and `LED-000A7` (Rød LED) × 5.
5. `/cart`: three parts, 14,50 kr. "Gå til kassen".
6. Checkout: scroll past the parts to the amount and Vippsnummer 47322. Don't actually pay;
   press "Jeg har betalt, registrer kjøpet". It says the purchase is registered and that payment is not checked.
7. Switch to `/en` to show English.

Points to make while clicking:

- No account and no app. Norwegian at `/`, English at `/en`, follows the phone's dark/light mode.
- The QR on a drawer only contains `ampoteket.no/p/CODE`, so labels never go stale when prices change.
- The checkout freezes the price. If the network drops after paying, the buyer
  continues the same purchase and is never asked to pay twice.
- Payment is trust-based: the site never claims the payment was verified. That keeps it
  honest and needs no Vipps business integration.
- Scanning never buys anything by itself.

## Demo, volunteers (laptop, about 5 minutes)

1. `/admin`: overview. `/admin/statistics`: a year of sample sales.
2. `/admin/stock`, pick `RES-00005`: "Lagerhistorikk" shows the purchase you just made, "Registrert kjøp −10 stk".
3. `/admin/products`, open a product: the editor (prices, drawer, specifications, label print).
4. `/admin/shelf`: the shelf wall with 12 cabinets.
5. `/admin/products/labels`: tick "Velg kabinett A1", "Lag etiketter": 48 labels on 3 A4 sheets.
6. `/admin/orders`: orders and partial receipts. `/admin/audit`: who did what. `/admin/admins`: invitations.

Points to make:

- Every volunteer has their own login, invited from `/admin/admins`. Who did what is in the audit log.
- Stock changes are never edited, only corrected with a new entry and a reason. The history is permanent.
- Orders record what was bought elsewhere; receipts add stock, also partial deliveries.
- Counting one drawer at a time: the system refuses a count if stock changed while you counted.
- Labels: pick cabinets on the shelf map, print A4 sheets, or single labels on the P-touch printer.

## What is done

- Full buyer flow, staff stock system, labels, statistics, admin invitations, receipts by email, bilingual UI.
- Automated tests: 223 unit tests, the full database suite (permissions, concurrency,
  backup/restore) and real-browser tests for shop, checkout, admin, scanner and labels,
  all passing on 2026-09-30 (`VALIDATION.md`).
- Built so next year's students can run it without me: documented in `docs/`, starting at `docs/prosjektoversikt.md`.

## What is left before launch, and what I need from you

| Item | Needs |
|---|---|
| Go-live decision | Your yes to deploy to `ampoteket.no` (Cloudflare + Supabase, `docs/runbook-deploy.md`) |
| Opening stock | Volunteers to count the drawers into the system, one at a time, with a second person spot-checking |
| Labels on the drawers | Measure label areas, print a test sheet, check scanning in the workshop light |
| Real phones | Test camera scanning and the Vipps app switch on a few iPhones and Androids |
| Volunteer contacts | Names and contact methods for the contact page (`/contact`), agreed with each person |
| Owners | Who owns the accounts (GitHub, Supabase, Cloudflare, domain), staff onboarding, backups and incidents |
| Backups | Agree how much data loss and downtime is acceptable (proposal: 24 hours each, daily off-site backup, a restore drill each semester) |
| Vipps | Confirm number 47322 is the right recipient |
| Domain | `ampoteket.no` is registered to a private owner; decide whether it moves to the workshop |

## Likely questions

- *What if people don't pay?* Same as today: trust. The difference is that sales are
  registered, so stock is right and volunteers can compare registered sales with Vipps.
- *What does it cost?* Hosting is Cloudflare Workers plus Supabase. The plan is not chosen yet;
  it depends on the backup decision below, since Supabase backups depend on the plan
  (`docs/runbook-backup-restore.md`). Check current prices before promising a number.
- *What if you leave?* Everything is documented, tested automatically on every change, and admins manage each other in the site.
- *Refunds, reservations, accounts?* Deliberately out of v1 (`docs/prosjektoversikt.md` §9).
