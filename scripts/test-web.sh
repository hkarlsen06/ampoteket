#!/usr/bin/env bash
# Local Auth + browser boundary proof. Never uses repository/hosted credentials.
set -euo pipefail
cd "$(dirname "$0")/.."
runner=scripts/web-proof/run.ts
row_cap=2
if [[ ${1:-} == --shop && $# == 1 ]]; then
  runner=scripts/shop-proof.ts
  row_cap=37
elif [[ ${1:-} == --checkout && $# == 1 ]]; then
  runner=scripts/checkout-proof.ts
  row_cap=2
elif [[ ${1:-} == --scanner && $# == 1 ]]; then
  runner=scripts/scanner-proof.ts
  row_cap=2
elif [[ ${1:-} == --admin && $# == 1 ]]; then
  runner=scripts/admin-proof.ts
  row_cap=17
elif [[ ${1:-} == --statistics && $# == 1 ]]; then
  runner=scripts/statistics-proof.ts
  row_cap=2
elif [[ ${1:-} == --shelf && $# == 1 ]]; then
  runner=scripts/shelf-ui-proof.ts
  row_cap=17
elif [[ ${1:-} == --labels && $# == 1 ]]; then
  runner=scripts/labels-proof.ts
  row_cap=2
elif [[ ${1:-} == --orders && $# == 1 ]]; then
  runner=scripts/orders-proof.ts
  row_cap=2
elif [[ $# != 0 ]]; then
  echo 'Usage: ./scripts/test-web.sh [--shop|--checkout|--scanner|--admin|--statistics|--labels|--shelf|--orders]' >&2; exit 1
fi
for executable in docker psql supabase bun openssl certutil python3 flock; do
  command -v "$executable" >/dev/null || { echo "Missing tool: $executable" >&2; exit 1; }
done
# Fail before starting containers or building if the selected browser is absent.
bun --eval 'import { firefox, webkit } from "@playwright/test";
for (const browser of [firefox, ...(process.argv.at(-1) === "scripts/scanner-proof.ts" ? [webkit] : [])]) {
  if (!await Bun.file(browser.executablePath()).exists()) {
    console.error(`Missing ${browser.name()}: run bunx --no-install playwright install --with-deps ${browser.name()}`);
    process.exit(1);
  }
}' "$runner"
if [[ $runner == scripts/labels-proof.ts ]] && ! python3 -c 'import pymupdf' >/dev/null 2>&1; then
  echo 'Label PDF acceptance requires Python PyMuPDF (pymupdf).' >&2; exit 1
fi
[[ $(supabase --version 2>/dev/null) == 2.116.0 ]] || { echo 'Use Supabase CLI 2.116.0.' >&2; exit 1; }
test_dir=$(mktemp -d /tmp/ampoteket-web.XXXXXXXX)
project_id="ampoteket-web-${test_dir##*.}"
cleanup() {
  supabase stop --project-id "$project_id" --network-id "$project_id" --no-backup >"$test_dir/stop.log" 2>&1 || true
  docker network rm "$project_id" >/dev/null 2>&1 || true
  rm -rf "$test_dir"
}
trap cleanup EXIT
chmod 700 "$test_dir"
mkdir -p "$test_dir/project/supabase" "$test_dir/assets" "$test_dir/profile"
if [[ $runner != scripts/web-proof/run.ts ]]; then
  (
    # Proofs share build output only until their private copies are complete.
    # Keep the lock outside .svelte-kit, which the build may recreate.
    flock 9
    echo 'Building the actual SvelteKit shop for browser acceptance…'
    if ! bun run build >"$test_dir/build.log" 2>&1; then
      tail -40 "$test_dir/build.log" >&2
      exit 1
    fi
    # The adapter Worker imports both of these sibling server directories.
    mkdir -p "$test_dir/site/output"
    cp -a .svelte-kit/cloudflare .svelte-kit/cloudflare-tmp "$test_dir/site/"
    cp -a .svelte-kit/output/server "$test_dir/site/output/"
    ln -s "$PWD/node_modules" "$test_dir/site/node_modules"
  ) 9>node_modules/.ampoteket-proof-build.lock
fi
cp -r supabase/migrations "$test_dir/project/supabase/"
cp -r supabase/templates "$test_dir/project/supabase/"
read -r api_port db_port shadow_port worker_port inspector_port mailpit_port < <(python3 - <<'PY'
import socket
sockets = [socket.socket() for _ in range(6)]
for sock in sockets: sock.bind(('127.0.0.1', 0))
print(*(sock.getsockname()[1] for sock in sockets))
for sock in sockets: sock.close()
PY
)
mailpit_enabled=false
excluded_services='realtime,storage-api,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor'
if [[ $runner == scripts/checkout-proof.ts ]]; then
  mailpit_enabled=true
  excluded_services='realtime,storage-api,imgproxy,postgres-meta,studio,edge-runtime,logflare,vector,supavisor'
fi
cat >"$test_dir/project/supabase/config.toml" <<EOF
project_id = "$project_id"
[api]
port = $api_port
schemas = ["public"]
extra_search_path = ["public", "extensions"]
max_rows = $row_cap
[db]
port = $db_port
shadow_port = $shadow_port
major_version = 17
[db.seed]
enabled = false
[auth]
site_url = "https://localhost:$worker_port"
enable_signup = false
[auth.email]
# The CLI uses this to enable the email provider; global signup stays disabled.
enable_signup = true
enable_confirmations = false
[auth.email.template.invite]
subject = "Ampoteket: Invitasjon / Invitation"
content_path = "./supabase/templates/invite.html"
[auth.email.template.recovery]
subject = "Ampoteket: Tilbakestill passord / Reset password"
content_path = "./supabase/templates/recovery.html"
[studio]
enabled = false
[inbucket]
enabled = $mailpit_enabled
port = $mailpit_port
[storage]
enabled = false
[realtime]
enabled = false
[edge_runtime]
enabled = false
[analytics]
enabled = false
EOF
echo 'Starting a separate disposable Supabase Auth/PostgREST project…'
docker network create --driver bridge --opt com.docker.network.bridge.host_binding_ipv4=127.0.0.1 "$project_id" >/dev/null
# CLI output includes local keys; never echo these logs into a terminal/CI log.
if ! supabase start --workdir "$test_dir/project" --network-id "$project_id" \
  -x "$excluded_services" \
  >"$test_dir/start.log" 2>&1; then
  echo 'Disposable Supabase startup failed; no existing project was changed.' >&2
  exit 1
fi
supabase status --workdir "$test_dir/project" -o json >"$test_dir/status.json" 2>"$test_dir/status.log"

# Trust a short-lived test CA only inside this disposable Firefox profile.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=Ampoteket disposable web test CA' \
  -keyout "$test_dir/ca.key" -out "$test_dir/ca.pem" >"$test_dir/tls.log" 2>&1
openssl req -newkey rsa:2048 -nodes -subj '/CN=localhost' \
  -keyout "$test_dir/server.key" -out "$test_dir/server.csr" >>"$test_dir/tls.log" 2>&1
printf '%s\n' 'subjectAltName=DNS:localhost,IP:127.0.0.1' 'extendedKeyUsage=serverAuth' >"$test_dir/extensions"
openssl x509 -req -days 1 -in "$test_dir/server.csr" -CA "$test_dir/ca.pem" -CAkey "$test_dir/ca.key" \
  -CAcreateserial -extfile "$test_dir/extensions" -out "$test_dir/server.pem" >>"$test_dir/tls.log" 2>&1
certutil -N --empty-password -d "sql:$test_dir/profile"
certutil -A -d "sql:$test_dir/profile" -n ampoteket-test-ca -t 'C,,' -i "$test_dir/ca.pem"
bun run "$runner" "$test_dir" "$worker_port" "$inspector_port" "$mailpit_port"
