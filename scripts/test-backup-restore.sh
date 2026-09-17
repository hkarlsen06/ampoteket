#!/usr/bin/env bash
# Isolated regression for restore fidelity, not a hosted Supabase restore tool.
set -euo pipefail
cd "$(dirname "$0")/.."
for executable in docker psql python3 supabase; do
  command -v "$executable" >/dev/null || { echo "Missing tool: $executable" >&2; exit 1; }
done
[[ $(supabase --version 2>/dev/null) == 2.116.0 ]] || { echo 'Use Supabase CLI 2.116.0.' >&2; exit 1; }
restore_dir=$(mktemp -d /tmp/ampoteket-restore.XXXXXXXX)
restore_container="ampoteket-restore-${restore_dir##*.}"
cleanup() {
  docker rm -f "$restore_container" >/dev/null 2>&1 || true
  rm -rf "$restore_dir"
}
trap cleanup EXIT
mkdir -p "$restore_dir/project/supabase"
cp supabase/config.toml "$restore_dir/project/supabase/"
cp -r supabase/migrations "$restore_dir/project/supabase/"
cp -r supabase/templates "$restore_dir/project/supabase/"
docker run --rm -d --name "$restore_container" --network bridge -p 127.0.0.1::5432 --user postgres \
  --entrypoint /bin/bash supabase/postgres:17.6.1.136 \
  -c 'initdb -D /tmp/restore-pg -A trust --no-locale --encoding=UTF8 >/tmp/init.log && echo "host all all 0.0.0.0/0 trust" >>/tmp/restore-pg/pg_hba.conf && exec postgres -D /tmp/restore-pg -c listen_addresses="*" -c unix_socket_directories=/tmp' >/dev/null
export PGHOST=127.0.0.1 PGUSER=postgres PGDATABASE=postgres
export PGPORT=$(docker port "$restore_container" 5432/tcp | sed -n 's/.*://p' | head -1)
unset PGSERVICE PGSERVICEFILE PGOPTIONS PGPASSWORD
for attempt in {1..60}; do
  if psql -X -Atqc 'SELECT 1' >/dev/null 2>&1; then break; fi
  if [[ $attempt == 60 ]]; then docker logs "$restore_container"; exit 1; fi
  sleep 0.5
done
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/bootstrap.sql >/dev/null
restore_url="postgresql://postgres@127.0.0.1:$PGPORT/postgres?sslmode=disable"
supabase migration up --workdir "$restore_dir/project" --db-url "$restore_url" --yes

# Reuse the evolving acceptance suite's realistic history, retaining it ONLY in
# this private container. Never change the rollback-only source acceptance file.
python3 - "$restore_dir" <<'PY'
from pathlib import Path
import sys
target = Path(sys.argv[1])
sql = Path('supabase/tests/acceptance.sql').read_text()
assert sql.rstrip().endswith('ROLLBACK;'), 'Acceptance fixture transaction changed; review restore setup.'
(target / 'acceptance.sql').write_text(sql.rstrip()[:-len('ROLLBACK;')] + 'COMMIT;\n')
for name in ('fixtures.sql', 'shelf-layout.sql'):
    (target / name).write_text((Path('supabase/tests') / name).read_text())
PY
psql -X -v ON_ERROR_STOP=1 -f "$restore_dir/acceptance.sql" >"$restore_dir/fixtures.log" 2>&1 || { cat "$restore_dir/fixtures.log"; exit 1; }
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/restore-fixtures.sql >/dev/null
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/v1-invariants.sql
python3 scripts/database-manifest.py >"$restore_dir/before.json"

# Matching pg_dump/pg_restore binaries come from the pinned server image.
# This private database contains only app/Auth-fixture/history objects. Dumping
# the whole DB also preserves PostgreSQL's built-in public-schema ACL semantics.
dump_command=(docker exec "$restore_container" pg_dump -h /tmp -U postgres)
"${dump_command[@]}" -d postgres --format=custom >"$restore_dir/backup.dump"
"${dump_command[@]}" -d postgres --schema-only >"$restore_dir/before-schema.sql"
psql -X -v ON_ERROR_STOP=1 -c 'CREATE DATABASE restored TEMPLATE template0' >/dev/null
docker exec -i "$restore_container" pg_restore -h /tmp -U postgres -d restored \
  --single-transaction --exit-on-error <"$restore_dir/backup.dump"
PGDATABASE=restored python3 scripts/database-manifest.py >"$restore_dir/after.json"
cmp "$restore_dir/before.json" "$restore_dir/after.json"
"${dump_command[@]}" -d restored --schema-only >"$restore_dir/after-schema.sql"
# PostgreSQL patch releases may randomize psql's restriction token in each dump.
python3 - "$restore_dir" <<'PY'
from pathlib import Path
import sys
import difflib
import os
import subprocess
root = Path(sys.argv[1])
def normalized(name):
    return [line for line in (root / name).read_text().splitlines()
            if not line.startswith(('\\restrict ', '\\unrestrict ', '\tCONSTRAINT '))]
# pg_dump reparses BETWEEN checks to nested ANDs; deparse them in pretty mode
# for a semantic comparison, separate from the exact remaining schema/ACLs.
query = "SELECT n.nspname,c.conname,pg_get_constraintdef(c.oid,true) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE c.contypid<>0 ORDER BY 1,2"
domain_checks = []
for database in ('postgres', 'restored'):
    domain_checks.append(subprocess.check_output(['psql','-X','-At','-v','ON_ERROR_STOP=1','-c',query], env={**os.environ,'PGDATABASE':database}))
if domain_checks[0] != domain_checks[1]:
    raise SystemExit('Restored domain constraints differ.')
before, after = normalized('before-schema.sql'), normalized('after-schema.sql')
if before != after:
    print('\n'.join(difflib.unified_diff(before, after, fromfile='source-schema', tofile='restored-schema')))
    raise SystemExit('Restored schema/ACLs differ.')
PY
# Also exercise the schema-first, trigger-suppressed data replay used by the
# hosted runbook, still with synthetic Auth/roles in our private database.
docker exec -i "$restore_container" pg_restore --schema-only --file=- <"$restore_dir/backup.dump" >"$restore_dir/schema.sql"
docker exec -i "$restore_container" pg_restore --data-only --file=- <"$restore_dir/backup.dump" >"$restore_dir/data.sql"
psql -X -v ON_ERROR_STOP=1 -c 'CREATE DATABASE restored_split TEMPLATE template0' >/dev/null
psql -X -d restored_split --single-transaction -v ON_ERROR_STOP=1 \
  -f "$restore_dir/schema.sql" -c 'SET LOCAL session_replication_role = replica' \
  -f "$restore_dir/data.sql" -c 'SET LOCAL session_replication_role = origin' >"$restore_dir/split.log" 2>&1 || { cat "$restore_dir/split.log"; exit 1; }
PGDATABASE=restored_split python3 scripts/database-manifest.py >"$restore_dir/split.json"
cmp "$restore_dir/before.json" "$restore_dir/split.json"
for destination in restored restored_split; do
  for check in supabase/tests/permissions.sql supabase/tests/protections.sql supabase/tests/v1-invariants.sql supabase/tests/restore-verify.sql; do
    PGDATABASE="$destination" psql -X -v ON_ERROR_STOP=1 -f "$check"
  done
done

# A real mid-restore object conflict must abort the whole restore, not leave a
# healthy-looking partial application. app sorts before auth in the archive.
psql -X -v ON_ERROR_STOP=1 -c 'CREATE DATABASE restore_failure TEMPLATE template0' >/dev/null
psql -X -d restore_failure -v ON_ERROR_STOP=1 -c 'CREATE SCHEMA auth' >/dev/null
if docker exec -i "$restore_container" pg_restore -h /tmp -U postgres -d restore_failure \
  --single-transaction --exit-on-error <"$restore_dir/backup.dump" >"$restore_dir/failure.log" 2>&1; then
  echo 'Restore conflict unexpectedly succeeded.' >&2; exit 1
fi
if [[ $(psql -X -d restore_failure -Atqc "SELECT to_regnamespace('app') IS NULL AND to_regnamespace('supabase_migrations') IS NULL") != t ]]; then
  cat "$restore_dir/failure.log"; echo 'Failed restore left partial state.' >&2; exit 1
fi
echo 'PASS: restore preserves all rows, Auth links, history, sequences, schema/ACLs, retries and guardrails; failure rolls back'
