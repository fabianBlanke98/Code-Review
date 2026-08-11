#!/usr/bin/env bash
# Boots a throwaway Postgres cluster, applies the migration and runs the RLS
# tests against it. No Docker, no Supabase CLI, nothing left behind.
#
#   ./supabase/tests/run.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS="$HERE/../migrations"

PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
if [[ ! -x "$PGBIN/initdb" ]]; then
  echo "postgres server binaries not found; set PGBIN to the directory holding initdb" >&2
  exit 1
fi

PGDATA="$(mktemp -d)/pgdata"
SOCKET="$(mktemp -d)"
PORT="${PGPORT:-54329}"

# Postgres refuses to run as root. If we are root, do the work as a plain user.
RUNAS=""
if [[ "$(id -u)" -eq 0 ]]; then
  RUNAS="mosaic_test"
  id -u "$RUNAS" >/dev/null 2>&1 || useradd -m "$RUNAS"
  chown -R "$RUNAS" "$(dirname "$PGDATA")" "$SOCKET"
fi

run() {
  if [[ -n "$RUNAS" ]]; then su "$RUNAS" -c "$*"; else bash -c "$*"; fi
}

cleanup() {
  run "$PGBIN/pg_ctl -D $PGDATA -m immediate stop" >/dev/null 2>&1 || true
  rm -rf "$(dirname "$PGDATA")" "$SOCKET"
}
trap cleanup EXIT

echo "==> initdb"
run "$PGBIN/initdb -D $PGDATA -U postgres --auth=trust" >/dev/null

echo "==> starting postgres on port $PORT"
run "$PGBIN/pg_ctl -D $PGDATA -o '-p $PORT -k $SOCKET -c listen_addresses=' -w start" >/dev/null

export PGHOST="$SOCKET" PGPORT="$PORT" PGUSER=postgres PGDATABASE=postgres
psql_q() { psql -v ON_ERROR_STOP=1 -q --no-psqlrc "$@"; }

echo "==> applying auth shim"
psql_q -f "$HERE/00_auth_shim.sql" >/dev/null

echo "==> applying migrations"
for f in "$MIGRATIONS"/*.sql; do
  echo "    $(basename "$f")"
  psql_q -f "$f" >/dev/null
done

echo "==> loading test helpers"
psql_q -f "$HERE/01_helpers.sql" >/dev/null

echo "==> running RLS tests"
psql -v ON_ERROR_STOP=1 -q --no-psqlrc -f "$HERE/02_rls.sql" 2>&1 \
  | grep -Ev '^(SET|GRANT|INSERT|UPDATE|DELETE|CREATE|DO)$' \
  | sed 's/^psql:.*NOTICE:  //'
