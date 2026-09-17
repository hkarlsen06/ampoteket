#!/usr/bin/env bash
# Disposable PostgreSQL + real PostgREST, isolated from all existing services.
# No hosted credentials or caller-supplied database URLs; ports bind to loopback.
set -euo pipefail
cd "$(dirname "$0")/.."
for executable in docker psql supabase bun curl; do
  command -v "$executable" >/dev/null || { echo "Missing tool: $executable" >&2; exit 1; }
done
if [[ $(supabase --version 2>/dev/null) != 2.116.0 ]]; then
  echo 'Use Supabase CLI 2.116.0 for the reproducible API check.' >&2; exit 1
fi

test_dir=$(mktemp -d /tmp/ampoteket-api.XXXXXXXX)
pg_container="ampoteket-api-pg-${test_dir##*.}"
api_container="ampoteket-api-http-${test_dir##*.}"
test_network="ampoteket-api-net-${test_dir##*.}"
cleanup() {
  docker rm -f "$api_container" "$pg_container" >/dev/null 2>&1 || true
  docker network rm "$test_network" >/dev/null 2>&1 || true
  rm -rf "$test_dir"
}
trap cleanup EXIT
mkdir -p "$test_dir/project/supabase"
cp supabase/config.toml "$test_dir/project/supabase/"
cp -r supabase/migrations "$test_dir/project/supabase/"
cp -r supabase/templates "$test_dir/project/supabase/"
docker network create --driver bridge "$test_network" >/dev/null
docker run --rm -d --name "$pg_container" --network "$test_network" -p 127.0.0.1::5432 --user postgres \
  --entrypoint /bin/bash supabase/postgres:17.6.1.136 \
  -c 'initdb -D /tmp/test-pg -A trust --no-locale --encoding=UTF8 >/tmp/init.log && echo "host all all 0.0.0.0/0 trust" >>/tmp/test-pg/pg_hba.conf && exec postgres -D /tmp/test-pg -c listen_addresses="*"' >/dev/null
export PGHOST=127.0.0.1 PGUSER=postgres PGDATABASE=postgres
export PGPORT=$(docker port "$pg_container" 5432/tcp | sed -n 's/.*://p' | head -1)
unset PGSERVICE PGSERVICEFILE PGOPTIONS PGPASSWORD
for attempt in {1..60}; do
  if psql -X -Atqc 'SELECT 1' >/dev/null 2>&1; then break; fi
  if [[ $attempt == 60 ]]; then docker logs "$pg_container"; exit 1; fi
  sleep 0.25
done
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/bootstrap.sql >/dev/null
supabase migration up --workdir "$test_dir/project" \
  --db-url "postgresql://postgres@127.0.0.1:$PGPORT/postgres?sslmode=disable" --yes
psql -X -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
CREATE ROLE authenticator LOGIN NOINHERIT;
GRANT anon,authenticated,service_role TO authenticator;
SQL
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/api-fixtures.sql >/dev/null

# Intentionally public synthetic test key, never a key from an existing project.
export AMP_API_TEST_JWT_SECRET='ampoteket-disposable-api-test-key-never-use-in-production'
docker run --rm -d --name "$api_container" --network "$test_network" -p 127.0.0.1::3000 \
  -e "PGRST_DB_URI=postgresql://authenticator@$pg_container/postgres" \
  -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon -e PGRST_DB_CONFIG=false \
  -e PGRST_DB_MAX_ROWS=37 -e PGRST_DB_POOL=3 \
  -e "PGRST_JWT_SECRET=$AMP_API_TEST_JWT_SECRET" \
  postgrest/postgrest:v14.12 >/dev/null
api_port=$(docker port "$api_container" 3000/tcp | sed -n 's/.*://p' | head -1)
export AMP_API_TEST_ORIGIN="http://127.0.0.1:$api_port"
for attempt in {1..60}; do
  if curl --silent --fail --max-time 1 \
    "$AMP_API_TEST_ORIGIN/rpc/amp_shelf_map" >/dev/null; then break; fi
  if [[ $attempt == 60 ]]; then docker logs "$api_container"; exit 1; fi
  sleep 0.25
done
bun run scripts/test-api.ts
# Independent DB verification of the staff's HTTP metadata round trip.
if [[ $(psql -X -Atqc "SELECT sale_unit_price_nok=999999999998.999999 FROM app.products WHERE code='TEST-R'") != t ]]; then
  echo 'HTTP metadata round trip changed the exact database price.' >&2; exit 1
fi
echo 'PASS: isolated PostgREST HTTP transport, pagination, topology and synthetic JWT authorization'
