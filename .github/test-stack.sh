#!/usr/bin/env bash
# The local Supabase stack CI's jobs and the proof workflow start for the tests: only the database, sign-in (auth),
# the data interface (rest) and the gateway (kong), which are all the tests use, and it fails unless exactly those
# four run. The other services held about 1.8 GB and slowed every start. In a GitHub job (GITHUB_ENV set) it then
# hands the job's later steps the settings the tests read.
set -euo pipefail

test -f supabase/config.toml || supabase init
# -x takes the services' image names (logflare, mailpit, postgres-meta, storage-api), not the container names its
# help lists (analytics, inbucket, meta, storage), which it ignores; the check below catches any that still run.
supabase start -x edge-runtime,imgproxy,logflare,mailpit,postgres-meta,realtime,storage-api,studio,vector

project=$(sed -n 's/^project_id = "\(.*\)"$/\1/p' supabase/config.toml)
running=$(docker ps --format '{{.Names}}' | sed -n "s/^supabase_\(.*\)_${project}\$/\1/p" | sort | tr '\n' ' ')
running=${running% }
if [ "$running" != "auth db kong rest" ]; then
  echo "the local stack runs: ${running:-nothing}; the tests need exactly: auth db kong rest" >&2
  exit 1
fi
echo "the local stack runs exactly: $running"

# The migrations make app_service, the role the product's database access runs as, unable to log in; on a fresh
# stack it gets its throwaway local password here, as `bun run db:reset` gives it (scripts/app-service-login.ts), so
# a job's first step that starts the worker (the browser checks) never relies on a test run having done it first.
docker exec "supabase_db_${project}" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c "alter role app_service with login password 'app_service_local'"

if [ -n "${GITHUB_ENV:-}" ]; then
  eval "$(supabase status -o env | grep -E '^(API_URL|ANON_KEY)=')"
  {
    echo "SUPABASE_URL=$API_URL"
    echo "SUPABASE_ANON_KEY=$ANON_KEY"
    echo "DATABASE_URL=postgresql://app_service:app_service_local@127.0.0.1:54322/postgres"
    echo "LOCAL_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres"
    echo "VAPI_WEBHOOK_SECRET=local-test-secret"
  } >> "$GITHUB_ENV"
fi
