#!/bin/sh
# Escape Clause — install the broker OUTSIDE the agent's reach, and launch sandboxed sessions.
#
#   escape-clause.sh install          copy the broker into ~/.escape-clause/app + npm install
#   escape-clause.sh init <dir>       (re)write <dir>'s workspace config from the protected install
#   escape-clause.sh launch [dir]     run claude in [dir] (default: cwd) — prints the exact command
#
# Why this exists: the agent's workspace is writable (sandbox + Edit/Write tools), so the
# broker code must not live there — otherwise the agent edits broker.mjs/guard.mjs and its
# code runs with host privileges at the next launch. `install` puts the code under
# ~/.escape-clause, which the sandbox denyRead + guard hook already deny to the agent.
#
# No magic: `init` writes the workspace config (.claude/settings.json, settings.local.json,
# .mcp.json — plain files you can read) and `launch` just runs `claude` (it prints the exact
# command first), after VERIFYING the config still matches what `init` would write. It never rewrites anything: if
# the config drifted (a stale init, different ESCAPE_CLAUSE_* env than at init, or tampering
# — file tools are guard-blocked and sandboxed bash is denyWrite-blocked on these paths, so
# drift should not happen from inside the box), launch refuses and tells you to re-run
# `init`. A tampered config is never what launches.
set -eu

BASE="${ESCAPE_CLAUSE_DIR:-$HOME/.escape-clause}"
APP="$BASE/app"
SRC="$(cd "$(dirname "$0")" && pwd)"

usage() {
  sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

install_app() {
  command -v node >/dev/null || { echo "error: node not found" >&2; exit 1; }
  mkdir -p "$BASE" "$APP"
  chmod 700 "$BASE"
  for f in broker.mjs server.mjs store.mjs policies.mjs proxy.mjs reviewer.mjs guard.mjs escape-clause.sh package.json; do
    cp "$SRC/$f" "$APP/$f"
  done
  cp "$SRC/templates/CLAUDE.md" "$APP/CLAUDE.md"   # workspace template, stamped by init
  (cd "$APP" && npm install --omit=dev --no-fund --no-audit --loglevel=error)
  PW="$(cd "$APP" && node -e "import('./store.mjs').then(m => console.log(m.uiPassword()))")"
  cat <<EOF

Installed the broker to $APP (agent-inaccessible).

Web UI:    http://127.0.0.1:${ESCAPE_CLAUSE_UI_PORT:-8790}  — sign in with the password below
Password:  $PW
           (file: $BASE/secrets/password — overwrite it to choose your own)

Next, set up an agent workspace (any directory WITHOUT the broker source) and launch:
  $APP/escape-clause.sh init ~/escape-clause-workspace
  $APP/escape-clause.sh launch ~/escape-clause-workspace
EOF
}

# Both init and launch refuse the two directories that would defeat the design.
check_ws() {
  WS="$1"
  if [ -e "$WS/broker.mjs" ] || [ -e "$WS/server.mjs" ]; then
    echo "error: $WS contains the broker source — the agent must not run there." >&2
    echo "Pick an empty/project directory: $APP/escape-clause.sh init ~/escape-clause-workspace" >&2
    exit 1
  fi
  case "$WS/" in "$BASE"/*)
    rmdir "$WS" 2>/dev/null || true  # drop the dir if init just created it
    echo "error: refusing to use the protected store ($BASE) as a workspace" >&2; exit 1 ;;
  esac
}

stamp() {
  TGT="$1"
  mkdir -p "$TGT/.claude"
  # Chat channels are opt-in: if you connect one (ESCAPE_CLAUSE_CHANNELS at launch), its
  # reply tool must be pre-allowed here or it hits the permission prompt (auto-denied when
  # ESCAPE_CLAUSE_RELAY=deny, the stamped default). ESCAPE_CLAUSE_CHANNEL_TOOLS is a
  # comma-separated list of permission entries, e.g. mcp__plugin_fakechat_fakechat.
  ALLOW='"Bash", "Read", "Edit", "Write", "Glob", "Grep", "mcp__broker"'
  if [ -n "${ESCAPE_CLAUSE_CHANNEL_TOOLS:-}" ]; then
    for t in $(printf '%s' "$ESCAPE_CLAUSE_CHANNEL_TOOLS" | tr ',' ' '); do
      ALLOW="$ALLOW, \"$t\""
    done
  fi
  # Sandbox on, egress routed to the deny-all proxy, escape hatch closed, crown jewels +
  # the broker's dir unreadable, and this launch config itself unwritable to sandboxed
  # bash (denyWrite — the guard hook only covers file tools). The guard hook is loaded
  # from the PROTECTED install and fails CLOSED: if it errors or is missing, `|| exit 2`
  # blocks the tool call.
  cat > "$TGT/.claude/settings.json" <<EOF
{
  "enableAllProjectMcpServers": true,
  "permissions": {
    "defaultMode": "default",
    "allow": [$ALLOW],
    "deny": [
      "WebFetch", "WebSearch",
      "mcp__claude_ai_Gmail", "mcp__claude_ai_Google_Calendar", "mcp__claude_ai_Google_Drive"
    ]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "node \"$APP/guard.mjs\" || exit 2" }]
      }
    ]
  },
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "autoAllowBashIfSandboxed": true,
    "allowUnsandboxedCommands": false,
    "excludedCommands": [],
    "network": { "allowedDomains": [], "httpProxyPort": ${ESCAPE_CLAUSE_PROXY_PORT:-8791}, "socksProxyPort": $(( ${ESCAPE_CLAUSE_PROXY_PORT:-8791} + 1 )) },
    "filesystem": {
      "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gcloud", "~/.escape-clause"],
      "denyWrite": ["./.claude", "./.mcp.json", "~/.escape-clause"]
    }
  }
}
EOF
  cat > "$TGT/.claude/settings.local.json" <<'EOF'
{
  "enabledMcpjsonServers": ["broker"]
}
EOF
  cat > "$TGT/.mcp.json" <<EOF
{
  "mcpServers": {
    "broker": {
      "command": "node",
      "args": ["$APP/broker.mjs"],
      "env": {
        "ESCAPE_CLAUSE_RELAY": "${ESCAPE_CLAUSE_RELAY:-deny}",
        "ESCAPE_CLAUSE_UI_URL": "${ESCAPE_CLAUSE_UI_URL:-}"
      }
    }
  }
}
EOF
  [ -f "$TGT/CLAUDE.md" ] || cp "$APP/CLAUDE.md" "$TGT/CLAUDE.md" 2>/dev/null || cp "$SRC/templates/CLAUDE.md" "$TGT/CLAUDE.md"
}

init_ws() {
  mkdir -p "$1"
  WS="$(cd "$1" && pwd)"
  check_ws "$WS"
  stamp "$WS"
  cat <<EOF
initialized $WS — wrote (plain JSON, read them):
  .claude/settings.json        sandbox + permissions + guard hook
  .claude/settings.local.json  pre-trusts the broker MCP server
  .mcp.json                    the broker server + its env
  CLAUDE.md                    rules-of-the-box (only if it was missing)

Launch with: $APP/escape-clause.sh launch $WS
EOF
}

launch() {
  [ -f "$APP/broker.mjs" ] || { echo "error: broker not installed — run: $SRC/escape-clause.sh install" >&2; exit 1; }
  [ -d "$1" ] || { echo "error: no such directory: $1" >&2; exit 1; }
  WS="$(cd "$1" && pwd)"
  check_ws "$WS"
  [ -f "$WS/.claude/settings.json" ] || {
    echo "error: $WS is not an initialized workspace — run: $APP/escape-clause.sh init $WS" >&2; exit 1
  }
  # Verify, don't rewrite: the config must be byte-identical to what init would write
  # right now (same protected install, same ESCAPE_CLAUSE_* env). Drift means tampering
  # or a stale init — either way, re-running init is a deliberate human step.
  TMP="$(mktemp -d)"
  stamp "$TMP"
  for f in .claude/settings.json .claude/settings.local.json .mcp.json; do
    cmp -s "$TMP/$f" "$WS/$f" || {
      rm -rf "$TMP"
      echo "error: $WS/$f is not what 'init' would write with the current environment." >&2
      echo "Changed ESCAPE_CLAUSE_* env, stale init, or tampering — inspect it, then re-stamp:" >&2
      echo "  $APP/escape-clause.sh init $WS" >&2
      exit 1
    }
  done
  rm -rf "$TMP"
  CMD="claude --dangerously-load-development-channels server:broker"
  [ -n "${ESCAPE_CLAUSE_CHANNELS:-}" ] && \
    CMD="claude --channels $ESCAPE_CLAUSE_CHANNELS --dangerously-load-development-channels server:broker"
  cat <<EOF
workspace:   $WS  (config verified against $APP)
approval UI: http://127.0.0.1:${ESCAPE_CLAUSE_UI_PORT:-8790}  — password in $BASE/secrets/password

Talk to the agent right here in this terminal, from claude.ai or the Claude app
(run /remote-control inside the session), or over a chat channel (set
ESCAPE_CLAUSE_CHANNELS — see the README). Chatting remotely — remote control or a
channel? The UI binds to localhost only: expose it on your tailnet with
'tailscale serve --bg ${ESCAPE_CLAUSE_UI_PORT:-8790}' and re-run init with
ESCAPE_CLAUSE_UI_URL set to that address so approval links reach your device.

Launching claude — this is the entire command, run it yourself any time:

  cd $WS
  $CMD

EOF
  cd "$WS"
  # word splitting on $CMD is intentional: it is exactly the printed command
  # shellcheck disable=SC2086
  exec $CMD
}

case "${1:-}" in
  install) install_app ;;
  init)    [ -n "${2:-}" ] || usage; init_ws "$2" ;;
  launch)  launch "${2:-$PWD}" ;;
  *)       usage ;;
esac
