#!/bin/bash
# Staged dependency bootstrap — never let a failed npm install destroy a
# working node_modules tree, and never depend on Claude Code env/placeholder
# substitution (observed live: ${CLAUDE_PLUGIN_DATA} reaching processes
# unexpanded). The script locates everything itself:
#   ROOT = plugin dir (parent of this script's dir)
#   DATA = $CLAUDE_PLUGIN_DATA when provided and expanded, else the canonical
#          ~/.claude/plugins/data/greymatter-greymatter
# Install goes into .staging, gets a load check, then swaps in. On any failure
# the current tree stays intact and the marker stays stale (retry next session).
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${CLAUDE_PLUGIN_DATA:-}"
case "$DATA" in ''|*'${'*) DATA="$HOME/.claude/plugins/data/greymatter-greymatter" ;; esac

mkdir -p "$DATA"

# The marker is DATA/package.json, and it may only be trusted when DATA actually holds
# a usable tree. Checking the marker alone was a silent permanent break (measured
# 2026-09-12): running from a repo checkout took the shortcut below, stamped the marker,
# and installed nothing into DATA — because the checkout's own entrypoints resolve
# through ROOT/../node_modules and do not need DATA at all. Every later run, including
# the cache install that resolves ONLY through DATA, then found a matching marker and
# exited early. Result: the MCP server never got its dependencies and failed to connect
# for good, with no error anywhere, because bootstrap reported success every time.
if diff -q "$ROOT/package.json" "$DATA/package.json" >/dev/null 2>&1 \
   && [ -f "$DATA/node_modules/better-sqlite3/package.json" ]; then
  exit 0
fi

# Repo checkout / full install already ships node_modules — nothing to do, but ONLY
# once DATA is populated too. While DATA is still empty there is real work left: the
# cache-installed MCP server and hooks cannot see the checkout's tree.
if [ -f "$ROOT/node_modules/better-sqlite3/package.json" ] \
   && [ -f "$DATA/node_modules/better-sqlite3/package.json" ]; then
  cp "$ROOT/package.json" "$DATA/package.json"
  exit 0
fi

# Concurrency. Two sessions starting at once run this hook twice within the same second,
# and both used the same .staging path (measured 2026-09-12 from npm logs: one run
# `exit 0`, the other `exit -39` on the identical cwd). Each run's `rm -rf "$STAGE"`
# wiped the other's tree mid-install, so both finished with nothing and DATA stayed
# empty — a plugin reinstall followed by a session restart still left the MCP server
# without dependencies, and the hook reported success both times.
#
# Lock first (mkdir is atomic), then stage under a per-process path so two runs can
# never share a directory even if the lock is ever bypassed.
LOCK="$DATA/.bootstrap.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  # Fresh lock: another run owns the install. Leave it alone — it either finishes, or
  # the marker stays unwritten and the next session retries. Stale lock (killed run,
  # older than 10 minutes): take it over, otherwise one crash blocks bootstrap forever.
  if [ -z "$(find "$LOCK" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then
    exit 0
  fi
  rm -rf "$LOCK"
  mkdir "$LOCK" 2>/dev/null || exit 0
fi

STAGE="$DATA/.staging.$$"
# Release the lock and drop the staging tree on every exit path, including the early
# `exit 0`s below — a leaked lock would stall bootstrap for ten minutes at a time.
trap 'rm -rf "$STAGE" "$LOCK"' EXIT

rm -rf "$STAGE"
mkdir -p "$STAGE"
cp "$ROOT/package.json" "$STAGE/" || exit 0

if ! (cd "$STAGE" && npm install --omit=dev --no-audit --no-fund); then
  echo "greymatter bootstrap: npm install failed — keeping existing node_modules" >&2
  rm -rf "$STAGE"
  exit 0
fi

# Load check mirrors what hooks + mcp-server actually require.
if ! NODE_PATH="$STAGE/node_modules" node -e "require('better-sqlite3'); require('@modelcontextprotocol/sdk/server')"; then
  echo "greymatter bootstrap: installed tree failed load check — keeping existing node_modules" >&2
  rm -rf "$STAGE"
  exit 0
fi

rm -rf "$DATA/node_modules.old"
[ -d "$DATA/node_modules" ] && mv "$DATA/node_modules" "$DATA/node_modules.old"
mv "$STAGE/node_modules" "$DATA/node_modules"
cp "$STAGE/package.json" "$DATA/package.json"
rm -rf "$DATA/node_modules.old" "$STAGE"
exit 0
