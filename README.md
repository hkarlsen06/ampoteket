# Ampoteket

Website of Ampoteket, the student-run electronics workshop at `ampoteket.no`, with
a self-service parts shelf and stock system for its members. Buyers need no account: they browse stock, fill a cart, pay with
trust-based Vipps and register the purchase, which withdraws stock. Staff maintain
products, placement, purchasing and counts with a full audit trail.

SvelteKit 3 / Svelte 5 on Cloudflare Workers, Convex (data, functions and Auth),
Bun, shadcn-svelte and Tailwind CSS 4. Norwegian at `/`, English at `/en`.

**Status:** live at `ampoteket.no` on Convex since the 2026-10-17 cutover
([runbook-cutover.md](docs/runbook-cutover.md)). What is live right now is in
[AGENTS.md](AGENTS.md#current-state); [VALIDATION.md](VALIDATION.md) lists what has
been run and which launch checks are still open.

## Access for maintainers

A maintainer needs an account with access to each of these. At every handover,
add the new maintainers and check that at least two people can reach each one.

| Service | Used for | Where |
| --- | --- | --- |
| GitHub | Code, issues, CI and the deploy secrets (`production` environment) | [hkarlsen06/ampoteket](https://github.com/hkarlsen06/ampoteket), moving to an `ampoteket` organization |
| Convex | Backend: data, functions, Auth and backups | The `ampoteket` project, created at the cutover ([runbook-cutover.md §1](docs/runbook-cutover.md#1-before-the-window-owner-once)) |
| Supabase | Production database and Auth until the cutover, then kept paused as the rollback copy | [Project `mqzcbdorjuefefzvuefa`](https://supabase.com/dashboard/project/mqzcbdorjuefefzvuefa) |
| Resend | Invitation and password emails from `noreply@notify.ampoteket.no` (sent by Convex) and buyer receipts (sent by the Worker) | [resend.com](https://resend.com) |
| Cloudflare | The `ampoteket` Worker and DNS for `ampoteket.no` | A private account for now, moving to a shared team account |
| Domeneshop | Renewing `ampoteket.no`, which is registered to a private owner; changes go through them | [domene.shop](https://domene.shop) |

Staff access to the shop itself is separate: an active admin invites you at
`/admin/admins`.

Hjalmar Karlsen (`hkarlsen06`) is the primary service-access, backup and contact
retention operator. Independent backup access and recovery targets are still open
in the [backup runbook](docs/runbook-backup-restore.md#1-decisions-required-before-launch).

## Where to read

Start with the [project overview](docs/prosjektoversikt.md); it lists the document
for each area. The backend lives in `convex/`: `convex/schema.ts` defines the
tables, one file per area holds its functions, and `convex/lib/` holds the shared
rules (exact decimals, audit, ledger, access checks)
([datamodell.md](docs/datamodell.md)).

## Setup

Linux with **Bun 1.3.14**, Python 3, curl, jq and Git LFS.

```sh
git lfs pull                  # original photos and Blender files (only needed to rebuild them)
bun install --frozen-lockfile
CONVEX_AGENT_MODE=anonymous bunx convex dev --once   # once: caches the Convex local backend binary
bun run development           # disposable backend + test admin + dev server
```

The third line downloads the local backend binary into the Convex CLI cache
(`~/.cache/convex/binaries/`), using a throwaway anonymous local deployment; no
account or secret is needed. `bun run development` and the test scripts refuse to
start without it.

`bun run development` starts a fresh local Convex backend on port 54329, deploys
`convex/` to it and redeploys on every save, seeds the cabinet wall and a test
admin, and starts the dev server on port **5174**. Open <http://localhost:5174> and
sign in at `/admin/login` as **`admin@example.test`** with the password printed in
the terminal (new each run). Every start is empty, and Ctrl-C deletes it. It reads
no hosted deployment, `.env` or `.env.local`. Options (after `--`):

- `--workshop`: 174 sample products inspired by workshop photos, placed in the
  real shelf layout. Stock and placement are illustrative, not a real inventory.
- `--count 30`: the synthetic catalog used by the browser tests (30–10000
  products).

The browser reaches the backend through the dev server at `/convex`, so the same
run works from `https://dev.ampoteket.no` and from a phone that can open the dev
server. A port already in use is reported and left alone: it may be the owner's
or another session's server. Stop it yourself only if it is yours.

Port **5174** is used by both `bun run dev` and `bun run preview`; run one at a time.

### HTTPS (checkout and camera)

Checkout cookies and the camera need trusted HTTPS. `bun run development` sets
`CHECKOUT_ALLOWED_ORIGIN` to `https://dev.ampoteket.no`, the owner's tailnet proxy
in front of port 5174. Without it, use the local Caddy proxy:

```sh
caddy run --config Caddyfile.local --adapter caddyfile     # terminal 1
caddy trust --address 127.0.0.1:20199                      # once, while Caddy runs

CHECKOUT_ALLOWED_ORIGIN=https://localhost:8443 bun run development   # terminal 2
```

Open <https://localhost:8443>. Firefox may need
`.local-https/pki/authorities/local/root.crt` imported as a trusted authority.
Never commit `.local-https/`. If you get a 502, the dev server has not started
yet. Testing on a physical phone needs a trusted HTTPS origin the phone can reach,
such as a tunnel or a private network name with a real certificate; see
[scanner.md](docs/scanner.md#5-physical-acceptance-record).

## Commands

| Command | What it does |
| --- | --- |
| `bun run development` | Disposable local backend, seed data and dev server (above) |
| `bun run dev` / `bun run preview` | Vite dev server / production build in the Workers runtime, against the backend named by `PUBLIC_CONVEX_URL` (variables in `src/env.ts`) |
| `bun run check` / `bun run check:scripts` | Type-check the app / the scripts and browser proofs |
| `bun run lint` | Dash ban (`check:dashes`), oxlint + ESLint |
| `bun test` | Unit tests in `src/` and `scripts/`; the backend tests in `tests/convex/` skip without a backend |
| `./scripts/test-convex.sh` | Backend suite on a disposable Convex backend (below) |
| `./scripts/test-web.sh [--proof]` | Browser acceptance of the built shop on a disposable Convex backend (below) |
| `bun run check:ink` | Catch clipped SVG/CSS edges |
| `bun run i18n` | Side-by-side editor for the Norwegian and English strings, port 5175 ([i18n.md](docs/i18n.md)) |
| `bun run deploy:production` | The only production deploy ([below](#deploying)) |
| `bun scripts/verify-live.ts` | Read-only HTTP smoke check of `https://ampoteket.no` in both locales ([diagnosing production](docs/runbook-deploy.md#diagnosing-production)) |
| `bun scripts/build-poster.ts` | The A4 buyer poster for the shelf, `assets/poster/kjopsplakat-a4.pdf` (copy follows `src/lib/i18n`; print at 100 %), plus its picture for the showcase slide |
| `/slopo-review`, `/slopo-analyze-ignore`, `/slopo-analyze-one` | Claude Code skills that find non-exact duplicate code with [Slopo](https://slopo.dev) (`uv tool install slopo`, key in `.env` as `SLOPO_EMBEDDING_API_KEY`, config in `slopo.conf.yaml`) |

`scripts/convex-cutover/` holds the one-time Supabase export and import; use it
only as [runbook-cutover.md](docs/runbook-cutover.md) describes.

## Tests

`./scripts/test-convex.sh` needs no credentials. It starts its own local Convex
backend on free ports with a fresh instance secret and its own Auth keys
(`scripts/convex-backend.sh`), deploys `convex/` to it with type checking, runs
`bun test tests/convex` through the native client (accounts, checkout,
concurrency, migration, orders, seed, shelf and help, stock), then deletes
everything. Email goes to a local stub. GitHub Actions runs it on every push to
`main` and every pull request, after `check`, `check:scripts`, `lint` and
`bun test`.

`./scripts/test-web.sh` builds the real Worker, serves it with `wrangler dev` over
trusted HTTPS and drives Firefox against a separate disposable Convex backend.
Without a flag it runs the boundary proof (`scripts/web-proof/run.ts`): sign-in,
non-staff denial, exact values, membership revocation and the checkout cookie.
One flag selects another proof: `--shop`, `--checkout`, `--scanner`, `--admin`,
`--admins`, `--statistics`, `--labels`, `--shelf`, `--orders`, `--drafts`,
`--admin-help`, `--sidebar` or `--news`. It needs `openssl`, `certutil`
(`libnss3-tools`), `flock`, `jq` and
`bunx --no-install playwright install --with-deps firefox`. `--scanner` also needs
WebKit. `--labels` needs PyMuPDF 1.28.2 on `PATH`, for example from a venv
(`python3 -m venv .venv-proof && .venv-proof/bin/pip install PyMuPDF==1.28.2`).
Screenshots go to `test-results/`, which is ignored by git. Which proofs have
passed on Convex is in [VALIDATION.md](VALIDATION.md).

Manual proofs run against a running dev server: `scripts/home-printer-proof.ts`
and `scripts/home-soldering-proof.ts` (`bun scripts/<name>`).

## Changing the backend

Read [datamodell.md](docs/datamodell.md) first; `convex/schema.ts` and the
functions win over any doc. The rules for backend work are in
[AGENTS.md](AGENTS.md#tooling). Afterwards, add or update the case in
`tests/convex/`, run `./scripts/test-convex.sh` and update
[VALIDATION.md](VALIDATION.md).

Never point any script at a hosted deployment; the scripts start their own
backends.

## Deploying

Every push to `main` deploys production: after Validation passes, the Deploy
workflow runs `bun run deploy:production`. It requires a clean committed tree and
successful CI for the exact commit, checks that the Convex deploy key matches
`PUBLIC_CONVEX_URL` in `wrangler.jsonc`, deploys the Convex functions first, then
publishes and verifies the Worker and rolls the Worker back on failure. Convex
has no rollback, so a backend change must keep working with the previous Worker.
Never run a bare `wrangler deploy`. Details:
[runbook-deploy.md](docs/runbook-deploy.md#publish).
