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

STAGE="$DATA/.staging"
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
