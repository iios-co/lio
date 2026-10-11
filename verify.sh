#!/usr/bin/env bash
# Lio — the single gate for "done". Exits 0 only when everything passes.
#
#   ./verify.sh
#
# Runs: server tests, plugin tests, web-ui tests, both builds, then the
# end-to-end harness that drives the REAL extension in a REAL Chrome against a
# THROWAWAY server and asserts the REAL browser bookmark tree.
#
# Never touches the user's live collection: the harness uses its own DB on
# TEST_PORT and its own Chrome profile.

set -uo pipefail
cd "$(dirname "$0")"

TEST_PORT="${TEST_PORT:-8790}"
SCRATCH="${KIROCREW_SCRATCH:-/tmp}"
FAILED=0
declare -a SUMMARY

step() {
  local name="$1"; shift
  echo ""
  echo "=== $name ==="
  if "$@"; then
    SUMMARY+=("PASS  $name")
  else
    SUMMARY+=("FAIL  $name")
    FAILED=1
  fi
}

# ---- unit / integration suites --------------------------------------------

step "server tests"      bash -c 'cd lio-server && .venv/bin/python -m pytest -q'
step "plugin tests"      bash -c 'cd lio-plugin && npm test --silent'
step "web-ui tests"      bash -c 'cd web-ui && npm test --silent'

# ---- builds (must produce loadable artefacts, not just typecheck) ---------

step "web-ui build"      bash -c 'cd web-ui && npm run build'
step "extension build"   bash -c 'cd lio-plugin && BUILD_BUMP=0 npm run build'

# ---- end-to-end against a real browser -----------------------------------

start_throwaway() {
  local pid
  pid="$(lsof -nP -iTCP:"$TEST_PORT" -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' ')"
  [ -n "$pid" ] && kill $pid 2>/dev/null
  sleep 1.5
  rm -f "$SCRATCH/e2e.db" "$SCRATCH/e2e.db-shm" "$SCRATCH/e2e.db-wal"
  ( cd lio-server && \
    LIO_DB_PATH="$SCRATCH/e2e.db" \
    LIO_ADMIN_USERNAME=admin LIO_ADMIN_PASSWORD=demopass123 \
    nohup .venv/bin/python -m uvicorn lio_server.app:app \
      --host 127.0.0.1 --port "$TEST_PORT" >> "$SCRATCH/e2e_server.log" 2>&1 & )
  for _ in $(seq 1 20); do
    sleep 0.5
    [ "$(curl -s -m2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$TEST_PORT/healthz")" = "200" ] && return 0
  done
  echo "throwaway server did not start on $TEST_PORT"
  return 1
}

stop_throwaway() {
  local pid
  pid="$(lsof -nP -iTCP:"$TEST_PORT" -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' ')"
  [ -n "$pid" ] && kill $pid 2>/dev/null
  return 0
}

step "throwaway server up" start_throwaway
if [ "$FAILED" = "0" ]; then
  step "end-to-end harness" env TEST_PORT="$TEST_PORT" node harness/e2e.mjs
fi
stop_throwaway

# ---- verdict --------------------------------------------------------------

echo ""
echo "================ verify.sh ================"
for line in "${SUMMARY[@]}"; do echo "  $line"; done
echo "=========================================="
if [ "$FAILED" = "0" ]; then
  echo "ALL PASS — objective criteria met."
else
  echo "FAILED — see DEFECTS.md and the harness output above."
fi
exit "$FAILED"
