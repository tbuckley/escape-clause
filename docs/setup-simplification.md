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
legitimate way to start a session and the launcher becomes optional sugar. It also
covers a pluggable **exposure provider** interface (tailscale and its successors as
one narrow contract).

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
  "ui": { "port": 8790, "expose": "tailscale" },
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

2. How will you open approval links?
     1) this machine only – links point at http://127.0.0.1:8790   (default)
     2) I have my own URL – you run the tunnel/reverse proxy; paste its address
     3) tailscale         – built-in provider: tailscale serve --bg 8790
     4) custom script     – your own provider in ~/.escape-clause/expose/
   choice [1]:

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

Note what question 2 does *not* do: auto-detect. The wizard never changes behavior
because of what it found on the machine — you choose a provider, and only then does it
*verify* the choice ("tailscale is up, logged in as mybox.…"). Detection confirms a
decision; it never makes one.

### 3. Reaching the UI from other devices: exposure providers

The approval UI always binds loopback — that invariant doesn't move. What varies is
how a URL that reaches it comes to exist, and today that's a hand-rolled side quest
(run `tailscale serve` yourself, export `ESCAPE_CLAUSE_UI_URL`, re-init). Make it a
first-class, pluggable concept instead. In `ui`:

| Config | Meaning |
|---|---|
| *(nothing)* | Links use `http://127.0.0.1:<port>`. The default. |
| `"url": "https://…"` | Static: you own the tunnel/reverse proxy; we just write links. |
| `"expose": "tailscale"` | Built-in provider. |
| `"expose": "script:<name>"` | Your provider: the executable `~/.escape-clause/expose/<name>`. |

One provider contract covers tailscale-alikes, tunnel daemons, and anything not yet
invented:

- The broker starts the provider on the host at startup, with the UI port as its
  argument (and `ESCAPE_CLAUSE_UI_PORT` in env).
- The provider prints the public URL as its **first line of stdout**. That URL is what
  ticket links use.
- Then it either **exits 0** (the tunnel is managed elsewhere — `tailscale serve --bg`
  style) or **stays resident** for the life of the tunnel (`cloudflared tunnel`,
  `ngrok`, `ssh -R` style); the broker supervises resident providers, restarts them on
  crash, and tears them down on shutdown. stderr goes to `broker.log`.

The built-in `tailscale` provider is just this contract implemented internally:
run `tailscale serve --bg <port>`, derive the URL from `tailscale status`. A
`cloudflare` or `ngrok` built-in later is a page of code, and anyone can ship their
own as a script in the meantime without waiting on us.

Security framing: provider scripts live in the protected store, which is the same
trust domain as the broker code itself — the agent can neither write the script nor
the config line that names it. And the contract is deliberately narrow — one job
(produce a URL for one port), one output, named in plain sight in the config — which
is what separates it from the general exec-from-config hook rejected below.

### 4. `doctor`

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
- if the config sets an exposure provider: it's runnable, active, and the URL it
  reports is the one links are using
- channel plugins from the config actually installed

`launch` keeps its hard verification but its error message becomes one line:
`config drift — run: escape-clause doctor <dir>`.

### 5. Command surface after

Matches the comment on the issue, plus a PATH nicety: `install` symlinks
`~/.local/bin/escape-clause` → `$APP/escape-clause.sh` (asking first), so every
subsequent command is the same short word regardless of where it lives:

```
./escape-clause.sh install       # once, from the clone
escape-clause init <dir>         # wizard on a TTY; flags for scripts
escape-clause doctor [dir]       # explain what's wrong, if anything
escape-clause launch [dir]       # verify + print + exec claude (unchanged contract)
```

### 6. Toward not needing the launcher (follow-up, separate issue)

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

This is deliberately phased late: it changes the trust story (verification at session
start instead of before exec) and deserves its own review.

## The DX, end to end

What a user actually types and sees, phases 1–3 landed. Four moments matter: first
contact, day two, changing your mind, and something's wrong.

### First contact (once per machine)

```console
$ git clone https://github.com/tbuckley/escape-clause.git && cd escape-clause
$ ./escape-clause.sh install

Installed the broker to ~/.escape-clause/app (agent-inaccessible).

Web UI:    http://127.0.0.1:8790  — sign in with the password below
Password:  hazel-mint-crater-42
           (file: ~/.escape-clause/secrets/password — overwrite it to choose your own)

Put 'escape-clause' on your PATH (symlink in ~/.local/bin)? [Y/n] y

Next: escape-clause init ~/my-project
```

From here on it's one word from any directory, any shell — no more
`~/.escape-clause/app/escape-clause.sh` paths.

### First workspace (once per project)

```console
$ escape-clause init ~/my-project

Workspace: ~/my-project  (new)

1. How much of your machine should the agent see?
     1) default   – credentials (~/.ssh, ~/.aws, …) hidden; rest of ~ visible
     2) strict    – everything under ~ hidden except this workspace   (recommended)
     3) paranoid  – workspace + system toolchain only
   choice [2]: ⏎

2. How will you open approval links?
     1) this machine only – links point at http://127.0.0.1:8790   (default)
     2) I have my own URL – you run the tunnel/reverse proxy; paste its address
     3) tailscale         – built-in provider: tailscale serve --bg 8790
     4) custom script     – your own provider in ~/.escape-clause/expose/
   choice [1]: 3
   checked: tailscale is up, this machine is mybox.tail1234.ts.net
   approval links will use https://mybox.tail1234.ts.net

3. Connect a chat channel (Telegram, Discord, fakechat, …)? [y/N] ⏎

4. Permission relay for unlisted tools:  deny (recommended) / forward / off  [deny]: ⏎

Saved ~/.escape-clause/configs/my-project.json — plain JSON, edit any time,
then re-run 'escape-clause init ~/my-project' to re-stamp.

Stamped ~/my-project (plain JSON, read them):
  .claude/settings.json               sandbox + permissions + guard hook
  .claude/settings.local.json         pre-trusts the broker MCP server
  .claude/escape-clause-policy.json   file-tool directory policy
  .mcp.json                           the broker server + its env

Launch with: escape-clause launch ~/my-project
```

Thirty seconds, four questions, three of them a bare ⏎. Nothing to export, nothing to
remember, no docs required before the first session — the docs become depth, not
prerequisite.

### Day two, and every day after

```console
$ escape-clause launch ~/my-project

workspace:   ~/my-project  (stamp verified against configs/my-project.json)
profile:     strict          approval UI: https://mybox.tail1234.ts.net
channels:    none            relay: deny

Launching claude — this is the entire command, run it yourself any time:

  cd ~/my-project
  claude --dangerously-load-development-channels server:broker
```

This is the whole story: **one command, any shell, forever.** New terminal, after a
reboot, from a cron job — identical, because the config that decides what launches is
a file, not whatever the shell remembered to export. (Under phase 4, `cd ~/my-project
&& claude` joins this list — the SessionStart hook does the same verification.)

### Changing your mind

Add a channel two weeks in — today this is a plugin install, two exports, a re-init,
and keeping those exports forever. Proposed:

```console
$ escape-clause init ~/my-project --reconfigure
```

Same wizard, seeded with current answers; touch ⏎ through what's unchanged. Or skip
the wizard entirely: edit `~/.escape-clause/configs/my-project.json` in your editor,
then `escape-clause init ~/my-project` re-stamps from it. Both paths end at the same
plain file.

### Something's wrong

```console
$ escape-clause launch ~/my-project
error: workspace stamp doesn't match its config — run: escape-clause doctor ~/my-project

$ escape-clause doctor ~/my-project

  ✓ node v22.3.0 (need ≥ 20)
  ✓ claude v2.1.202 on PATH (last tested: v2.1.202)
  ✓ broker installed, store perms 700, password file present
  ✓ config: configs/my-project.json parses; workspace registered
  ✗ stamp drift: .claude/settings.json differs from config
      config says profile "strict"; stamp was written with "default"
      fix: escape-clause init ~/my-project   (re-stamps from the config)
  ✓ ports: UI 8790 and proxy 8791 held by a live broker
  ✗ expose provider 'tailscale': serve is not active for port 8790
      fix: tailscale serve --bg 8790   (the broker re-runs the provider on restart)

2 problems, 2 fixes printed above.
```

Refusal stays hard (launch never rewrites), but the *explanation* moves to a tool
whose whole job is naming the drifted setting and printing the fix.

### Before and after

| | Today | Proposed |
|---|---|---|
| First session ever | clone, install, read docs, export vars, init, launch | clone, install, wizard, launch |
| Every later session | re-export the same vars, `~/.escape-clause/app/escape-clause.sh launch <dir>` | `escape-clause launch <dir>` |
| Where choices live | your shell history + memory | one JSON file per workspace, agent-inaccessible |
| Add a channel | install plugin, 2 exports, re-init, exports forever | `init --reconfigure`, answer one question |
| Remote approvals | know about tailscale, serve, export URL, re-init | pick a provider in the wizard: your URL, tailscale, or your own script |
| Drift refusal | "not what init would write" — go figure out why | `doctor` names the setting and prints the fix |

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
As a general-purpose hook: rejected — an exec-from-config primitive with no stated
job is the softest target in the system, and impossible to audit ("what does this
line do?" has no bounded answer). But every motivating case turned out to be "get the
approval UI somewhere my other devices can reach," so the proposal keeps the
capability and narrows the contract: exposure providers (§3) are named scripts in the
broker's own trust domain with one job and one output. General pre-launch hooks stay
out; a second *scoped* provider interface can be carved the same way if a real second
need appears.

## Phasing

1. **Config files + registry** — `init` writes them, `stamp`/`launch` read them, env
   vars become warn-and-honor shims. Pure refactor of authority; no UX change yet.
   (Worth moving `stamp` from heredoc-sh into a small `init.mjs` at the same time —
   JSON-in-shell is where the quoting checks live today.)
2. **Interactive wizard** on `init`, flags for non-TTY, `--reconfigure`; the
   `~/.local/bin` symlink in `install`; exposure via static `ui.url` + the built-in
   `tailscale` provider.
3. **`doctor`**, and `launch`'s drift error points at it; custom `script:` exposure
   providers.
4. **Session-start verification hook**, channel-flag upstreaming — separate proposal.

Each phase lands independently and keeps the current commands working.
