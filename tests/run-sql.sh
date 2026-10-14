#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Always create a disposable, isolated local database. Never accepts a remote URL.
test_container="movopainel-sql-${BASHPID}"
docker_local() {
  env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
    docker --host=unix:///var/run/docker.sock "$@"
}
test_logs="$(mktemp -d)"
trap 'docker_local rm -f "$test_container" >/dev/null; rm -rf "$test_logs"' EXIT
docker_local run -d --name "$test_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17-alpine >/dev/null
ready=false
for attempt in {1..30}; do
  if docker_local exec "$test_container" pg_isready -U postgres >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [ "$ready" != true ]; then docker_local logs "$test_container"; exit 1; fi
for file in tests/sql/bootstrap.sql supabase/migrations/20261014130000_dashboard_shared_versions.sql tests/sql/shared-dashboard.sql; do
  docker_local exec -i "$test_container" psql -U postgres -v ON_ERROR_STOP=1 < "$file"
done
docker_local exec -i "$test_container" psql -U postgres -v ON_ERROR_STOP=1 < tests/sql/concurrent-first.sql > "$test_logs/first.log" 2>&1 &
first_pid=$!
locked=false
for attempt in {1..30}; do
  if rg -q LOCK_ACQUIRED "$test_logs/first.log"; then locked=true; break; fi
  sleep 0.1
done
if [ "$locked" != true ]; then cat "$test_logs/first.log"; exit 1; fi
if docker_local exec -i "$test_container" psql -U postgres -v ON_ERROR_STOP=1 < tests/sql/concurrent-second.sql > "$test_logs/second.log" 2>&1; then
  echo 'Concurrent stale publication unexpectedly passed' >&2; exit 1
fi
rg -q '40001' "$test_logs/second.log"
wait "$first_pid"
docker_local exec -i "$test_container" psql -U postgres -v ON_ERROR_STOP=1 < tests/sql/reload.sql
