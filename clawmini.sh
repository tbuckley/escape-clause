#!/bin/sh
# Clawmini — install the broker OUTSIDE the agent's reach, and launch sandboxed sessions.
#
#   clawmini.sh install          copy the broker into ~/.clawmini-demo/app + npm install
#   clawmini.sh launch [dir]     stamp [dir] (default: cwd) as an agent workspace and run claude
#   clawmini.sh stamp <dir>      just (re)write the workspace config, don't launch
#
# Why this exists: the agent's workspace is writable (sandbox + Edit/Write tools), so the
# broker code must not live there — otherwise the agent edits broker.mjs/guard.mjs and its
# code runs with host privileges at the next launch. `install` puts the code under
# ~/.clawmini-demo, which the sandbox denyRead + guard hook already deny to the agent.
# `launch` re-stamps the workspace's .claude/settings.json and .mcp.json from here on
# EVERY launch, so even if the agent tampered with them mid-session (the guard blocks file
# tools; bash inside the workspace is the residual gap), the tampered config is never what
# actually launches.
set -eu

BASE="${CLAWMINI_DIR:-$HOME/.clawmini-demo}"
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
  for f in broker.mjs server.mjs store.mjs policies.mjs proxy.mjs reviewer.mjs guard.mjs clawmini.sh package.json; do
    cp "$SRC/$f" "$APP/$f"
  done
  cp "$SRC/templates/CLAUDE.md" "$APP/CLAUDE.md"   # workspace template, stamped by launch
  (cd "$APP" && npm install --omit=dev --no-fund --no-audit --loglevel=error)
  PW="$(cd "$APP" && node -e "import('./store.mjs').then(m => console.log(m.uiPassword()))")"
  cat <<EOF

Installed the broker to $APP (agent-inaccessible).

Web UI:    http://127.0.0.1:${CLAWMINI_UI_PORT:-8790}  — sign in with the password below
Password:  $PW
           (file: $BASE/secrets/password — overwrite it to choose your own)

Next, launch a session from an agent workspace (any directory WITHOUT the broker source):
  mkdir -p ~/clawmini-workspace && $APP/clawmini.sh launch ~/clawmini-workspace
EOF
}

stamp() {
  WS="$1"
  mkdir -p "$WS/.claude"
  # Sandbox on, egress routed to the deny-all proxy, escape hatch closed, crown jewels +
  # the broker's dir unreadable. The guard hook is loaded from the PROTECTED install and
  # fails CLOSED: if it errors or is missing, `|| exit 2` blocks the tool call.
  cat > "$WS/.claude/settings.json" <<EOF
{
  "enableAllProjectMcpServers": true,
  "permissions": {
    "defaultMode": "default",
    "allow": ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "mcp__broker", "mcp__plugin_fakechat_fakechat"],
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
    "network": { "allowedDomains": [], "httpProxyPort": ${CLAWMINI_PROXY_PORT:-8791}, "socksProxyPort": $(( ${CLAWMINI_PROXY_PORT:-8791} + 1 )) },
    "filesystem": { "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gcloud", "~/.clawmini-demo"] }
  }
}
EOF
  cat > "$WS/.claude/settings.local.json" <<'EOF'
{
  "enabledMcpjsonServers": ["broker"]
}
EOF
  cat > "$WS/.mcp.json" <<EOF
{
  "mcpServers": {
    "broker": {
      "command": "node",
      "args": ["$APP/broker.mjs"],
      "env": {
        "CLAWMINI_RELAY": "${CLAWMINI_RELAY:-deny}",
        "CLAWMINI_UI_URL": "${CLAWMINI_UI_URL:-}"
      }
    }
  }
}
EOF
  [ -f "$WS/CLAUDE.md" ] || cp "$APP/CLAUDE.md" "$WS/CLAUDE.md" 2>/dev/null || cp "$SRC/templates/CLAUDE.md" "$WS/CLAUDE.md"
}

launch() {
  [ -f "$APP/broker.mjs" ] || { echo "error: broker not installed — run: $SRC/clawmini.sh install" >&2; exit 1; }
  mkdir -p "$1"
  WS="$(cd "$1" && pwd)"
  # The whole point is keeping the broker source out of the agent's workspace — refuse to
  # launch from the source tree or from inside the protected store.
  if [ -e "$WS/broker.mjs" ] || [ -e "$WS/server.mjs" ]; then
    echo "error: $WS contains the broker source — the agent must not run there." >&2
    echo "Pick an empty/project directory: $APP/clawmini.sh launch ~/clawmini-workspace" >&2
    exit 1
  fi
  case "$WS/" in "$BASE"/*)
    rmdir "$WS" 2>/dev/null || true  # drop the dir if we just created it
    echo "error: refusing to use the protected store ($BASE) as a workspace" >&2; exit 1 ;;
  esac
  stamp "$WS"
  echo "workspace: $WS  (config re-stamped from $APP)"
  echo "approval UI: http://127.0.0.1:${CLAWMINI_UI_PORT:-8790}  — password in $BASE/secrets/password"
  cd "$WS"
  exec claude \
    --channels plugin:fakechat@claude-plugins-official \
    --dangerously-load-development-channels server:broker
}

case "${1:-}" in
  install) install_app ;;
  stamp)   [ -n "${2:-}" ] || usage; mkdir -p "$2"; stamp "$(cd "$2" && pwd)"; echo "stamped $2" ;;
  launch)  launch "${2:-$PWD}" ;;
  *)       usage ;;
esac
