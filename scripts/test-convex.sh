#!/usr/bin/env bash
# Backend acceptance tests against a disposable Convex backend (the Convex
# counterpart of the former PostgreSQL harness): its own local backend on free
# ports with a fresh instance secret, convex/ deployed with type checking,
# tests/convex/ run through the native client, then everything deleted.
# Needs Bun with installed dependencies, python3, curl and jq. The backend
# binary comes from the Convex CLI cache; a first
# `CONVEX_AGENT_MODE=anonymous bunx convex dev --once` downloads it.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/convex-backend.sh
test_dir=$(mktemp -d /tmp/ampoteket-convex-test.XXXXXXXX)
trap 'stop_disposable_convex; rm -rf "$test_dir"' EXIT
email_port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
start_disposable_convex "$test_dir" "$email_port"
TEST_CONVEX_URL="$CONVEX_TEST_URL" TEST_CONVEX_ADMIN_KEY="$CONVEX_TEST_ADMIN_KEY" TEST_EMAIL_PORT="$email_port" \
  TEST_CHECKOUT_SERVER_KEY="$CONVEX_TEST_SERVER_KEY" bun test tests/convex --timeout 60000
