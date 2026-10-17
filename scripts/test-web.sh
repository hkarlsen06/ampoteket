#!/usr/bin/env bash
# Browser acceptance on the real built shop (wrangler dev, trusted HTTPS) against
# a disposable Convex backend (scripts/convex-backend.sh). Never uses repository
# or hosted credentials.
set -euo pipefail
cd "$(dirname "$0")/.."
runner=scripts/web-proof/run.ts
case "${1:-}" in
  '') ;;
  --shop) runner=scripts/shop-proof.ts ;;
  --checkout) runner=scripts/checkout-proof.ts ;;
  --scanner) runner=scripts/scanner-proof.ts ;;
  --admin) runner=scripts/admin-proof.ts ;;
  --admins) runner=scripts/admin-access-proof.ts ;;
  --statistics) runner=scripts/statistics-proof.ts ;;
  --shelf) runner=scripts/shelf-ui-proof.ts ;;
  --labels) runner=scripts/labels-proof.ts ;;
  --orders) runner=scripts/orders-proof.ts ;;
  --drafts) runner=scripts/draft-proof.ts ;;
  --admin-help) runner=scripts/admin-help-proof.ts ;;
  --sidebar) runner=scripts/admin-sidebar-proof.ts ;;
  *) echo 'Usage: ./scripts/test-web.sh [--shop|--checkout|--scanner|--admin|--admins|--statistics|--labels|--shelf|--orders|--drafts|--admin-help|--sidebar]' >&2; exit 1 ;;
esac
if [[ $# -gt 1 ]]; then echo 'Run one proof at a time.' >&2; exit 1; fi
for executable in bun openssl certutil python3 flock curl jq; do
  command -v "$executable" >/dev/null || { echo "Missing tool: $executable" >&2; exit 1; }
done
# Fail before starting anything if the selected browser is absent.
if [[ $runner != scripts/admin-access-proof.ts ]]; then
bun --eval 'import { firefox, webkit } from "@playwright/test";
for (const browser of [firefox, ...(process.argv.at(-1) === "scripts/scanner-proof.ts" ? [webkit] : [])]) {
  if (!await Bun.file(browser.executablePath()).exists()) {
    console.error(`Missing ${browser.name()}: run bunx --no-install playwright install --with-deps ${browser.name()}`);
    process.exit(1);
  }
}' "$runner"
fi
if [[ $runner == scripts/labels-proof.ts ]] && ! python3 -c 'import pymupdf' >/dev/null 2>&1; then
  echo 'Label PDF acceptance requires Python PyMuPDF (pymupdf).' >&2; exit 1
fi
source scripts/convex-backend.sh
convex_backend_binary >/dev/null
test_dir=$(mktemp -d /tmp/ampoteket-web.XXXXXXXX)
trap 'stop_disposable_convex; rm -rf "$test_dir"' EXIT
chmod 700 "$test_dir"
mkdir -p "$test_dir/assets" "$test_dir/profile"
if [[ $runner != scripts/web-proof/run.ts ]]; then
  (
    # Proofs share build output only until their private copies are complete.
    # Keep the lock outside .svelte-kit, which the build may recreate.
    flock 9
    echo 'Building the actual SvelteKit shop for browser acceptance…'
    # Under Bun: Vite loads src/*.ts, which some Node versions cannot.
    if ! bun --bun run build >"$test_dir/build.log" 2>&1; then
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
read -r worker_port inspector_port email_port < <(python3 - <<'PY'
import socket
sockets = [socket.socket() for _ in range(3)]
for sock in sockets: sock.bind(('127.0.0.1', 0))
print(*(sock.getsockname()[1] for sock in sockets))
for sock in sockets: sock.close()
PY
)
echo 'Starting a separate disposable Convex backend…'
CONVEX_TEST_SITE_URL="https://localhost:$worker_port" start_disposable_convex "$test_dir" "$email_port"
bunx convex run --env-file "$test_dir/backend.env" seed:base >/dev/null
# The proof reads its backend from here; the admin key never reaches the browser or logs.
jq -n --arg url "$CONVEX_TEST_URL" --arg admin "$CONVEX_TEST_ADMIN_KEY" --arg server "$CONVEX_TEST_SERVER_KEY" --argjson email "$email_port" \
  '{convexUrl: $url, adminKey: $admin, serverKey: $server, emailPort: $email}' >"$test_dir/status.json"
chmod 600 "$test_dir/status.json"

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
bun run "$runner" "$test_dir" "$worker_port" "$inspector_port"
