#!/bin/sh
# Escape Clause — install the broker OUTSIDE the agent's reach, and launch sandboxed sessions.
#
#   escape-clause.sh install          copy the broker into ~/.escape-clause/app + npm install
#   escape-clause.sh init <dir>       (re)write <dir>'s workspace config from the protected install
#   escape-clause.sh launch [dir]     run claude in [dir] (default: cwd) — prints the exact command
#
#   Directory access is set at init: ESCAPE_CLAUSE_PROFILE=default|strict|paranoid, plus
#   ESCAPE_CLAUSE_DENY_READ / _DENY_WRITE / _ALLOW_READ — see docs/directory-access.md.
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
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

# Directory-access profile — which read fence init stamps (docs/directory-access.md):
#   default   crown-jewel creds unreadable, persistence vectors unwritable (guard floor)
#   strict    + everything under ~ hidden except the workspace itself
#   paranoid  + file tools see only the workspace, tmp, and system toolchain paths
PROFILE="${ESCAPE_CLAUSE_PROFILE:-default}"
case "$PROFILE" in default|strict|paranoid) ;; *)
  echo "error: ESCAPE_CLAUSE_PROFILE must be 'default', 'strict', or 'paranoid' (got '$PROFILE')" >&2; exit 1 ;;
esac

# The ESCAPE_CLAUSE_DENY_READ/_DENY_WRITE/_ALLOW_READ lists are comma-separated paths,
# each absolute or ~-prefixed. They land verbatim inside stamped JSON, so quotes and
# backslashes are refused rather than escaped — no magic.
check_paths() {  # $1 = env value, $2 = env name (for the error message)
  oldIFS=$IFS; IFS=','; set -f
  for p in ${1:-}; do
    [ -n "$p" ] || continue
    case "$p" in
      *'"'*|*'\'*) echo "error: $2 entry '$p' contains a quote or backslash" >&2; exit 1 ;;
      /*|"~"|"~/"*) ;;
      *) echo "error: $2 entry '$p' must be an absolute or ~-prefixed path" >&2; exit 1 ;;
    esac
  done
  set +f; IFS=$oldIFS
}

# allowRead carves exceptions out of denyRead for SANDBOXED BASH — so an entry that
# contains (or sits inside) a crown-jewel path would quietly re-open it. Refuse instead.
check_allow_read() {
  oldIFS=$IFS; IFS=','; set -f
  for p in ${ESCAPE_CLAUSE_ALLOW_READ:-}; do
    [ -n "$p" ] || continue
    exp="$p"; case "$exp" in "~") exp="$HOME" ;; "~/"*) exp="$HOME/${exp#"~/"}" ;; esac
    while [ "$exp" != "${exp%/}" ]; do exp="${exp%/}"; done   # strip trailing slashes
    [ -n "$exp" ] || exp="/"
    if [ "$exp" = "/" ]; then
      echo "error: ESCAPE_CLAUSE_ALLOW_READ entry '$p' would re-expose the whole filesystem — refusing" >&2; exit 1
    fi
    for j in "$HOME/.ssh" "$HOME/.aws" "$HOME/.gnupg" "$HOME/.config/gcloud" "$BASE" "$HOME/.claude.json" "$HOME/.claude"; do
      case "$exp" in "$j"|"$j"/*)
        echo "error: ESCAPE_CLAUSE_ALLOW_READ entry '$p' is inside protected '$j' — refusing" >&2; exit 1 ;;
      esac
      case "$j" in "$exp"|"$exp"/*)
        echo "error: ESCAPE_CLAUSE_ALLOW_READ entry '$p' would re-expose protected '$j' — refusing" >&2; exit 1 ;;
      esac
    done
  done
  set +f; IFS=$oldIFS
}

# Comma-separated path list -> `, "a", "b"` (JSON items, with a leading separator).
json_items() {
  oldIFS=$IFS; IFS=','; set -f
  for p in ${1:-}; do [ -n "$p" ] && printf ', "%s"' "$p"; done
  set +f; IFS=$oldIFS
}
json_array() { x="$(json_items "${1:-}")"; printf '[%s]' "${x#, }"; }

install_app() {
  command -v node >/dev/null || { echo "error: node not found" >&2; exit 1; }
  mkdir -p "$BASE" "$APP"
  chmod 700 "$BASE"
  for f in broker.mjs server.mjs store.mjs policies.mjs proxy.mjs viewer.mjs reviewer.mjs guard.mjs escape-clause.sh package.json; do
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
  check_paths "${ESCAPE_CLAUSE_DENY_READ:-}" ESCAPE_CLAUSE_DENY_READ
  check_paths "${ESCAPE_CLAUSE_DENY_WRITE:-}" ESCAPE_CLAUSE_DENY_WRITE
  check_paths "${ESCAPE_CLAUSE_ALLOW_READ:-}" ESCAPE_CLAUSE_ALLOW_READ
  check_allow_read
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
  # Profile -> the BASH read fence (sandbox.filesystem; the guard hook mirrors it for
  # file tools via the policy file stamped below). strict/paranoid hide the whole home
  # dir with denyRead "~/" and carve the workspace back in with allowRead "." — the
  # sandbox re-allows inside denied regions, so a workspace under ~ keeps working. The
  # crown-jewel entries stay listed even when "~/" subsumes them: explicit is auditable,
  # and they're what protects the default profile.
  DENY_READ='"~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gcloud", "~/.escape-clause", "~/.claude.json", "~/.claude/.credentials.json"'
  ALLOW_READ=''
  READ_SCOPE=none
  case "$PROFILE" in
    strict)   DENY_READ="\"~/\", $DENY_READ"; ALLOW_READ='"."'; READ_SCOPE=home ;;
    paranoid) DENY_READ="\"~/\", $DENY_READ, \"/Volumes\", \"/media\", \"/mnt\""; ALLOW_READ='"."'; READ_SCOPE=workspace ;;
  esac
  DENY_READ="$DENY_READ$(json_items "${ESCAPE_CLAUSE_DENY_READ:-}")"
  DENY_WRITE='"./.claude", "./.mcp.json", "~/.escape-clause"'
  DENY_WRITE="$DENY_WRITE$(json_items "${ESCAPE_CLAUSE_DENY_WRITE:-}")"
  EXTRA_ALLOW="$(json_items "${ESCAPE_CLAUSE_ALLOW_READ:-}")"
  if [ -n "$ALLOW_READ" ]; then ALLOW_READ="$ALLOW_READ$EXTRA_ALLOW"; else ALLOW_READ="${EXTRA_ALLOW#, }"; fi
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
      "denyRead": [$DENY_READ],
      "allowRead": [$ALLOW_READ],
      "denyWrite": [$DENY_WRITE]
    }
  }
}
EOF
  # File-tool side of the same policy, read by guard.mjs (the sandbox lists above only
  # bind BASH). Holds the profile's read fence + the user's extra deny/allow paths; the
  # workspace carve-out itself is not stored here — the guard derives it from
  # CLAUDE_PROJECT_DIR at call time, which keeps this file byte-identical across
  # workspaces (launch verifies it with the other stamped files). Lives under .claude/,
  # already unwritable to both file tools (guard floor) and sandboxed bash (denyWrite).
  cat > "$TGT/.claude/escape-clause-policy.json" <<EOF
{
  "profile": "$PROFILE",
  "readScope": "$READ_SCOPE",
  "denyRead": $(json_array "${ESCAPE_CLAUSE_DENY_READ:-}"),
  "denyWrite": $(json_array "${ESCAPE_CLAUSE_DENY_WRITE:-}"),
  "allowRead": $(json_array "${ESCAPE_CLAUSE_ALLOW_READ:-}")
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
        "ESCAPE_CLAUSE_UI_URL": "${ESCAPE_CLAUSE_UI_URL:-}",
        "ESCAPE_CLAUSE_VIEWER_PORT": "${ESCAPE_CLAUSE_VIEWER_PORT:-8793}",
        "ESCAPE_CLAUSE_APP_PORTS": "${ESCAPE_CLAUSE_APP_PORTS:-3000}",
        "ESCAPE_CLAUSE_VIEWER_ALLOW": "${ESCAPE_CLAUSE_VIEWER_ALLOW:-}"
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
  .claude/settings.json               sandbox + permissions + guard hook
  .claude/settings.local.json         pre-trusts the broker MCP server
  .claude/escape-clause-policy.json   file-tool directory policy (guard hook input)
  .mcp.json                           the broker server + its env
  CLAUDE.md                           rules-of-the-box (only if it was missing)

directory profile: $PROFILE  (ESCAPE_CLAUSE_PROFILE — see docs/directory-access.md)

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
  for f in .claude/settings.json .claude/settings.local.json .claude/escape-clause-policy.json .mcp.json; do
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
profile:     $PROFILE  (directory access — docs/directory-access.md)
approval UI: http://127.0.0.1:${ESCAPE_CLAUSE_UI_PORT:-8790}  — password in $BASE/secrets/password
app viewer:  http://127.0.0.1:${ESCAPE_CLAUSE_VIEWER_PORT:-8793}+  → agent app port(s) ${ESCAPE_CLAUSE_APP_PORTS:-3000}
             view agent-built web apps ONLY through this proxy — it forces
             Connection-Allowlist/CSP headers so pages can't exfiltrate from your browser

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
