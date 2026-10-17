# Source this to start a disposable local Convex backend (tests and browser
# proofs). Defines: start_disposable_convex <directory> [email_port], which sets
# CONVEX_TEST_URL, CONVEX_TEST_ADMIN_KEY and CONVEX_TEST_SERVER_KEY, deploys
# convex/ to it with type checking, and stops it on EXIT. It never reads
# .env.local or a hosted deployment.

convex_backend_binary() {
  local binary
  binary=$(ls -t "$HOME"/.cache/convex/binaries/*/convex-local-backend 2>/dev/null | head -1 || true)
  if [[ -z "$binary" ]]; then
    echo 'No Convex backend binary cached; run: CONVEX_AGENT_MODE=anonymous bunx convex dev --once' >&2
    return 1
  fi
  echo "$binary"
}

# convex_test <command words...> [-- args]: the CLI against the disposable backend only.
convex_test() {
  local words=("$1" "$2"); shift 2
  bunx convex "${words[@]}" --env-file "$CONVEX_TEST_DIR/backend.env" "$@"
}

start_disposable_convex() {
  CONVEX_TEST_DIR=$1
  local email_port=${2:-}
  local binary port site_port secret name=ampoteket-test
  binary=$(convex_backend_binary)
  read -r port site_port < <(python3 -c 'import socket
s=[socket.socket() for _ in range(2)]
[x.bind(("127.0.0.1",0)) for x in s]
print(*(x.getsockname()[1] for x in s))')
  secret=$(python3 -c 'import secrets; print(secrets.token_hex(32))')
  CONVEX_TEST_ADMIN_KEY=$("$binary" keygen admin-key --instance-name "$name" --instance-secret "$secret")
  CONVEX_TEST_URL="http://127.0.0.1:$port"
  CONVEX_TEST_SERVER_KEY=$(python3 -c 'import secrets; print(secrets.token_hex(32))')
  "$binary" --port "$port" --site-proxy-port "$site_port" --instance-name "$name" --instance-secret "$secret" \
    --local-storage "$CONVEX_TEST_DIR/convex-storage" "$CONVEX_TEST_DIR/convex.sqlite3" >"$CONVEX_TEST_DIR/convex.log" 2>&1 &
  CONVEX_TEST_PID=$!
  for attempt in {1..100}; do
    curl -sf "$CONVEX_TEST_URL/version" >/dev/null && break
    if [[ $attempt == 100 ]]; then cat "$CONVEX_TEST_DIR/convex.log" >&2; return 1; fi
    sleep 0.2
  done
  printf 'CONVEX_SELF_HOSTED_URL=%s\nCONVEX_SELF_HOSTED_ADMIN_KEY=%s\n' "$CONVEX_TEST_URL" "$CONVEX_TEST_ADMIN_KEY" >"$CONVEX_TEST_DIR/backend.env"
  chmod 600 "$CONVEX_TEST_DIR/backend.env"
  # Auth signing keys, generated per run.
  local keys
  keys=$(bun -e '
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
const k = await generateKeyPair("RS256", { extractable: true });
const pkcs8 = (await exportPKCS8(k.privateKey)).trimEnd().replace(/\n/g, " ");
console.log(JSON.stringify({ pkcs8, jwks: JSON.stringify({ keys: [{ use: "sig", ...(await exportJWK(k.publicKey)) }] }) }));')
  {
    convex_test env set JWT_PRIVATE_KEY -- "$(jq -r .pkcs8 <<<"$keys")"
    convex_test env set JWKS "$(jq -r .jwks <<<"$keys")"
    convex_test env set SITE_URL "${CONVEX_TEST_SITE_URL:-http://localhost:5174}"
    convex_test env set CHECKOUT_SERVER_KEY "$CONVEX_TEST_SERVER_KEY"
    convex_test env set ALLOW_TEST_FIXTURES true
    if [[ -n "$email_port" ]]; then
      convex_test env set RESEND_API_KEY test-resend-key
      convex_test env set EMAIL_API_URL "http://127.0.0.1:$email_port/emails"
    fi
  } >"$CONVEX_TEST_DIR/convex-env.log" 2>&1
  if ! convex_test deploy --yes >"$CONVEX_TEST_DIR/convex-deploy.log" 2>&1; then
    cat "$CONVEX_TEST_DIR/convex-deploy.log" >&2; return 1
  fi
}

stop_disposable_convex() {
  if [[ -n "${CONVEX_TEST_PID:-}" ]]; then kill "$CONVEX_TEST_PID" 2>/dev/null || true; wait "$CONVEX_TEST_PID" 2>/dev/null || true; fi
}
