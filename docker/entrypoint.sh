#!/bin/sh
# aerotrace web | worker | migrate | create-admin | reset-password | export-sample | verify-audit-log
set -e
cmd="${1:-web}"
[ $# -gt 0 ] && shift
case "$cmd" in
  web)
    # Required settings (DATABASE_URL, SESSION_SECRET, or their *_REF secret references) are checked by boot.mjs.
    if [ "${MIGRATE_ON_START:-false}" = "true" ]; then node /app/dist/cli.mjs migrate; fi
    export AEROTRACE_ROLE=web
    exec node /app/dist/boot.mjs /app/server.js ;;
  worker)
    export AEROTRACE_ROLE=worker
    exec node /app/dist/cli.mjs worker ;;
  *)
    exec node /app/dist/cli.mjs "$cmd" "$@" ;;
esac
