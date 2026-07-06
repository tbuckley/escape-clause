# Escape Clause

**Run Claude Code in a locked-down sandbox — and give it a safe, human-approved way back out.**

Escape Clause lets an AI agent work autonomously inside a box with **no network and no host
access**, while anything it needs from the outside world (run a host command, fetch a
URL) goes through a **broker**: the agent files a request, you review it in a web UI
(with an AI-generated risk summary), and only what you approve actually runs. Approved
results are pushed back into the agent's session so it can keep working without polling.

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
  fail-closed hook blocks file tools from touching protected paths, and the workspace
  config is re-stamped from the protected install on every launch.
- **An adversarial audit** (`tests/sandbox-audit.mjs`) that ground-truths all of the
  above by actually trying to escape.

You chat with the agent through **fakechat** (a Claude Code plugin channel with a local
web chat UI); the broker handles requests, policies, review, and notifications.

## Getting started

### Prerequisites

- [Claude Code](https://code.claude.com) installed and signed in
- Node.js (any recent version) and npm
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
directory the agent can write to — and prints the web UI password (stored at
`~/.escape-clause/secrets/password`; overwrite that file to choose your own).

### 2. Launch a sandboxed session

Pick (or create) a workspace directory — any directory that does **not** contain the
broker source. Run this in a tmux pane or a terminal you'll keep open:

```bash
~/.escape-clause/app/escape-clause.sh launch ~/escape-clause-workspace
```

On first launch, claude asks you to trust the workspace — accept. A startup line
confirms the broker channel is live: `Channels: server:broker`.

### 3. Open the two UIs

| URL | What it is |
|---|---|
| http://localhost:8787 | **fakechat** — chat with the agent |
| http://127.0.0.1:8790 | **approval UI** — sign in with the password from step 1 |

### 4. Try it

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

### 5. Verify the sandbox (recommended)

```bash
cd tests
node sandbox-audit.mjs
```

The audit doesn't trust anyone's self-report — it spawns probe agents that actively try
to escape (curl out, write outside the workspace, read denied paths, disable the
sandbox) and ground-truths every result against decoy files. Exits `0` if sound. Re-run
it after every `claude` upgrade, since upgrades can change sandbox behavior.

### Known issue: fakechat swallows your first message after a relaunch

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
| `escape-clause.sh` | `install` / `launch` / `stamp` |
| `templates/CLAUDE.md` | Rules-of-the-box instructions stamped into new workspaces |
| `docs/` | Design docs and proposals |
| `tests/` | The adversarial sandbox audit |

## How it works

### The launcher

`escape-clause.sh launch <workspace>` does two things:

1. **(Re)stamps the workspace config** — `.claude/settings.json`,
   `.claude/settings.local.json`, `.mcp.json` — from the protected install, and drops a
   `CLAUDE.md` if the workspace has none. Stamping on *every* launch means a config the
   agent tampered with mid-session (file tools are guard-blocked, but sandboxed bash can
   still write inside its own workspace) is never what actually launches.
2. Execs `claude --channels plugin:fakechat@claude-plugins-official
   --dangerously-load-development-channels server:broker`.

- `--channels plugin:fakechat@...` — the chat surface. fakechat is a plugin channel: it
  ships its own MCP server that serves the web UI on `localhost:8787` and delivers the
  reply tool.
- `--dangerously-load-development-channels server:broker` — promotes the broker MCP
  server to a channel so it can push notifications (custom channels need this flag
  during the research preview). The broker itself loads from the stamped `.mcp.json`
  (`enableAllProjectMcpServers` + the pre-trust in the stamped `settings.local.json`) —
  and its command path points into `~/.escape-clause/app`, not the workspace.

The launcher refuses to run from the broker source tree or from inside the protected
store — the whole point is keeping broker code out of the agent's reach.

The stamped sandbox config lands at `<workspace>/.claude/settings.json` so it
auto-loads — no `--settings` flag needed. You can confirm the sandbox is live by asking
the agent to run `env | grep SANDBOX_RUNTIME` — `SANDBOX_RUNTIME=1` only appears when
sandboxed (and `HTTP_PROXY` should point at the deny-all proxy on `:8791`).

### Why interactive claude (and not headless `-p`)

Pushing an async approve/reject notification into a running session needs the channel
spec, and a *custom* channel plugin **does not activate in headless (`-p`) mode** — its
notifications are silently dropped (verified). In an interactive session it does
activate and deliver, so the full loop works: chat in via fakechat → agent files a
broker request → you approve → the broker pushes a `<channel source="broker">`
notification → the agent wakes and acts on it. (An earlier variant drove headless claude
via the Agent SDK's input stream — see git history for that pattern.)

### Sharing a request with a remote user

When the agent files a ticket it gets back a credential-free `url` (e.g.
`http://127.0.0.1:8790/?req=REQ-2`) and is told to relay it, so a user chatting over
fakechat gets a link straight to that request, which the UI scrolls to and highlights.
On a device that hasn't signed in yet, the link lands on the login form first — enter
the password once and the request is right there. If the UI is reachable off-box
(Tailscale, a tunnel, a domain), set **`ESCAPE_CLAUSE_UI_URL`** when you launch so shared
links resolve for the remote user; it defaults to `http://127.0.0.1:<port>`. The shared
URL is deliberately credential-free — the sandboxed agent never receives the password or
a session, only a pointer to the request.

### Permission relay — answer the terminal's own prompts from the UI

The broker also declares the channel
[permission-relay capability](https://code.claude.com/docs/en/channels-reference#relay-permission-prompts)
(`claude/channel/permission`). When Claude Code itself opens a tool-approval dialog — a
`Bash`/`Write`/`Edit` prompt — it forwards that prompt to the broker, which surfaces it
in the same 8790 queue as a `permission` item (with an AI risk summary). Approve/Deny
there emits the verdict back to Claude Code. The terminal dialog stays open in parallel;
whichever answers first wins, so this is a second way to answer, not an auto-deny.

Set the mode at launch time with `ESCAPE_CLAUSE_RELAY` (the launcher stamps it into the
workspace `.mcp.json` env):

```bash
ESCAPE_CLAUSE_RELAY=forward ~/.escape-clause/app/escape-clause.sh launch ~/escape-clause-workspace
```

| Mode | Behavior |
|---|---|
| `forward` | Surface each relayed prompt in the UI queue and wait for a human verdict. Best when you want to review. |
| `deny` (stamped default) | Auto-deny every relayed prompt immediately — no human, no UI ticket, just an `audit.log` entry. |
| `off` | Don't declare the relay capability at all; prompts stay in the terminal. |

`deny` is the "my allow-list is complete" mode: the stamped `settings.json` already
auto-allows every tool the box is meant to have, so anything that still reaches the
relay is by definition not pre-approved and gets denied without a human. That means your
allow-list must actually be complete — a tool you forgot to allow gets silently denied,
not prompted.

The broker is the right home for this capability and **fakechat is not**: the docs warn
that anyone who can reply through a permission-relaying channel can approve or deny tool
use, so it may only be declared on a channel that authenticates the approver. The
broker's UI is behind a password login; fakechat has no auth, so it must never declare
it.

Note the relay does **not** cover the `SandboxNetworkAccess` prompt (a sandboxed command
reaching an off-allowlist domain) — that never relays in any mode (verified). Killing
those prompts is the deny-all proxy's job, below.

### Deny-all egress proxy

To make network egress fail closed with **no prompt at all**, the broker replaces the
built-in sandbox proxy entirely: `proxy.mjs` is a deny-all HTTP proxy on
`127.0.0.1:8791` plus a deny-all SOCKS5 listener on `8792` for the non-HTTP protocols
the sandbox routes over SOCKS (git-ssh, ftp, grpc, rsync). `ESCAPE_CLAUSE_PROXY_PORT` moves
the pair; SOCKS is always HTTP+1. The stamped `.claude/settings.json` points the sandbox
at both:

```json
{ "sandbox": { "network": { "allowedDomains": [], "httpProxyPort": 8791, "socksProxyPort": 8792 } } }
```

With [`httpProxyPort`/`socksProxyPort`](https://code.claude.com/docs/en/sandboxing#custom-proxy-configuration)
set, all sandboxed traffic routes to the custom proxies and the built-in proxy — and its
"allow this domain?" prompt — is out of the path. The policy is: deny everything,
instantly, audit-logged.

Verified behaviorally, all three states fail closed:

- **proxy up**: sandboxed `curl https://example.com` dies immediately with
  `CONNECT tunnel failed, response 403`; the attempt lands in `broker.log` and
  `audit.log`. No dialog.
- **port dead** (broker crashed): instant `connection refused` — the sandbox still
  routes to the configured port; there is no fallback to the built-in proxy or its
  prompt.
- **second session** (port already held): served by whichever broker got the port —
  which runs the same deny-all policy.

The proxy only ever refuses — it executes nothing and has no approval surface — so
unlike the ticket path there is nothing on it to protect. Legitimate egress still goes
through the broker (`fetch-url` policy or a ticket), where a human reviews the exact
request.

## Security posture

Why the **approve path** is out of the agent's reach — three independent layers:

1. The sandbox routes all egress to the deny-all proxy (empty `allowedDomains` behind
   it), blocking bash from **all** hosts including localhost — so the agent can't even
   reach the approval UI's port (verified by the audit's Part E).
2. The MCP surface has **no resolve tool** — by construction there is no code path from
   an agent-invokable interface to a ticket-state transition. Resolution exists only on
   the web UI's authenticated endpoints.
3. Approve/deny require a **login session**: the password lives in
   `~/.escape-clause/secrets/password` (denyRead- and guard-protected), and the session
   rides in an HttpOnly `SameSite=Lax` cookie the page's JS can't read. Every API route
   (reads included) is session-gated; five wrong passwords locks login for 30 seconds;
   logins and failures land in `audit.log`.

And why the **broker itself** is out of the agent's reach:

4. The broker's code runs from `~/.escape-clause/app` — inside the same denyRead- and
   guard-protected dir as its state — never from the agent's writable workspace. (An
   earlier version kept it in the workspace; the agent could then rewrite the very code
   that executes approvals, and its edits would run with full host privileges at the
   next launch.)
5. The workspace launch config (`.claude/`, `.mcp.json`) is guard-protected against
   file tools **and** re-stamped from the protected install on every launch, so
   pointing `.mcp.json` at a different broker or dropping the sandbox doesn't survive.
6. The guard hook is loaded from the protected install and **fails closed**
   (`node …/guard.mjs || exit 2`): a missing or crashing guard blocks tool calls
   instead of waving them through.

Some details worth knowing:

- **`guard.mjs` (a `PreToolUse` hook)** blocks the native file tools on protected
  paths. Those tools bypass `sandbox.filesystem.denyRead` (which only covers bash), and
  per-tool deny rules are leaky — you'd need `Read()`, `Edit()`, `Write()`, `Grep()`,
  `Glob()`, … and any future tool. The hook is wired with a `*` matcher, so it's a true
  global choke point: it runs before every tool call, resolves the target with
  `realpath` (so a symlink or `..` can't disguise a protected target), and denies — the
  settings equivalent of the Agent SDK's `canUseTool`. Exercised by the audit's Part D.
- **Non-broker MCP is denied by a denylist** (`mcp__claude_ai_Gmail/Calendar/Drive` in
  `permissions.deny`). MCP servers run outside the sandbox, so each connected one is a
  network + private-data path. The stronger posture is an allowlist
  (`--strict-mcp-config --mcp-config .mcp.json`, loading only the vetted broker) — but
  that flag also strips **plugin-provided** MCP servers, and fakechat *is* one, so
  strict mode disables the chat surface entirely. The denylist is genuinely weaker: you
  must name each dangerous server, and one connected later isn't denied by default.
  **Check `/mcp` for anything unexpected and deny it.** (fakechat itself won't appear
  in `/mcp` — channels are listed separately, confirmed by the startup `Channels:`
  line. If you don't need a plugin chat surface, prefer the strict allowlist.)
- **Hash pinning** makes policy review meaningful: policy bytes live only in the
  private store, invoked as `execve(script, args)` — never a shell. A workspace copy the
  agent edits after approval is irrelevant, and an *update* re-enters review with an
  old→new diff (proven by audit Part F).
- **Tickets snapshot the exact argv/script at request time** — the approved bytes are
  what run, not whatever the agent has changed since.

Verify all of it with `node tests/sandbox-audit.mjs` (Parts E–G cover the broker
surface: UI unreachable from the sandbox, hash pinning holds, auto-approve stays in
class).

## Not included (yet)

See `docs/claude-cli-security-proposal.md` and `docs/PROPOSAL.md` for the fuller
design. Not in this demo: file-reference payloads + CAS ingestion, cooldowns and rate
caps, phone push, passkey + tailnet binding for the UI (the demo uses a password login +
session cookie on localhost), the batch audit digest, and subagent launching.
