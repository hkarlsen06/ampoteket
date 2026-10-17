#!/usr/bin/env bash
# Backend acceptance tests against a disposable Convex backend (the Convex
# counterpart of the former PostgreSQL harness). Starts its own local backend on
# free ports with a fresh instance secret, deploys convex/ to it (with type
# checking), configures Auth keys and test-only settings, runs tests/convex/,
# then deletes everything. Never reads .env.local or a hosted deployment.
#
# Needs Bun with installed dependencies. The backend binary comes from the
# Convex CLI cache; a first `CONVEX_AGENT_MODE=anonymous bunx convex dev --once`
# downloads it (CI does this).
set -euo pipefail
cd "$(dirname "$0")/.."

binary=$(ls -t "$HOME"/.cache/convex/binaries/*/convex-local-backend 2>/dev/null | head -1 || true)
if [[ -z "$binary" ]]; then
  echo 'No Convex backend binary cached; run: CONVEX_AGENT_MODE=anonymous bunx convex dev --once' >&2
  exit 1
fi
free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
test_dir=$(mktemp -d /tmp/ampoteket-convex-test.XXXXXXXX)
port=$(free_port); site_port=$(free_port); email_port=$(free_port)
name="ampoteket-test"
secret=$(python3 -c 'import secrets; print(secrets.token_hex(32))')
admin_key=$("$binary" keygen admin-key --instance-name "$name" --instance-secret "$secret")
"$binary" --port "$port" --site-proxy-port "$site_port" --instance-name "$name" --instance-secret "$secret" \
  --local-storage "$test_dir/storage" "$test_dir/backend.sqlite3" >"$test_dir/backend.log" 2>&1 &
backend_pid=$!
cleanup() { kill "$backend_pid" 2>/dev/null || true; wait "$backend_pid" 2>/dev/null || true; rm -rf "$test_dir"; }
trap cleanup EXIT
for attempt in {1..100}; do
  curl -sf "http://127.0.0.1:$port/version" >/dev/null && break
  if [[ $attempt == 100 ]]; then cat "$test_dir/backend.log"; exit 1; fi
  sleep 0.2
done

url="http://127.0.0.1:$port"
# The CLI targets this backend through its own env file, never the repo's .env.local.
printf 'CONVEX_SELF_HOSTED_URL=%s\nCONVEX_SELF_HOSTED_ADMIN_KEY=%s\n' "$url" "$admin_key" > "$test_dir/backend.env"
# `convex <command words...> -- args`: the option must precede the `--` that protects values like PEM keys.
convex() { local words=("$1" "$2"); shift 2; bunx convex "${words[@]}" --env-file "$test_dir/backend.env" "$@"; }
# Auth signing keys, generated per run.
keys=$(bun -e '
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
const k = await generateKeyPair("RS256", { extractable: true });
const pkcs8 = (await exportPKCS8(k.privateKey)).trimEnd().replace(/\n/g, " ");
console.log(JSON.stringify({ pkcs8, jwks: JSON.stringify({ keys: [{ use: "sig", ...(await exportJWK(k.publicKey)) }] }) }));')
convex env set JWT_PRIVATE_KEY -- "$(jq -r .pkcs8 <<<"$keys")" >/dev/null
convex env set JWKS "$(jq -r .jwks <<<"$keys")" >/dev/null
convex env set SITE_URL http://localhost:5174 >/dev/null
convex env set CHECKOUT_SERVER_KEY test-checkout-server-key-0123456789abcdef >/dev/null
convex env set ALLOW_MIGRATION_RESET true >/dev/null
convex env set RESEND_API_KEY test-resend-key >/dev/null
convex env set EMAIL_API_URL "http://127.0.0.1:$email_port/emails" >/dev/null
convex deploy --yes >"$test_dir/deploy.log" 2>&1 || { cat "$test_dir/deploy.log"; exit 1; }

TEST_CONVEX_URL="$url" TEST_CONVEX_ADMIN_KEY="$admin_key" TEST_EMAIL_PORT="$email_port" \
  TEST_CHECKOUT_SERVER_KEY=test-checkout-server-key-0123456789abcdef \
  bun test tests/convex --timeout 60000
