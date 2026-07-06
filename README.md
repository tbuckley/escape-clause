# Escape Clause

**Run Claude Code in a locked-down sandbox — and give it a safe, human-approved way back out.**

Running an autonomous coding agent usually means picking a bad trade: babysit every
permission prompt, or hand it your machine with `--dangerously-skip-permissions` and
hope. Escape Clause is a third option: the agent works freely inside a box with **no
network and no host access**, and anything it needs from the outside world (run a host
command, fetch a URL) goes through a **broker** — the agent files a request, you review
it in a web UI (with an AI-generated risk summary), and only what you approve actually
runs. Approved results are pushed back into the agent's session so it keeps working
without polling.

![The approval queue: each request shows the exact command, an AI risk summary, and the agent's justification — quarantined as an untrusted claim.](docs/img/approval-ui.png)

```
you (chat UI) ──▶ agent (interactive claude, sandboxed: no network/host)
                     │ needs something outside the box
                     ▼
               broker: files ticket REQ-N ──▶ AI risk summary
you ──▶ approval web UI (login) ──▶ Approve / Deny ──▶ broker executes the approved snapshot
               and pushes the outcome back into the session ──▶ agent wakes, continues
```

The whole thing is a small, readable Node.js codebase — no framework, two dependencies —
built as an exploration of how far you can take agent containment with Claude Code's
own primitives: sandbox settings, hooks, MCP servers, and channels.

A guiding principle: **no magic**. Everything Escape Clause does should be inspectable
and understandable. `init` writes plain JSON config files you can read; `launch` runs a
`claude` command it prints so you can run it yourself; nothing is rewritten behind your
back — when the config doesn't match what `init` would write, launch refuses and tells
you why instead of silently fixing it.

> **Status:** a research exploration / working demo, not a hardened product. It leans on
> Claude Code preview features (plugin channels, `--dangerously-load-development-channels`).
> Last tested with **Claude Code v2.1.202**; re-run the
> [audit](#6-verify-the-sandbox-recommended) after any `claude` upgrade, since upgrades
> can change sandbox behavior. See [Not included (yet)](#not-included-yet) for the
> distance to the fuller design.

## Contents

- [Words you'll meet](#words-youll-meet)
- [What's in the box](#whats-in-the-box)
- [Getting started](#getting-started)
- [Stopping and uninstalling](#stopping-and-uninstalling)
- [Troubleshooting](#troubleshooting)
- [Repo layout](#repo-layout)
- [Going deeper](#going-deeper)
- [Not included (yet)](#not-included-yet)
- [License](#license)

## Words you'll meet

If you use Claude Code casually, a few terms here may be new:

| Term | Meaning |
|---|---|
| **MCP server** | A local process exposing tools an agent can call ([Model Context Protocol](https://modelcontextprotocol.io)). The broker is one. |
| **Channel** | A Claude Code mechanism that can *push* messages into a running session — how approvals wake the agent without polling. See the [channels docs](https://code.claude.com/docs/en/channels-reference). |
| **fakechat** | An off-the-shelf Claude Code plugin channel that serves a local web chat UI — it's how you talk to the sandboxed agent. Not part of this repo. |
| **Broker** | This project's MCP server + channel: files tickets, runs policies, serves the approval UI, pushes outcomes back. |
| **Ticket** | A snapshotted request (`REQ-N`) — the exact command/URL/script captured at request time; approving runs *that snapshot*, not whatever changed since. |
| **Policy** | A named, hash-pinned script with a risk class; `readonly` ones auto-run, risky classes always ticket. |
| **Protected install** | `~/.escape-clause/` — broker code + state, deliberately outside every workspace the agent can touch. |

## What's in the box

- **A hardened sandbox** — network fully denied (all egress routed to a deny-all proxy,
  so there's never a "allow this domain?" prompt), secrets like `~/.ssh` unreadable,
  escape hatches closed.
- **A broker (MCP server)** the agent can use to *request* outside actions. Requests are
  non-blocking tickets; the MCP surface can create and read tickets but — by
  construction — never resolve them.
- **An approval web UI** (password login, live queue) showing the exact command or URL,
  an AI risk summary, and the agent's justification (clearly quarantined as an untrusted
  claim). Approve runs the snapshotted request on the host; Deny sends your message back
  to the agent.
- **A policy engine** — named, hash-pinned scripts with per-class auto-approval, so
  routine read-only things (like "what's the host's uptime?") run instantly with no
  human, while anything with egress or write risk always gets a ticket.
- **Tamper resistance** — the broker installs *outside* the agent's workspace, a
  fail-closed hook blocks file tools from touching protected paths, the sandbox
  deny-writes the workspace's own launch config (so bash can't rewrite it either),
  and every launch verifies the config still matches the protected install — drift
  refuses to launch.
- **An adversarial audit** (`tests/sandbox-audit.mjs`) that ground-truths all of the
  above by actually trying to escape.

You chat with the agent through **fakechat** (a Claude Code plugin channel with a local
web chat UI); the broker handles requests, policies, review, and notifications.

## Getting started

### Prerequisites

- [Claude Code](https://code.claude.com) installed and signed in (last tested with
  v2.1.202 — check yours with `claude --version`)
- Node.js **20 or newer** and npm
- The **fakechat** plugin — install it once from inside any `claude` session:
  ```
  /plugin install fakechat@claude-plugins-official
  ```
- *(Optional)* `ANTHROPIC_API_KEY` in your environment, for AI risk summaries on
  tickets. Without it, tickets simply show "summary unavailable" and you review from
  the raw facts.

### 1. Install the broker

```bash
git clone https://github.com/tbuckley/escape-clause.git
cd escape-clause
./escape-clause.sh install
```

This copies the broker to `~/.escape-clause/app` — deliberately **outside** any
directory the agent can write to — installs its npm dependencies there, and prints the
web UI password (stored at `~/.escape-clause/secrets/password`; overwrite that file to
choose your own).

### 2. Initialize a workspace

Pick (or create) a workspace directory — any directory that does **not** contain the
broker source — and stamp it with the sandbox config:

```bash
~/.escape-clause/app/escape-clause.sh init ~/escape-clause-workspace
```

This writes three plain-JSON files from the protected install — `.claude/settings.json`
(sandbox + permissions + guard hook), `.claude/settings.local.json` (pre-trusts the
broker), `.mcp.json` (the broker server) — and drops a `CLAUDE.md` if the workspace has
none. Read them; that's the whole configuration. Re-run `init` any time to re-stamp.

### 3. Launch a sandboxed session

Run this in a tmux pane or a terminal you'll keep open:

```bash
~/.escape-clause/app/escape-clause.sh launch ~/escape-clause-workspace
```

`launch` verifies the workspace config still matches what `init` would write (refusing
with an explanation if it drifted), then runs `claude` in the workspace — it prints the
exact command, which you can run yourself instead:

```bash
cd ~/escape-clause-workspace
claude --channels plugin:fakechat@claude-plugins-official \
    --dangerously-load-development-channels server:broker
```

On first launch, claude asks you to trust the workspace — accept. A startup line
confirms the broker channel is live: `Channels: server:broker`.

> Tip: if you've launched before, free fakechat's port first —
> `lsof -ti :8787 | xargs kill` — or your first message can vanish into an orphaned
> server from the previous session. Details in
> [Troubleshooting](#fakechat-swallows-your-first-message-after-a-relaunch).

### 4. Open the two UIs

Everything binds to localhost. The full port map:

| Port | What | Who serves it |
|---|---|---|
| [8787](http://localhost:8787) | **fakechat** — chat with the agent | fakechat plugin |
| [8790](http://127.0.0.1:8790) | **approval UI** — sign in with the password from step 1 | broker (`ESCAPE_CLAUSE_UI_PORT` moves it) |
| 8791 | deny-all HTTP proxy (all sandboxed egress dies here) | broker (`ESCAPE_CLAUSE_PROXY_PORT` moves the pair) |
| 8792 | deny-all SOCKS5 proxy (git-ssh, ftp, grpc, rsync) | broker (always HTTP proxy port + 1) |

You only ever open the first two in a browser; the proxies exist to refuse.

### 5. Try it

In fakechat, send:

> Please run the host command: echo hello-from-escape-clause — show me the output.

The agent can't run that itself (sandboxed), so it files a broker request and keeps
going. Watch the ticket appear live in the approval UI: the exact argv, the AI risk
summary, and the agent's justification. Click **Approve once** — the broker runs the
approved snapshot on the host, pushes the outcome into the session, and the agent posts
`hello-from-escape-clause` back into fakechat. **Deny** (with an optional message) feeds
your text back to the agent instead.

Then try the policy engine:

> What's the host's uptime?

The agent calls the seeded `host-info` policy — class `readonly` — so it auto-runs with
no ticket and no human (still audit-logged to `~/.escape-clause/audit.log`). Whereas:

> Fetch https://example.com and summarize it.

uses `fetch-url` — class `public-write`, because network egress means potential
exfiltration — so every run is a ticket showing the exact URL. Finally, ask the agent to
*register* a new policy for something recurring: the proposed script itself arrives as a
ticket, with its full source (and a diff, if it updates an existing policy) for review.

### 6. Verify the sandbox (recommended)

```bash
cd tests
npm install
node sandbox-audit.mjs
```

The audit doesn't trust anyone's self-report — it spawns probe agents that actively try
to escape (curl out, write outside the workspace, read denied paths, disable the
sandbox) and ground-truths every result against decoy files. It launches real agent
sessions, so it takes a few minutes and consumes API tokens. Exits `0` if sound. Re-run
it after every `claude` upgrade, since upgrades can change sandbox behavior. What it
probes, part by part: [tests/README.md](tests/README.md).

## Stopping and uninstalling

- **Stop a session**: exit `claude` (Ctrl+C twice or `/exit`) in the launch terminal.
  The broker, its UIs, and the proxies all run inside that session's process tree and
  die with it. If a fakechat orphan lingers on 8787, kill it:
  `lsof -ti :8787 | xargs kill`.
- **Uninstall**: `rm -rf ~/.escape-clause` removes the broker install and all its state
  (tickets, policies, password, `audit.log`). A workspace stays a normal directory —
  delete its stamped `.claude/`, `.mcp.json`, and `CLAUDE.md` if you want it pristine.

## Troubleshooting

### fakechat swallows your first message after a relaunch

Symptom: you launch a session, open fakechat, send a message — the agent never sees it,
and on refresh the fakechat server is gone.

Cause (a fakechat plugin bug, not an Escape Clause one): fakechat's server doesn't exit
when its claude session ends, so a **previous** session's instance is still holding port
8787. Your new session's fakechat then dies at startup with `EADDRINUSE` (the session
has no chat connection at all), and the UI you opened belongs to the orphan. Your first
message makes the orphan write a notification to its dead session's pipe — `EPIPE`,
unhandled, process crash. That's why the server is "down" afterward: you just killed the
zombie, and the port is now free.

Fix: kill the orphan **before** launching (`lsof -ti :8787 | xargs kill`), or — after
you've already hit it — run `/mcp` in the claude terminal and reconnect fakechat, which
now binds cleanly. Messages sent before the reconnect are lost; resend them.

### Is the sandbox actually on?

Ask the agent to run `env | grep SANDBOX_RUNTIME` — `SANDBOX_RUNTIME=1` only appears
when sandboxed, and `HTTP_PROXY` should point at the deny-all proxy on `:8791`. For real
assurance, run the [audit](#6-verify-the-sandbox-recommended).

### `launch` refuses to start

That's the config verifier working: the stamped workspace config no longer matches what
`init` would write — a stale init, changed `ESCAPE_CLAUSE_*` env vars, or tampering.
Inspect the file it names, then re-run `init` (with the same env you'll launch with).

## Repo layout

| Path | What it is |
|---|---|
| `broker.mjs` | MCP server + channel push + ticket lifecycle + permission relay |
| `server.mjs` | Approval web UI: password login, live queue (SSE), approve/deny |
| `store.mjs` | Durable state under `~/.escape-clause` (tickets, policies, password, `audit.log`) |
| `policies.mjs` | Named scripts, hash-pinned, invoked as `execve` (never a shell) |
| `proxy.mjs` | Deny-all egress proxy the sandbox routes through |
| `reviewer.mjs` | AI risk summaries — one Haiku call per ticket, advisory only |
| `guard.mjs` | Fail-closed `PreToolUse` hook denying file tools on protected paths |
| `escape-clause.sh` | `install` / `init` / `launch` |
| `templates/CLAUDE.md` | Rules-of-the-box instructions stamped into new workspaces |
| `docs/` | Architecture, security model, design docs and proposals |
| `tests/` | The adversarial sandbox audit |

## Going deeper

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — how it works: the launcher and
  config stamping, why the session is interactive (not headless `-p`), sharing request
  links with remote users, the permission relay modes, and the deny-all egress proxy.
- **[docs/SECURITY.md](docs/SECURITY.md)** — the layered security posture: the three
  independent layers keeping the approve path out of the agent's reach, the three
  keeping the broker itself out, and the sharp edges worth knowing (guard hook, MCP
  denylist vs. allowlist, hash pinning).
- **[tests/README.md](tests/README.md)** — what the adversarial audit actually probes.
- **[docs/securing-agent.md](docs/securing-agent.md)** — the motivating essay: why
  containment plus a brokered escape hatch, rather than trust.
- **[docs/PROPOSAL.md](docs/PROPOSAL.md)** and
  **[docs/claude-cli-security-proposal.md](docs/claude-cli-security-proposal.md)** —
  the fuller design this demo is a slice of.

## Not included (yet)

See the proposals above for the fuller design. Not in this demo: file-reference
payloads + CAS ingestion, cooldowns and rate caps, phone push, passkey + tailnet
binding for the UI (the demo uses a password login + session cookie on localhost), the
batch audit digest, and subagent launching.

## License

[MIT](LICENSE).
