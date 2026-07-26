# Proposal: simplifying setup (issue #16)

Today a correct setup is three commands from two different locations, up to eleven
`ESCAPE_CLAUSE_*` environment variables, a scary-looking `claude` flag, and — for
remote use — a Tailscale side-quest plus a re-init. Worse, the env vars are not just
inputs but *identity*: `launch` re-derives the config from the current environment and
byte-compares it against the stamp, so a user who exported `ESCAPE_CLAUSE_PROFILE=strict`
in one shell and launches from another gets a refusal that reads like tampering. The
configuration is correct, durable, and verifiable — it just lives in the most ephemeral
place we could have picked.

This proposes moving workspace configuration into **named, human-readable config files
in the protected store** (`~/.escape-clause/configs/<name>.json`), fed by an
**interactive question-by-question `init`**, checked by a **`doctor`** command, and —
longer term — verified by a **SessionStart hook** so that plain `claude` becomes a
legitimate way to start a session and the launcher becomes optional sugar.

## What setup costs today

| Step | Commands / knowledge required |
|---|---|
| Install | `git clone` + `./escape-clause.sh install` (from the clone) |
| Configure | Read three docs; export the right subset of 11 env vars |
| Init | `~/.escape-clause/app/escape-clause.sh init <dir>` (from the install) |
| Launch | `escape-clause.sh launch <dir>` — **with the same env exported**, forever |
| Channels | Install a plugin inside a session, export two more vars, re-init, re-launch |
| Remote UI | Run `tailscale serve`, export `ESCAPE_CLAUSE_UI_URL`, re-init, re-launch |

Failure modes we've built for ourselves:

- **Env drift is the #1 footgun.** The stamp is derived from ambient env at both init
  and launch. New terminal, new machine login, a forgotten `export` — launch refuses
  with a message that can't distinguish "you forgot a variable" from "the agent
  tampered with the config".
- **Nothing records what a workspace's configuration *is*.** The stamped JSON encodes
  the *result* (deny lists, ports) but not the *intent* (profile name is in
  `escape-clause-policy.json`, but channels, UI URL, and relay mode are scattered
  across `.mcp.json` and the launch-time environment).
- **Every choice must be made up front by reading documentation.** There is no moment
  where the tool asks "do you want the agent to see your home directory?" in plain
  language.

## Constraints — what must not break

1. **The trust anchor stays outside the box.** Whatever file becomes the source of
   truth must be unreadable and unwritable to the agent. `~/.escape-clause` already is
   (sandbox `denyRead` + guard floor + `chmod 700`).
2. **Verify, don't rewrite.** `launch` must still refuse drifted workspace config
   rather than silently fixing it. This proposal *strengthens* that check: the
   reference becomes a durable protected file instead of whatever env the shell
   happens to have.
3. **No magic.** Config stays plain JSON you can read and edit by hand; the wizard is
   a convenience that writes it, not a layer that hides it. The printed-`claude`-command
   rule stays.
4. **No new dependencies.** Node 20+ and two runtime deps is the whole footprint. That
   rules YAML out (see alternatives) and keeps the wizard in plain `readline`.

## Proposal

### 1. Named config files in the protected store

The issue's own suggestion, and the right one:

```
~/.escape-clause/
  configs/<name>.json     # one per workspace — THE source of truth
  workspaces.json         # registry: absolute workspace path -> config name
```

Example `configs/thesis.json` — every field optional except `workspace`, defaults
matching today's:

```json
{
  "workspace": "~/escape-clause-workspace",
  "profile": "strict",
  "relay": "deny",
  "ui": { "port": 8790, "url": "https://mybox.tail1234.ts.net" },
  "proxyPort": 8791,
  "channels": [
    {
      "spec": "plugin:fakechat@claude-plugins-official",
      "tools": ["mcp__plugin_fakechat_fakechat"]
    }
  ],
  "paths": { "denyRead": [], "denyWrite": [], "allowRead": [] }
}
```

- `init` writes this file (from the wizard or flags), then stamps the workspace from
  it — same stamped files as today, byte-for-byte.
- `launch` resolves cwd through `workspaces.json`, re-derives the stamp **from the
  config file**, and byte-compares as today. Env no longer participates: same shell,
  different shell, cron job — identical result. A drift error now really means a stale
  init or tampering.
- The channel `--channels` spec moves into the config too, so the launch command no
  longer depends on `ESCAPE_CLAUSE_CHANNELS` being exported.
- `ESCAPE_CLAUSE_*` env vars become one-release deprecation shims: `init` accepts them
  as defaults for wizard answers (and warns), `launch` ignores them (and warns if set).
  `ESCAPE_CLAUSE_DIR` alone survives — it locates the store itself, so it can't live
  inside it.

Security note: this is a strict improvement, not a trade. The config it protects is the
same data the env vars carried; it now sits behind the same `denyRead`/guard/`chmod 700`
fence as the tickets and secrets, instead of in shell state the user can misplace. The
same-bytes verification model is untouched.

### 2. Interactive `init`

`escape-clause init <dir>` on a TTY with no flags walks through the choices in plain
language, one at a time, defaults pre-selected:

```
Workspace: ~/escape-clause-workspace  (new)

1. How much of your machine should the agent see?  [directory profile]
     1) default   – credentials (~/.ssh, ~/.aws, …) hidden; rest of ~ visible
     2) strict    – everything under ~ hidden except this workspace   (recommended)
     3) paranoid  – workspace + system toolchain only
   choice [2]:

2. Will you approve requests from another device (phone/laptop)?
     Approval links default to http://127.0.0.1:8790, which only works on this
     machine. If you'll chat remotely, expose the UI on your tailnet:
       tailscale serve --bg 8790
   detected: tailscale is running, this machine is mybox.tail1234.ts.net
   run 'tailscale serve' and use that URL? [Y/n]:

3. Connect a chat channel (Telegram, Discord, fakechat, …)? [y/N]:
     (asks for the plugin spec + reply tool, or picks from known plugins)

4. Permission relay for unlisted tools:  deny (recommended) / forward / off  [deny]:

Saved ~/.escape-clause/configs/escape-clause-workspace.json — plain JSON, edit any time
(then re-run init to re-stamp). Stamped the workspace. Next:

  escape-clause launch ~/escape-clause-workspace
```

Non-interactive paths keep working for scripts and docs: `init <dir> --profile strict
--ui-url https://…` answers questions from flags; `init <dir> --defaults` takes every
default; `init <dir>` with an existing config re-stamps silently (today's behavior) and
`init <dir> --reconfigure` re-runs the wizard seeded with current values.

The tailscale question is the "auto-start tailscale" ask from the issue, scoped
honestly: if `tailscale` is on PATH and logged in we offer to run `tailscale serve
--bg <port>` and write the resulting URL into the config; if not, we print the two
commands to run later. We don't install or babysit tailscale — one arbitrary
pre-launch hook is a temptation we should resist in a security tool (an attacker-owned
line in a config file that we exec on the host would be the softest target in the
system).

### 3. `doctor`

The owner's comment on #16 suggests exactly this, and it pairs naturally with the
config file — verification gets a home that *explains* instead of refusing:

```
escape-clause doctor [dir]
```

checks, with a fix-it line per failure:

- node ≥ 20, `claude` on PATH and its version vs. the last-tested version
- broker installed at `$BASE/app`, store perms `700`, password file present
- workspace registered, config file parses, stamp matches config (the launch check,
  but with a diff of *which* file and *which* setting drifted)
- UI/proxy ports free or already held by a live broker
- if `ui.url` is set: tailscale up, serve active for the port
- channel plugins from the config actually installed

`launch` keeps its hard verification but its error message becomes one line:
`config drift — run: escape-clause doctor <dir>`.

### 4. Command surface after

Matches the comment on the issue, plus a PATH nicety: `install` symlinks
`~/.local/bin/escape-clause` → `$APP/escape-clause.sh` (asking first), so every
subsequent command is the same short word regardless of where it lives:

```
./escape-clause.sh install       # once, from the clone
escape-clause init <dir>         # wizard on a TTY; flags for scripts
escape-clause doctor [dir]       # explain what's wrong, if anything
escape-clause launch [dir]       # verify + print + exec claude (unchanged contract)
```

### 5. Toward not needing the launcher (follow-up, separate issue)

"I still don't love that we have to use Escape Clause to launch all of this."
The launcher does exactly two things: drift verification, and the
`--dangerously-load-development-channels server:broker` flag.

- **Verification can move into the session.** A stamped `SessionStart` hook (loaded
  from the protected install, fail-closed like the guard) can perform the same
  config-vs-stamp comparison when *any* `claude` starts in the workspace, and block
  the session with the doctor message on drift. Then plain `claude` is safe — the
  launcher stops being load-bearing.
- **The flag is an upstream constraint.** Channels currently load only via CLI flag;
  the broker MCP server side already loads from `.mcp.json`. If/when Claude Code
  supports channel config in `settings.json`, the stamp covers it and `launch` becomes
  pure convenience (a printed reminder of the command, as the no-magic rule always
  intended). Until then the wizard can offer to append a per-workspace shell alias.

This is deliberately phased last: it changes the trust story (verification at session
start instead of before exec) and deserves its own review.

## Alternatives considered

**Config file in the workspace** (`escape-clause.json` next to `.claude/`). Natural
git-ergonomics, but the workspace is enemy territory: we'd have to add it to both deny
layers, and even then the source of truth sits inside the fence it defines — a
config-drives-fence loop we'd forever be re-auditing. The stamped files already are the
in-workspace representation; the authority belongs outside. Rejected.

**One global config with per-workspace overrides** (`~/.escape-clause/config.json`).
Fewer files for the single-workspace case, but merging global + override sections is
exactly the implicit behavior the no-magic rule bans, and multi-workspace users (the
ones with the most config) get the worst of it. A registry of small whole files is
simpler to read, diff, and verify. Rejected.

**YAML for the config.** More comment-friendly, but it's a parser dependency and a
famously surprising spec (`no` → `false`) in the one file where surprise is a security
bug. Plain JSON with good field names, a wizard that writes it, and `doctor` to check
it covers the readability goal. If comments prove essential, JSON with a tolerated
`"//"` key costs nothing. Rejected for now.

**No config file — smarter flags** (`launch --profile strict` auto-restamps on
change). Keeps every current problem (choices live in the user's head/history) and
adds a worse one: launch rewriting config on mismatch is precisely the "silently fix
drift" behavior we refuse today. Rejected.

**Web-based first-run setup in the approval UI.** Attractive later (the broker already
serves a UI, and editing a config could live there), but it inverts the bootstrap: the
UI exists only after install/init, and a terminal wizard is strictly less machinery.
Worth revisiting as a *config editor* once the file format exists. Deferred.

**An arbitrary user command run from `~/.escape-clause` at launch** (from the issue).
Maximum flexibility, but it's an exec-from-config primitive on the host — the exact
shape of hole this project exists to close. The tailscale integration above covers the
motivating case with a named, auditable behavior instead. Rejected.

## Phasing

1. **Config files + registry** — `init` writes them, `stamp`/`launch` read them, env
   vars become warn-and-honor shims. Pure refactor of authority; no UX change yet.
   (Worth moving `stamp` from heredoc-sh into a small `init.mjs` at the same time —
   JSON-in-shell is where the quoting checks live today.)
2. **Interactive wizard** on `init`, flags for non-TTY, `--reconfigure`; the
   `~/.local/bin` symlink in `install`.
3. **`doctor`**, and `launch`'s drift error points at it. Tailscale detect/offer.
4. **Session-start verification hook**, channel-flag upstreaming — separate proposal.

Each phase lands independently and keeps the current commands working.
