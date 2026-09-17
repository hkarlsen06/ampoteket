#!/usr/bin/env bash
# Start and seed an owned disposable Supabase project; never targets an existing DB.
set -euo pipefail
cd "$(dirname "$0")/.."
seed_count=30
seed_check=false
seed_profile=synthetic
seed_selected=false
seed_fixed_api_port=''
seed_fixed_studio_port=''
seed_sigkill=false
while (($#)); do
  case "$1" in
    --count)
      [[ $seed_selected == false ]] || { echo 'Choose only one of --count, --empty or --workshop.' >&2; exit 1; }
      seed_selected=true
      [[ $# -ge 2 && $2 =~ ^[1-9][0-9]*$ ]] || { echo '--count needs an integer from 30 to 10000.' >&2; exit 1; }
      seed_count=$2; shift 2 ;;
    --api-port)
      [[ $# -ge 2 && $2 =~ ^[1-9][0-9]{3,4}$ && $2 -ge 1024 && $2 -le 65535 ]] || { echo '--api-port needs a port from 1024 to 65535.' >&2; exit 1; }
      seed_fixed_api_port=$2; shift 2 ;;
    --studio-port)
      [[ $# -ge 2 && ( $2 =~ ^[1-9][0-9]{3,4}$ && $2 -ge 1024 && $2 -le 65535 || $2 == off ) ]] || { echo '--studio-port needs a port from 1024 to 65535, or off.' >&2; exit 1; }
      seed_fixed_studio_port=$2; shift 2 ;;
    --empty|--workshop)
      [[ $seed_selected == false ]] || { echo 'Choose only one of --count, --empty or --workshop.' >&2; exit 1; }
      seed_selected=true
      seed_profile=${1#--}; shift ;;
    --check) seed_check=true; shift ;;
    --sigkill) seed_sigkill=true; shift ;;
    --help)
      echo 'Usage: ./scripts/seed-test.sh [--count 30..10000 | --empty | --workshop] [--api-port 1024..65535] [--studio-port 1024..65535|off] [--check] [--sigkill]'
      echo 'Starts a separate loopback-only synthetic Supabase project. Ctrl-C removes it.'
      echo '--api-port pins the API port (default: a random free port) so a local HTTPS proxy can target it.'
      echo '--studio-port pins the Studio port (default: a random free port); off disables Studio.'
      echo '--sigkill kills whatever holds the pinned --api-port/--studio-port, then retries instead of exiting.'
      echo '--empty skips synthetic data and creates the local admin test@test.no with password test.'
      echo '--workshop loads unofficial photo-inspired inventory, sample stock and the same local test admin.'
      echo '--check validates repeatability, stock/audit integrity and catalog pagination, then removes it.'
      exit 0 ;;
    *) echo 'Unsupported argument. No database URL or existing project is accepted; see --help.' >&2; exit 1 ;;
  esac
done
[[ ${#seed_count} -le 5 && $seed_count -ge 30 && $seed_count -le 10000 ]] || { echo '--count must be from 30 to 10000.' >&2; exit 1; }
if [[ $seed_profile == empty ]]; then seed_count=0; fi
for executable in docker psql supabase bun python3; do
  command -v "$executable" >/dev/null || { echo "Missing tool: $executable" >&2; exit 1; }
done
[[ $(supabase --version 2>/dev/null) == 2.116.0 ]] || { echo 'Use Supabase CLI 2.116.0.' >&2; exit 1; }
seed_dir=$(mktemp -d /tmp/ampoteket-seed.XXXXXXXX)
seed_project="ampoteket-seed-${seed_dir##*.}"
cleanup() {
  supabase stop --project-id "$seed_project" --network-id "$seed_project" --no-backup >"$seed_dir/stop.log" 2>&1 || true
  docker network rm "$seed_project" >/dev/null 2>&1 || true
  rm -rf "$seed_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 700 "$seed_dir"
# Lets a later run tell a live seed from one whose script died.
echo $$ >"$seed_dir/owner.pid"
mkdir -p "$seed_dir/project/supabase"
cp -r supabase/migrations "$seed_dir/project/supabase/"
read -r seed_api_port seed_db_port seed_shadow_port seed_studio_port < <(python3 - <<'PY'
import socket
sockets = [socket.socket() for _ in range(4)]
for sock in sockets: sock.bind(('127.0.0.1', 0))
print(*(sock.getsockname()[1] for sock in sockets))
for sock in sockets: sock.close()
PY
)
# Read-only diagnostics for an occupied pin: this script never stops other
# processes (it cannot know whether the holder is disposable), it only names
# the suspect so you can Ctrl-C the right terminal yourself. With --sigkill
# the caller explicitly opts into killing the holders instead (see below).
seed_port_hint() {
  echo "Holder of 127.0.0.1:$1 (informational only):" >&2
  ss -ltn 2>/dev/null | grep -F ":$1" >&2 || true
  seed_holders "$1" >&2
}
# Other seed-test.sh processes pinned to this port. Our own subshells carry the
# same arguments, so skip this script and its children.
seed_holders() {
  ps -eo pid,ppid,args 2>/dev/null | grep -F 'seed-test.sh' | grep -F -- "$1" | grep -v grep \
    | awk -v self=$$ -v parent=$PPID '$1 != self && $1 != parent && $2 != self' || true
}
seed_port_free() {
  python3 - "$1" <<'PY'
import socket, sys
sock = socket.socket()
# Like the real listeners: ignore TIME_WAIT leftovers, still refuse a live LISTEN.
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try: sock.bind(('127.0.0.1', int(sys.argv[1])))
except OSError: raise SystemExit(1)
sock.close()
PY
}
# --sigkill: reclaim a pinned port. Old seed-test.sh holders get SIGTERM first
# so their EXIT trap stops their disposable Supabase project (SIGKILL would
# orphan its containers); anything still listening is then SIGKILLed.
seed_kill_port() {
  local port=$1 pid
  local pids=()
  echo "Reclaiming 127.0.0.1:$port (--sigkill)…" >&2
  while read -r pid _; do
    [[ $pid =~ ^[0-9]+$ ]] && pids+=("$pid")
  done < <(seed_holders "$port")
  if ((${#pids[@]})); then
    echo "Stopping old seed holder(s): ${pids[*]}" >&2
    kill -TERM "${pids[@]}" 2>/dev/null || true
    for _ in $(seq 1 30); do
      seed_port_free "$port" 2>/dev/null && return 0
      sleep 1
    done
  fi
  pids=()
  while read -r pid; do
    [[ $pid =~ ^[0-9]+$ ]] || continue
    [[ $pid != $$ && $pid != $PPID ]] || continue
    pids+=("$pid")
  done < <({
    ss -ltnp 2>/dev/null | grep -F ":$port" | grep -o 'pid=[0-9]*' | cut -d= -f2 || true
    lsof -t -i ":$port" -sTCP:LISTEN 2>/dev/null || true
    fuser "$port/tcp" 2>/dev/null | tr -s ' ' '\n' || true
  } | sort -un || true)
  if ((${#pids[@]})); then
    echo "SIGKILLing remaining holder(s) of port $port: ${pids[*]}" >&2
    kill -9 "${pids[@]}" 2>/dev/null || true
    sleep 1
  fi
  seed_port_free "$port" 2>/dev/null
}
# A seed whose script died (SIGKILL, closed terminal, crash) never ran its EXIT
# trap, so its containers keep the pinned ports through Docker's root-owned
# proxy. Stop such disposable projects the way that trap would, on every start.
# A seed whose script is still running is never touched here (see --sigkill).
seed_reap_orphans() {
  local project workdir dir pid
  while IFS=' ' read -r project workdir; do
    [[ $project == ampoteket-seed-* ]] || continue
    dir=${workdir%/project}
    [[ $dir == /tmp/ampoteket-seed.* && $dir != "$seed_dir" ]] || continue
    if [[ -r $dir/owner.pid ]]; then
      pid=$(<"$dir/owner.pid")
      [[ $pid =~ ^[0-9]+$ ]] && ps -p "$pid" -o args= 2>/dev/null | grep -qF seed-test.sh && continue
    elif [[ -n $(seed_holders seed-test.sh) ]]; then
      continue # Started before owner.pid existed; only reap when no seed runs.
    fi
    echo "Stopping orphaned seed project $project" >&2
    supabase stop --project-id "$project" --network-id "$project" --no-backup >/dev/null 2>&1 || true
    docker network rm "$project" >/dev/null 2>&1 || true
    rm -rf "$dir"
  done < <(docker ps --format '{{.Label "com.supabase.cli.project"}} {{.Label "com.supabase.cli.workdir"}}' 2>/dev/null | sort -u)
}
seed_reap_orphans
seed_claim_port() {
  local name=$1 port=$2
  if seed_port_free "$port" 2>/dev/null; then return 0; fi
  if [[ $seed_sigkill == true ]]; then
    seed_kill_port "$port" || { echo "--$name $port is still in use after --sigkill." >&2; seed_port_hint "$port"; return 1; }
    return 0
  fi
  echo "--$name $port is already in use." >&2
  seed_port_hint "$port"
  return 1
}
if [[ -n $seed_fixed_api_port ]]; then
  seed_claim_port api-port "$seed_fixed_api_port" || exit 1
  seed_api_port=$seed_fixed_api_port
fi
seed_exclude='realtime,storage-api,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor'
seed_studio_config='enabled = false'
if [[ $seed_fixed_studio_port != off ]]; then
  if [[ -n $seed_fixed_studio_port ]]; then
    seed_claim_port studio-port "$seed_fixed_studio_port" || exit 1
    seed_studio_port=$seed_fixed_studio_port
  fi
  # Studio needs postgres-meta for its SQL editor; both stay inside the
  # loopback-only project network. Off with --studio-port off.
  seed_exclude='realtime,storage-api,imgproxy,mailpit,edge-runtime,logflare,vector,supavisor'
  seed_studio_config="enabled = true
port = $seed_studio_port"
  if [[ $seed_api_port == 54329 ]]; then
    # The api.dev.ampoteket.no Caddy block targets exactly this API port, so
    # point the Studio frontend at that same-origin HTTPS name instead of the
    # loopback URL. Otherwise a browser on another machine would call its own
    # loopback. Other pins keep the CLI default (loopback-only Studio).
    seed_studio_config="$seed_studio_config
api_url = \"https://api.dev.ampoteket.no\""
  fi
fi
cat >"$seed_dir/project/supabase/config.toml" <<EOF
project_id = "$seed_project"
[api]
port = $seed_api_port
schemas = ["public"]
extra_search_path = ["public", "extensions"]
max_rows = 100
[db]
port = $seed_db_port
shadow_port = $seed_shadow_port
major_version = 17
[db.seed]
enabled = false
[auth]
site_url = "http://localhost:5174"
enable_signup = false
[auth.email]
enable_signup = true
enable_confirmations = false
[studio]
$seed_studio_config
[inbucket]
enabled = false
[storage]
enabled = false
[realtime]
enabled = false
[edge_runtime]
enabled = false
[analytics]
enabled = false
EOF
echo "Starting a separate disposable Supabase project ($seed_profile data)…"
docker network create --driver bridge --opt com.docker.network.bridge.host_binding_ipv4=127.0.0.1 "$seed_project" >/dev/null
if ! supabase start --workdir "$seed_dir/project" --network-id "$seed_project" \
  -x "$seed_exclude" \
  >"$seed_dir/start.log" 2>&1; then
  echo 'Disposable Supabase startup failed. No existing project was changed.' >&2
  exit 1
fi
supabase status --workdir "$seed_dir/project" -o json >"$seed_dir/status.json" 2>"$seed_dir/status.log"
bun scripts/seed-test-run.ts "$seed_dir" "$seed_count" "$seed_check" "$seed_profile"
if [[ $seed_check == false ]]; then
  echo 'Keep this terminal running. Ctrl-C removes only this synthetic project and its data.'
  # read also works without a TTY; a timed wait lets termination clean up promptly.
  while true; do sleep 1; done
fi
