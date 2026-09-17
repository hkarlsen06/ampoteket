#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

for executable in docker psql python3 supabase bun curl; do
  command -v "$executable" >/dev/null || { echo "Missing tool: $executable" >&2; exit 1; }
done
if [[ $(supabase --version 2>/dev/null) != 2.116.0 ]]; then
  echo 'Use Supabase CLI 2.116.0 for the reproducible database check.' >&2
  exit 1
fi

python3 - <<'PY'
import re
from pathlib import Path

# Every error name the migration can raise must appear in the catalog
# (docs/website-guide.md section 8.1) so the Worker/UI can map it.
sql = '\n'.join(path.read_text() for path in sorted(Path('supabase/migrations').glob('*.sql')))
raised = set(re.findall(r"RAISE EXCEPTION '([A-Z][A-Z0-9_]*)", sql))
guide = Path('docs/website-guide.md').read_text()
documented = set(re.findall(r'`([A-Z][A-Z0-9_]*)`', guide))
missing = sorted(raised - documented)
if missing:
    raise SystemExit('Error names missing from the docs/website-guide.md catalog: ' + ', '.join(missing))
PY

# Always create our own database. Never accept a hosted-project URL or password.
test_dir=$(mktemp -d /tmp/ampoteket-db.XXXXXXXX)
test_container="ampoteket-test-${test_dir##*.}"
cleanup() {
  docker rm -f "$test_container" >/dev/null 2>&1 || true
  rm -rf "$test_dir"
}
trap cleanup EXIT
mkdir -p "$test_dir/project/supabase"
cp supabase/config.toml "$test_dir/project/supabase/"
cp -r supabase/migrations "$test_dir/project/supabase/"
cp -r supabase/templates "$test_dir/project/supabase/"
docker run --rm -d --name "$test_container" --network bridge -p 127.0.0.1::5432 --user postgres \
  --entrypoint /bin/bash supabase/postgres:17.6.1.136 \
  -c 'initdb -D /tmp/test-pg -A trust --no-locale --encoding=UTF8 >/tmp/init.log && echo "host all all 0.0.0.0/0 trust" >>/tmp/test-pg/pg_hba.conf && exec postgres -D /tmp/test-pg -c listen_addresses="*"' >/dev/null

export PGHOST=127.0.0.1 PGUSER=postgres PGDATABASE=postgres
export PGPORT=$(docker port "$test_container" 5432/tcp | sed -n 's/.*://p' | head -1)
export AMPOTEKET_DISPOSABLE_DB_CONTAINER="$test_container"
unset PGSERVICE PGSERVICEFILE PGOPTIONS PGPASSWORD
for attempt in {1..60}; do
  if psql -X -Atqc 'SELECT 1' >/dev/null 2>&1; then break; fi
  if [[ $attempt == 60 ]]; then docker logs "$test_container"; exit 1; fi
  sleep 0.5
done
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/bootstrap.sql >/dev/null
# Clone only the empty fixture schema for the migration-failure test.
psql -X -v ON_ERROR_STOP=1 -c 'CREATE DATABASE migration_failure TEMPLATE postgres' >/dev/null
database_url="postgresql://postgres@127.0.0.1:$PGPORT/postgres?sslmode=disable"
supabase migration up --workdir "$test_dir/project" --db-url "$database_url" --yes
python3 scripts/check-schema-docs.py
# Exact workshop layout and units; no invented products, counts or stock.
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/initial-layout.sql
python3 scripts/database-manifest.py >"$test_dir/first-install.json"
supabase migration up --workdir "$test_dir/project" --db-url "$database_url" --yes
python3 scripts/database-manifest.py >"$test_dir/repeated-install.json"
cmp "$test_dir/first-install.json" "$test_dir/repeated-install.json"
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/permissions.sql
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/protections.sql
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/acceptance.sql
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/audit-regressions.sql
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/numeric-read-models.sql
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/admin-statistics.sql
bun run supabase/tests/catalog-search.ts
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/catalog-workload.sql
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/input-boundaries.sql
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/help-directory.sql
python3 supabase/tests/security_mutations.py
python3 supabase/tests/invariant-detector.py

# Prove the permissions check catches a future helper's inherited PUBLIC grant.
psql -X -v ON_ERROR_STOP=1 -c "CREATE FUNCTION app.unreviewed_helper() RETURNS boolean LANGUAGE sql SECURITY DEFINER AS 'SELECT true'" >/dev/null
if psql -X -v ON_ERROR_STOP=1 -f supabase/tests/permissions.sql >"$test_dir/permissions.log" 2>&1; then
  echo 'Permissions check failed to detect an exposed helper.' >&2; exit 1
fi
if ! python3 -c 'import pathlib,sys; sys.exit(sys.argv[2] not in pathlib.Path(sys.argv[1]).read_text())' "$test_dir/permissions.log" 'UNEXPECTED_FUNCTION_PRIVILEGE'; then
  cat "$test_dir/permissions.log"; exit 1
fi
psql -X -v ON_ERROR_STOP=1 -c 'DROP FUNCTION app.unreviewed_helper()' >/dev/null

# Prove the protections check catches a future table added without review.
psql -X -v ON_ERROR_STOP=1 -c 'CREATE TABLE app.unreviewed_table(id int)' >/dev/null
if psql -X -v ON_ERROR_STOP=1 -f supabase/tests/protections.sql >"$test_dir/protections.log" 2>&1; then
  echo 'Protections check failed to detect an unreviewed table.' >&2; exit 1
fi
if ! python3 -c 'import pathlib,sys; sys.exit(sys.argv[2] not in pathlib.Path(sys.argv[1]).read_text())' "$test_dir/protections.log" 'UNREVIEWED_TABLE'; then
  cat "$test_dir/protections.log"; exit 1
fi
psql -X -v ON_ERROR_STOP=1 -c 'DROP TABLE app.unreviewed_table' >/dev/null

psql -X -d migration_failure -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
CREATE SCHEMA supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations (
  version text PRIMARY KEY CHECK (version <> '20260917000100'),
  statements text[], name text
);
SQL
failure_url="postgresql://postgres@127.0.0.1:$PGPORT/migration_failure?sslmode=disable"
if supabase migration up --workdir "$test_dir/project" --db-url "$failure_url" --yes >"$test_dir/migration.log" 2>&1; then
  echo 'Injected migration-history failure unexpectedly succeeded.' >&2; exit 1
fi
if [[ $(psql -X -d migration_failure -Atqc "SELECT to_regnamespace('app') IS NULL AND NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations)") != t ]]; then
  cat "$test_dir/migration.log"; echo 'Migration failure left partial state.' >&2; exit 1
fi
# Retrying after the underlying failure is repaired must succeed normally.
psql -X -d migration_failure -v ON_ERROR_STOP=1 -c 'ALTER TABLE supabase_migrations.schema_migrations DROP CONSTRAINT schema_migrations_version_check' >/dev/null
supabase migration up --workdir "$test_dir/project" --db-url "$failure_url" --yes
if [[ $(psql -X -d migration_failure -Atqc "SELECT to_regclass('app.products') IS NOT NULL AND EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260917000100')") != t ]]; then
  echo 'Migration retry did not install and record the schema.' >&2; exit 1
fi

psql -X -v ON_ERROR_STOP=1 -f supabase/tests/fixtures.sql >/dev/null
psql -X -v ON_ERROR_STOP=1 -c 'CREATE DATABASE workflow_sequences TEMPLATE postgres' >/dev/null
PGDATABASE=workflow_sequences python3 supabase/tests/sequence_properties.py
python3 supabase/tests/concurrency.py
python3 supabase/tests/contact-retention.py
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/v1-invariants.sql
./scripts/test-backup-restore.sh
./scripts/test-api.sh
bun test
echo 'PASS: database, migration, security, workflow, concurrency, restore and HTTP regressions'
