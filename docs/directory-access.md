# Limiting directory access

Which parts of your machine the sandboxed agent can see and touch, how to shrink that
surface, and why the defaults look the way they do. For the overall threat model see
[SECURITY.md](SECURITY.md); for the generic Claude Code knobs (outside Escape Clause)
see [securing-claude-code.md](securing-claude-code.md).

## The two layers (and why both exist)

An agent session touches the filesystem through two very different doors, and each
needs its own lock:

| Door | Enforced by | Configured in |
|---|---|---|
| **Bash commands** (and their child processes) | the OS sandbox (Seatbelt / bubblewrap) | `sandbox.filesystem` in the stamped `.claude/settings.json` |
| **File tools** (`Read`, `Edit`, `Write`, `Grep`, `Glob`, `NotebookEdit`, …) | `guard.mjs`, a fail-closed `PreToolUse` hook loaded from the protected install | the guard's built-in floor + the stamped `.claude/escape-clause-policy.json` |

The split matters because the defaults differ in opposite directions:

- **Sandboxed bash** already can't write outside the workspace (+ its temp dir) — but
  it can **read almost everything** by default, credentials included.
- **File tools run unsandboxed** on the host. Without the guard they can read *and
  write* anywhere your user can. `sandbox.filesystem` does not apply to them at all.

Any rule you care about must therefore land on **both** layers. `init` stamps them
together from the same inputs, and `launch` refuses to start if either file has
drifted from what `init` would write — so the two layers can't silently disagree.

> **"Could the agent add a macOS launch file that runs at boot, outside the sandbox?"**
> Through bash: no — sandboxed bash writes are workspace-only, so
> `~/Library/LaunchAgents/` is unreachable. Through the `Write` tool: it could, before
> this floor existed — the file tools are unsandboxed and pre-allowed. That is exactly
> the hole the guard's persistence floor closes (below), and why "prevent writes to a
> directory" must always mean *both* layers.

## What's always protected (every profile)

**Full deny — read and write, all tools** ("crown jewels"): `~/.ssh`, `~/.aws`,
`~/.gnupg`, `~/.config/gcloud`, `~/.escape-clause` (the broker itself),
`~/.claude.json` + `~/.claude/.credentials.json` (Claude Code's own credentials and
history), and the workspace's `.claude/` + `.mcp.json` (the config that launches the
next session). Bash-side these are `denyRead` entries; file-tool-side they're the
guard's hardcoded floor.

**Write deny — file tools** ("persistence vectors"): paths where a single write means
*your account runs attacker-chosen code outside the sandbox later*. Sandboxed bash
already can't write them; the guard closes the unsandboxed file-tool door:

| Path | Runs your code when… |
|---|---|
| `~/Library/LaunchAgents`, `~/Library/LaunchDaemons` | macOS login/boot (launchd picks up any plist) |
| `~/.config/autostart` | Linux desktop login (XDG autostart) |
| `~/.config/systemd/user`, `~/.local/share/systemd/user` | systemd user units start |
| `~/.bashrc`, `~/.bash_profile`, `~/.bash_login`, `~/.bash_logout`, `~/.profile` | every new bash/sh shell |
| `~/.zshrc`, `~/.zshenv`, `~/.zprofile`, `~/.zlogin`, `~/.zlogout`, `~/.config/fish` | every new zsh/fish shell |
| `~/.local/bin`, `~/bin`, `/usr/local/bin`, `/usr/local/sbin`, `/opt/homebrew/bin`, `/opt/homebrew/sbin` | you run a shadowed command (`git`, `ls`, …) — the package-manager dirs are commonly *user-writable* on macOS |
| `~/.gitconfig`, `~/.config/git` | your next `git` invocation (`core.pager`, hooks, aliases) |
| `~/.claude` | your next `claude` session (user-level hooks execute unsandboxed) |

Reads of these stay allowed in the `default` profile (reading `~/.bashrc` is often
legitimately useful); the stricter profiles hide them along with the rest of `~`.

## Profiles

Pick with `ESCAPE_CLAUSE_PROFILE` at `init` (and keep it set for `launch` — the config
is a function of the env, and launch verifies it):

```bash
ESCAPE_CLAUSE_PROFILE=strict ~/.escape-clause/app/escape-clause.sh init ~/my-workspace
ESCAPE_CLAUSE_PROFILE=strict ~/.escape-clause/app/escape-clause.sh launch ~/my-workspace
```

| | `default` | `strict` | `paranoid` |
|---|---|---|---|
| Crown jewels + persistence floor | ✓ | ✓ | ✓ |
| Everything under `~` hidden (except the workspace itself) | | ✓ | ✓ |
| File tools see only workspace + tmp + system toolchain paths (`/usr`, `/opt`, …) | | | ✓ |
| External volumes hidden from bash (`/Volumes`, `/media`, `/mnt`) | | | ✓ |

**`default`** — trusted-ish work on your own projects. Secrets are unreadable and
persistence is unwritable, but the agent can still read reference material anywhere on
disk (other repos, `/etc`, your dotfiles).

**`strict`** — the "disable all access to `~/` but allow the workspace" posture. Your
home directory — mail stores, browser profiles, `~/Documents`, cloud tokens, message
archives — simply doesn't exist for the agent, even for reading. The workspace is
carved back in on both layers, so it's fine for the workspace to live under `~`:
bash-side via `denyRead: ["~/"]` + `allowRead: ["."]` (the sandbox re-allows inside
denied regions), file-tool-side by the guard's workspace exception. Use for: running or
analyzing untrusted code, long unattended sessions, anything where prompt injection is
a live concern. Caveat: toolchains that keep state in `~` (`~/.npm`, `~/.cargo`,
`~/.cache`) lose read access to it — point their cache/config env vars into the
workspace, or carve specific dirs back in with `ESCAPE_CLAUSE_ALLOW_READ`.

**`paranoid`** — strict, plus the file tools' world shrinks to: the workspace, temp
dirs, and read-only system toolchain paths (`/usr`, `/opt`, `/bin`, `/lib*`,
`/System`, `/Library`, `/Applications`, `/nix`, `/snap`). No `/etc`, no `/var`, no
other users' homes, no other repos. Bash additionally loses `/Volumes`, `/media`,
`/mnt` (external disks and mounts). Builds still work — compilers and installed
packages live in the readable toolchain paths — but the agent can inspect nothing
about the host beyond what it needs to compile. Note: bash keeps `/etc` readable
(denying it breaks TLS bundles, `passwd` lookups, and most commands); the paranoid
read fence on `/etc` applies to the file tools.

## Denying (or re-allowing) specific directories

Three comma-separated lists, applied on both layers, any profile:

```bash
# hide tax records and a second codebase from all reads; block writes to ~/.npmrc
export ESCAPE_CLAUSE_DENY_READ="~/Documents/taxes,~/other-project"
export ESCAPE_CLAUSE_DENY_WRITE="~/.npmrc"
# strict/paranoid only need this to punch read holes: share one extra dir with the agent
export ESCAPE_CLAUSE_ALLOW_READ="~/shared-notes"

~/.escape-clause/app/escape-clause.sh init ~/my-workspace
~/.escape-clause/app/escape-clause.sh launch ~/my-workspace   # same env, or launch refuses
```

Rules:

- Entries are **absolute or `~/`-prefixed** paths (no globs, no relative paths); quotes
  and backslashes are refused rather than escaped. Spaces are fine
  (`~/My Files` works); commas in paths are not.
- `DENY_READ` blocks reads *and* writes (a write into a secret dir is still a leak
  channel); `DENY_WRITE` blocks only writes.
- `ALLOW_READ` carves read-only exceptions out of the profile's read fence. It can
  never re-expose the crown-jewel floor — `init` refuses entries inside (or
  containing) a protected path, and the guard checks its floor first regardless.
- The stamped config is a pure function of these variables: change them → re-run
  `init` → `launch` verifies. An agent can't edit the lists from inside the box (the
  files live under `.claude/`, which is deny-written on both layers).

Where they land — `ESCAPE_CLAUSE_DENY_READ="~/Documents/taxes"` stamps:

```jsonc
// .claude/settings.json — binds sandboxed BASH
"sandbox": { "filesystem": { "denyRead": [..., "~/Documents/taxes"], ... } }

// .claude/escape-clause-policy.json — read by guard.mjs, binds the FILE TOOLS
{ "profile": "default", "readScope": "none", "denyRead": ["~/Documents/taxes"], ... }
```

## Sensitive directories worth considering

The floor covers credentials and persistence. What else you should deny depends on
what's on the machine — candidates for `ESCAPE_CLAUSE_DENY_READ` on a `default`
profile (the stricter profiles hide all of these already, since they're under `~`):

| You care about | macOS | Linux |
|---|---|---|
| Personal documents | `~/Documents`, `~/Desktop`, `~/Downloads`, `~/Pictures` | same |
| Mail / messages | `~/Library/Mail`, `~/Library/Messages` | `~/.thunderbird`, `~/.local/share/evolution` |
| Browser profiles (cookies = logged-in sessions) | `~/Library/Application Support/Google/Chrome`, `~/Library/Safari`, `~/Library/Cookies` | `~/.mozilla`, `~/.config/google-chrome`, `~/.config/chromium` |
| Keychains / password stores | `~/Library/Keychains` | `~/.password-store`, `~/.local/share/keyrings` |
| Cloud sync roots | `~/Library/Mobile Documents` (iCloud), `~/Dropbox`, `~/Google Drive` | `~/Dropbox`, sync roots |
| More credentials | `~/.netrc`, `~/.npmrc`, `~/.docker`, `~/.kube`, `~/.config/gh`, `~/.gem`, `~/.pypirc` | same |
| Other work | other checkouts, `~/src`, backup mounts | same |

And `ESCAPE_CLAUSE_DENY_WRITE` candidates beyond the floor, if you use them:
`~/.tmux.conf` (runs `run-shell` on attach), `~/.vim`/`~/.config/nvim` (autoloaded
vimscript/lua), `~/.emacs.d`, `~/.ipython` (startup files), `~/.npmrc` (registry
redirect on next install).

## Honest limits

- **Non-root assumption.** The guard fences *user-writable* persistence. If you run
  the session as root, system-wide vectors (`/etc`, `/Library/LaunchDaemons`,
  `/etc/cron.d`, …) are writable through file tools and all bets are off. Don't run
  this as root.
- **Persistence by command, not path.** Two distinct cases. *File-backed* mechanisms
  (`crontab -`, `at`) rely on a setuid helper writing a spool under `/var` — inside the
  sandbox that should simply fail: Linux's bubblewrap runs with `no_new_privs`, so
  setuid confers nothing and the spool write is denied like any other out-of-workspace
  write; macOS Seatbelt is inherited across `exec` (setuid included) and denies it too.
  *IPC-based* mechanisms (`launchctl bootstrap`, `systemctl --user`,
  `systemd-run --user`) are the real residual risk: they write **no protected path** —
  the plist/unit can sit in the writable workspace, and the request is a Mach/D-Bus
  message to `launchd`/`systemd`, which run *outside* the sandbox and would spawn the
  payload unsandboxed. Filesystem rules never see a deniable path; what stands in the
  way is the sandbox's IPC policy (Seatbelt `mach-lookup` rules, whether the D-Bus
  socket is mapped into the namespace), which the tests in `tests/` don't currently
  probe — a known, documented gap. (A workspace-plist `bootstrap` doesn't itself
  survive reboot — durable boot persistence still needs the blocked `LaunchAgents`
  drop — but one successful call is immediate unsandboxed execution, which can then
  install persistence on its own.) Treat service-management commands in transcripts as
  red flags.
- **The sandbox's own temp dir is shared ground.** `/tmp` is writable by bash and (by
  design) by file tools; anything else on the machine writing world-readable files to
  `/tmp` is visible to the agent even under `paranoid`.
- **MCP servers run outside the sandbox.** A connected MCP server is its own door to
  the filesystem/network; the guard only sees the *tool call*, and only path-shaped
  arguments (`file_path`, `notebook_path`, `path`). Keep the MCP surface to the broker
  (see [SECURITY.md](SECURITY.md)).
- **`allowRead` is bash-side carve-out, guard-side carve-out — not a bypass.** But it
  is easy to over-grant: every dir you add is more private data inside the box (one
  more leg of the lethal trifecta). Keep the list short and read-mostly.
- **Reads under `default` are broad by design.** If a directory would hurt to leak,
  either deny it explicitly or use `strict` — don't assume the agent won't look.

## Verifying

`node tests/guard-test.mjs` exercises the guard's decisions (floor, profiles,
symlink/`..` laundering, fail-closed on a corrupt policy) in a few seconds with no API
use. The full adversarial audit (`tests/sandbox-audit.mjs`) additionally ground-truths
the stamped config and the launch path — see [tests/README.md](../tests/README.md).
