# Current validation

What has been executed, and what must still happen before launch. All runs used
local, disposable services; no hosted project or deployment has been changed.
Past runs live in git history, not here. Replace a row when you rerun it; do not
append a diary.

## Current checks

Last full runs: database chain 2026-09-25; `shop`, `checkout`, `admin`, `statistics`,
`scanner` and `labels` 2026-09-25; `shelf` and `orders` earlier, not rerun since.

| Check | Result |
| --- | --- |
| `bun run check`, `bun run check:scripts`, `bun run lint` | PASS, 0 errors/warnings |
| `bun test` | PASS, 216 tests |
| `./scripts/test-database.sh` | PASS: rollback/retry, ACLs/RLS, acceptance, filters, statistics, malformed input, concurrency, restore, schema/docs comparison, signed-JWT HTTP |
| `./scripts/test-web.sh` | PASS: real local Auth, public/staff/Worker boundaries, exact decimal transport |
| `./scripts/test-web.sh --shop` | PASS |
| `./scripts/test-web.sh --checkout` | PASS, including Auth invitation/recovery emails in Mailpit |
| `./scripts/test-web.sh --admin` | PASS, including `dragOneColumnWider` and focus on an invalid specification after one Save click |
| `./scripts/test-web.sh --statistics` | PASS |
| `./scripts/test-web.sh --scanner` | PASS (Firefox and WebKit, synthetic camera) |
| `./scripts/test-web.sh --labels` | PASS: decoded PDF QR payloads, geometry |
| `./scripts/test-web.sh --shelf` | PASS |
| `./scripts/test-web.sh --orders` | PASS |

CI runs the database chain and the `boundary`, `shop`, `checkout`, `admin`,
`scanner`, `labels` and `statistics` browser modes. These results are local runs,
not CI claims.

## Migrations and schema surface

Update this section whenever a migration changes (`sha256sum supabase/migrations/*`).

- `20260917000100_ampoteket_initial.sql` — SHA-256
  `0eda5217b038887d44b1960983f7df650f6ba44458bb1f05f5f5808b5e99c69b`
- `20260924000100_archive_empty_cabinet.sql` — SHA-256
  `503d75885d3774a967f4cad7a3b891b94b4f62020a393d5620220a997be6b7d6`

24 app tables, four exact numeric domains, 26 public RPCs, 29 staff views and five
internal derived views. All views are security invoker; only `public` is exposed.
Initial data: 12 cabinets, 492 drawers and reference units; no products or stock.

A 5,002-product / 250,000-movement workload checks that catalog reads touch only
the selected products. It is a regression check, not a hosted latency guarantee.

## Still required before launch

- **Stock withdrawals/corrections and audit pages:** run with real staff and
  non-staff JWTs on the disposable full stack, at 360 and 1280 px, including
  uncertain writes and a recount after an intervening count.
- **Phones:** camera scanning, keyboard/safe areas and the Vipps app switch on
  real devices ([checklist](docs/scanner.md)). Only the owner's iPhone has been
  used; Android and older devices are untested. System-camera handling of
  scheme-less `ampoteket.no/p/...` QR text is unverified. Homepage photographs
  have not been checked on physical phones.
- **Labels:** measure printed A4 labels on real drawers. For the P-touch printer,
  a WebUSB print from the admin editor and scanning the printed tape QR with a
  phone are unverified.
- **Hosted setup** (needs the explicit deploy decision): Supabase/Cloudflare
  configuration, Auth mail delivery (custom SMTP), the Data API cutover barrier
  and a full hosted restore drill ([deploy](docs/runbook-deploy.md),
  [backup](docs/runbook-backup-restore.md)).
- **Owners and targets:** name operators and accept RPO/RTO, backup storage and
  drill schedule. The backup runbook proposes 24 hours each, daily off-platform
  backups and a drill each semester; none of this is accepted yet.
