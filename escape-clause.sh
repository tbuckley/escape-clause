#!/bin/sh
# Escape Clause — install the broker OUTSIDE the agent's reach, and launch sandboxed sessions.
#
#   escape-clause.sh install          copy the broker into ~/.escape-clause/app + npm install
#   escape-clause.sh init <dir>       create/update <dir>'s config (wizard on a TTY) + stamp it
#   escape-clause.sh launch [dir]     run claude in [dir] (default: cwd) — prints the exact command
#
#   Configuration lives in ~/.escape-clause/configs/<name>.json (plain JSON, one per
#   workspace — edit it, then re-run init to re-stamp; init --reconfigure re-runs the
#   wizard). ESCAPE_CLAUSE_* env vars are deprecated shims: init saves them into a NEW
#   config; launch ignores them. See docs/setup-simplification.md.
#
# Why this exists: the agent's workspace is writable (sandbox + Edit/Write tools), so the
# broker code must not live there — otherwise the agent edits broker.mjs/guard.mjs and its
# code runs with host privileges at the next launch. `install` puts the code under
# ~/.escape-clause, which the sandbox denyRead + guard hook already deny to the agent.
#
# No magic: `init` writes the workspace config (.claude/settings.json, settings.local.json,
# .mcp.json — plain files you can read) from the config file, and `launch` just runs
# `claude` (it prints the exact command first), after VERIFYING the stamp still matches
# what the config would write. It never rewrites anything: on drift it refuses and names
# the exact setting that differs (file tools are guard-blocked and sandboxed bash is
# denyWrite-blocked on these paths, so drift should not happen from inside the box);
# re-running `init` stays a deliberate human step. A tampered config is never what launches.
set -eu

BASE="${ESCAPE_CLAUSE_DIR:-$HOME/.escape-clause}"
APP="$BASE/app"
SRC="$(cd "$(dirname "$0")" && pwd)"

usage() {
  sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

install_app() {
  command -v node >/dev/null || { echo "error: node not found" >&2; exit 1; }
  mkdir -p "$BASE" "$APP"
  chmod 700 "$BASE"
  for f in broker.mjs server.mjs store.mjs policies.mjs proxy.mjs reviewer.mjs guard.mjs expose.mjs setup.mjs ui.html escape-clause.sh package.json; do
    cp "$SRC/$f" "$APP/$f"
  done
  cp "$SRC/templates/CLAUDE.md" "$APP/CLAUDE.md"   # workspace template, stamped by init
  (cd "$APP" && npm install --omit=dev --no-fund --no-audit --loglevel=error)
  PW="$(cd "$APP" && node -e "import('./store.mjs').then(m => console.log(m.uiPassword()))")"

  # One short word on PATH beats typing $APP/escape-clause.sh forever. Symlink only —
  # nothing is copied, so the protected install stays the single code location.
  if [ -t 0 ] && [ ! -e "$HOME/.local/bin/escape-clause" ]; then
    printf "Put 'escape-clause' on your PATH (symlink in ~/.local/bin)? [Y/n] "
    read -r a || a=n
    case "$a" in
      n*|N*) ;;
      *) mkdir -p "$HOME/.local/bin"
         ln -s "$APP/escape-clause.sh" "$HOME/.local/bin/escape-clause" ;;
    esac
  fi
  EC="$APP/escape-clause.sh"
  [ -e "$HOME/.local/bin/escape-clause" ] && EC="escape-clause"

  cat <<EOF

Installed the broker to $APP (agent-inaccessible).

Web UI:    http://127.0.0.1:8790  — sign in with the password below
Password:  $PW
           (file: $BASE/secrets/password — overwrite it to choose your own)

Next, set up an agent workspace (any directory WITHOUT the broker source) and launch:
  $EC init ~/escape-clause-workspace
  $EC launch ~/escape-clause-workspace
EOF
}

launch() {
  [ -f "$APP/broker.mjs" ] || { echo "error: broker not installed — run: $SRC/escape-clause.sh install" >&2; exit 1; }
  WS="${1:-$PWD}"
  # Verify (never rewrite) the stamp against the config file, print the launch info,
  # and get the exact command — setup.mjs refuses with a named diff on drift.
  CMD="$(node "$SRC/setup.mjs" launch-info "$WS")" || exit 1
  cd "$WS"
  # word splitting on $CMD is intentional: it is exactly the printed command
  # shellcheck disable=SC2086
  exec $CMD
}

case "${1:-}" in
  install) install_app ;;
  init)    shift; [ -n "${1:-}" ] || usage; exec node "$SRC/setup.mjs" init "$@" ;;
  launch)  launch "${2:-$PWD}" ;;
  *)       usage ;;
esac
