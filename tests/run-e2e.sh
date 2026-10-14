#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
test_container="movopainel-sql-e2e-${BASHPID}"
test_logs="$(mktemp -d)"
fixture_pid=''
app_pid=''
docker_local() {
  env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
    docker --host=unix:///var/run/docker.sock "$@"
}
cleanup() {
  if [ -n "$app_pid" ]; then kill -- "-$app_pid" 2>/dev/null || true; fi
  if [ -n "$fixture_pid" ]; then kill -- "-$fixture_pid" 2>/dev/null || true; fi
  docker_local rm -f "$test_container" >/dev/null 2>&1 || true
  rm -rf "$test_logs"
}
trap cleanup EXIT
for port in 3001 54329; do
  if curl --silent --max-time 1 "http://127.0.0.1:$port" >/dev/null; then
    echo "Port $port already in use; stop only your previous test fixture first." >&2; exit 1
  fi
done
docker_local run -d --name "$test_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17-alpine >/dev/null
ready=false
for attempt in {1..30}; do
  if docker_local exec "$test_container" pg_isready -U postgres >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [ "$ready" != true ]; then docker_local logs "$test_container"; exit 1; fi
for file in tests/sql/bootstrap.sql supabase/migrations/20261014130000_dashboard_shared_versions.sql tests/sql/shared-dashboard.sql; do
  docker_local exec -i "$test_container" psql -U postgres -v ON_ERROR_STOP=1 < "$file" > "$test_logs/sql.log"
done
setsid env DASHBOARD_TEST_CONTAINER="$test_container" bun tests/support/supabase-fixture.ts > "$test_logs/fixture.log" 2>&1 &
fixture_pid=$!
setsid env SUPABASE_URL=http://127.0.0.1:54329 SUPABASE_PUBLISHABLE_KEY=test-public-key bun run dev --host 127.0.0.1 --port 3001 --strictPort > "$test_logs/app.log" 2>&1 &
app_pid=$!
ready=false
for attempt in {1..45}; do
  if curl --fail --silent --max-time 2 http://127.0.0.1:3001/ >/dev/null; then ready=true; break; fi
  sleep 1
done
if [ "$ready" != true ]; then cat "$test_logs/fixture.log" "$test_logs/app.log"; exit 1; fi
node tests/e2e.mjs
node tests/shared-dashboard-regressions.mjs
