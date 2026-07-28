#!/bin/sh
# Escape Clause — install the broker OUTSIDE the agent's reach, and launch sandboxed sessions.
#
#   escape-clause install         copy the broker into ~/.escape-clause/app + npm install
#   escape-clause update          fetch the latest npm release, then re-run install
#   escape-clause init <dir>      create/update <dir>'s config (wizard on a TTY) + stamp it
#   escape-clause launch [dir]    run claude in [dir] (default: cwd) — prints the exact command
#
#   Get the code with `npm install -g escape-clause` (versioned, provenance-signed
#   releases — recommended) or a git clone; either way `install` is what makes it live.
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
# The same rule covers code versions: `launch` refuses when the installed broker's version
# differs from the CLI's — updating stays a deliberate `install`, never a background step.
set -eu

command -v node >/dev/null 2>&1 || { echo "error: node not found (Node 20+ required)" >&2; exit 1; }

BASE="${ESCAPE_CLAUSE_DIR:-$HOME/.escape-clause}"
APP="$BASE/app"
# $0 is a symlink when invoked via npm's bin shim (or the ~/.local/bin symlink), so
# resolve it: SRC must be the real package/clone/install directory, not the bin dir.
SRC="$(node -e 'console.log(require("path").dirname(require("fs").realpathSync(process.argv[1])))' "$0")"

pkg_version() {
  node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version || "unversioned")' "$1"
}

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

install_app() {
  if [ "$SRC" = "$APP" ]; then
    echo "error: this is the protected install itself — run install from the delivery copy" >&2
    echo "       (npm install -g escape-clause, or a git clone), not from $APP" >&2
    exit 1
  fi
  mkdir -p "$BASE" "$APP"
  chmod 700 "$BASE"
  for f in broker.mjs server.mjs store.mjs policies.mjs proxy.mjs reviewer.mjs guard.mjs expose.mjs setup.mjs ui.html escape-clause.sh package.json; do
    cp "$SRC/$f" "$APP/$f"
  done
  cp "$SRC/templates/CLAUDE.md" "$APP/CLAUDE.md"   # workspace template, stamped by init
  (cd "$APP" && npm install --omit=dev --no-fund --no-audit --loglevel=error)
  PW="$(cd "$APP" && node -e "import('./store.mjs').then(m => console.log(m.uiPassword()))")"

  case "$SRC" in
    */node_modules/escape-clause)
      # npm already put `escape-clause` on PATH (its bin shim) — no symlink needed.
      # A clone-era symlink would shadow the npm command with the previous install:
      if [ -L "$HOME/.local/bin/escape-clause" ]; then
        echo "note: ~/.local/bin/escape-clause (from a clone-era install) may shadow the npm"
        echo "      command — if 'escape-clause update' refuses: rm ~/.local/bin/escape-clause"
      fi ;;
    *)
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
      fi ;;
  esac
  EC="$APP/escape-clause.sh"
  command -v escape-clause >/dev/null 2>&1 && EC="escape-clause"

  cat <<EOF

Installed escape-clause v$(pkg_version "$APP/package.json") to $APP (agent-inaccessible).

Web UI:    http://127.0.0.1:8790  — sign in with the password below
Password:  $PW
           (file: $BASE/secrets/password — overwrite it to choose your own)

Next, set up an agent workspace (any directory WITHOUT the broker source) and launch:
  $EC init ~/escape-clause-workspace
  $EC launch ~/escape-clause-workspace
EOF
}

update_app() {
  case "$SRC" in
    */node_modules/escape-clause)
      echo "Fetching the latest release: npm install -g escape-clause@latest"
      npm install -g escape-clause@latest
      # Re-exec through PATH so the freshly installed CLI runs its own install —
      # this running copy may be the version being replaced.
      exec "$(command -v escape-clause || echo "$SRC/escape-clause.sh")" install ;;
    *)
      echo "error: this copy wasn't installed by npm, so update can't fetch releases for it." >&2
      echo "  npm:   npm install -g escape-clause && escape-clause install" >&2
      echo "  clone: git pull && ./escape-clause.sh install" >&2
      exit 1 ;;
  esac
}

launch() {
  [ -f "$APP/broker.mjs" ] || { echo "error: broker not installed — run: escape-clause install" >&2; exit 1; }
  # Code-version drift refuses exactly like config drift: the protected install must
  # match the CLI launching it. `escape-clause install` re-stamps; nothing auto-updates.
  CLI_V="$(pkg_version "$SRC/package.json")"
  APP_V="$(pkg_version "$APP/package.json")"
  if [ "$CLI_V" != "$APP_V" ]; then
    echo "error: installed broker is v$APP_V but this CLI is v$CLI_V — run: escape-clause install" >&2
    exit 1
  fi
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
  update)  update_app ;;
  init)    shift; [ -n "${1:-}" ] || usage; exec node "$SRC/setup.mjs" init "$@" ;;
  launch)  launch "${2:-$PWD}" ;;
  *)       usage ;;
esac
