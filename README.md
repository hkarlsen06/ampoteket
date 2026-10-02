# Ampoteket

Web shop and stock system for the student-run electronics workshop at
`ampoteket.no`. Buyers need no account: they browse stock, fill a cart, pay with
trust-based Vipps and register the purchase, which withdraws stock. Staff maintain
products, placement, purchasing and counts with a full audit trail.

SvelteKit 2 / Svelte 5 on Cloudflare Workers, Supabase (Postgres + Auth), Bun,
shadcn-svelte and Tailwind CSS 4. Norwegian at `/`, English at `/en`.

**Status:** live at `ampoteket.no` with sales closed. What is live right now is in
[AGENTS.md](AGENTS.md#current-state); [VALIDATION.md](VALIDATION.md) lists what has
been run and what is still needed before sales open.

## Access for maintainers

A maintainer needs an account with access to each of these. At every handover,
add the new maintainers and check that at least two people can reach each one.

| Service | Used for | Where |
| --- | --- | --- |
| GitHub | Code, issues and CI | [hkarlsen06/ampoteket](https://github.com/hkarlsen06/ampoteket), moving to an `ampoteket` organization |
| Supabase | Database, Auth and backups | [Project `mqzcbdorjuefefzvuefa`](https://supabase.com/dashboard/project/mqzcbdorjuefefzvuefa) |
| Resend | Invitation and password emails from `noreply@notify.ampoteket.no`, sent through Supabase SMTP | [resend.com](https://resend.com) |
| Cloudflare | The `ampoteket` Worker and DNS for `ampoteket.no` | A private account for now, moving to a shared team account |
| Domeneshop | Renewing `ampoteket.no`, which is registered to a private owner; changes go through them | [domene.shop](https://domene.shop) |

Staff access to the shop itself is separate: an active admin invites you at
`/admin/admins`.

Hjalmar Karlsen (`hkarlsen06`) is the primary service-access, backup and contact
retention operator. Independent backup access and recovery targets are still open
in the [backup runbook](docs/runbook-backup-restore.md#1-decisions-required-before-launch).

## Where to read

Start with the [project overview](docs/prosjektoversikt.md); it lists the document
for each area.

## Setup

Linux with Docker, `psql`, Python 3, curl, `flock`, Git LFS, **Bun 1.3.14** and
**Supabase CLI 2.116.0**.

```sh
git lfs pull                  # original photos and Blender files (only needed to rebuild them)
bun install --frozen-lockfile
bun run development           # disposable database + test admin + dev server
```

The `cookie` override keeps SvelteKit on a patched serializer while its dependency
still requests `^0.6.0`. Remove it when SvelteKit requires a patched version;
`bun audit` checks the resolved dependency tree.

Open <http://localhost:5174> and sign in at `/admin/login` as **`test@test.no` /
`test`**. Every start creates a fresh, empty database, and Ctrl-C removes it.
Useful options (after `--`):

- `--workshop`: 174 sample products in the real shelf layout, with a year of
  fictional orders and sales. The data is illustrative, not a real inventory.
- `--count 30`: the synthetic catalog used by the browser tests.
- `--sigkill`: take over the pinned ports from a stuck earlier run.

Port **5174** is used by both `bun run dev` and `bun run preview`; run one at a time.

Startup never removes another seed project, including one left by a crash. If an
old project holds a port, inspect `docker ps` and stop that exact disposable seed
explicitly with `supabase stop --project-id <seed-id> --network-id <seed-id> --no-backup`
only after deciding its data can be discarded. Normal shutdown removes only the
project created by that invocation.

### HTTPS (checkout and camera)

Checkout cookies and the camera need trusted HTTPS. Use the local Caddy proxy:

```sh
caddy run --config Caddyfile.local --adapter caddyfile     # terminal 1
caddy trust --address 127.0.0.1:20199                      # once, while Caddy runs

NODE_EXTRA_CA_CERTS="$PWD/.local-https/pki/authorities/local/root.crt" \
PUBLIC_SUPABASE_URL=https://localhost:8443 \
CHECKOUT_ALLOWED_ORIGIN=https://localhost:8443 \
bun run development -- --studio-port off                   # terminal 2
```

Open <https://localhost:8443>. Firefox may need
`.local-https/pki/authorities/local/root.crt` imported as a trusted authority.
Never commit `.local-https/`. If you get a 502, the frontend or database has not
started yet. Make sure an old `.dev.vars` does not override these settings.
Testing on a physical phone needs a trusted HTTPS origin the phone can reach, such
as a tunnel or a private network name with a real certificate; see
[scanner.md](docs/scanner.md#5-physical-acceptance-record).

## Commands

| Command | What it does |
| --- | --- |
| `bun run dev` / `bun run preview` | Vite dev server / production build in the Workers runtime (needs `.env`, see `.env.example`) |
| `bun run check` / `bun run check:scripts` | Type-check the app / the scripts and browser proofs |
| `bun run lint` | em dash ban (`check:dashes`), oxlint + ESLint |
| `bun test` | Unit tests (`src/lib/*.test.ts`) |
| `bun run check:ink` | Catch clipped SVG/CSS edges |
| `bun run i18n` | Side-by-side editor for the Norwegian and English strings, port 5175 ([i18n.md](docs/i18n.md)) |
| `./scripts/test-database.sh` | Full database suite in a throwaway PostgreSQL |
| `./scripts/test-web.sh [--mode]` | Real browser or HTTP tests against a throwaway stack |
| `bun scripts/build-poster.ts` | The A4 buyer poster for the shelf, `assets/poster/kjopsplakat-a4.pdf` (copy follows `src/lib/i18n`; print at 100 %), plus its picture for the showcase slide |
| `./scripts/seed-test.sh` | A separate throwaway catalog for experiments (`--count N`, `--check`, `--workshop`) |
| `/slopo-review`, `/slopo-analyze-ignore`, `/slopo-analyze-one` | Claude Code skills that find non-exact duplicate code with [Slopo](https://slopo.dev) (`uv tool install slopo`, key in `.env` as `SLOPO_EMBEDDING_API_KEY`, config in `slopo.conf.yaml`) |

## Tests

`./scripts/test-database.sh` needs no credentials. It starts its own PostgreSQL
17.6, applies the migrations through the Supabase CLI, then checks acceptance,
permissions, concurrency, rollback/retry, backup/restore and real PostgREST HTTP.
It removes everything it created when it finishes. GitHub Actions runs it on every
push.

`./scripts/test-web.sh` builds the real Worker and drives Firefox against a
throwaway Supabase stack with real Auth. Modes: none (boundary checks), `--shop`,
`--checkout`, `--admin`, `--statistics`, `--scanner`, `--labels`, `--shelf`,
`--orders`, `--drafts`, `--admins`. It also needs OpenSSL, `certutil`
(`libnss3-tools`) and `bunx --no-install playwright install --with-deps firefox`. `--scanner` also needs
WebKit. `--labels` needs PyMuPDF 1.28.2 on `PATH`, for example from a venv
(`python3 -m venv .venv-proof && .venv-proof/bin/pip install PyMuPDF==1.28.2`).
Screenshots go to `test-results/`, which is ignored by git.

`./scripts/test-web.sh --admins` checks admin invitations over real HTTP through
the built Worker, local Auth and Mailpit: email links, password setup, permissions,
audit attribution and safe membership retries. It also checks the Admins page at
360 and 1280 px, in both languages and colour schemes.

Manual proofs run against a running dev server: `scripts/admin-sidebar-proof.ts`,
`scripts/home-printer-proof.ts` and `scripts/home-soldering-proof.ts`
(`bun scripts/<name>`).

## Changing the database

- Change the schema only through a new migration in `supabase/migrations/`, and
  apply it with the Supabase CLI. Migration files must not contain their own
  top-level `BEGIN`/`COMMIT`.
- A new privileged function must revoke execution from `PUBLIC`, `anon`,
  `authenticated` and `service_role`, and grant it only to reviewed callers, in
  the same migration. `supabase/tests/permissions.sql` fails until you add it there.
- Keep the table definitions in [datamodell.md](docs/datamodell.md) Appendix A in
  sync. The test suite compares them with the real schema.
- Every error name the migrations raise must be listed in
  [website-guide.md](docs/website-guide.md) §8.1. The test suite checks this too.
- Afterwards, run `./scripts/test-database.sh` and update the hashes and counts in
  [VALIDATION.md](VALIDATION.md).

Never point any script at the hosted Supabase project. Deploying is a separate,
explicit decision ([runbook](docs/runbook-deploy.md)).
