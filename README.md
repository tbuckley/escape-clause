# Clawmini — a sandboxed claude with a human-approval broker

**claude runs normally** in an interactive session (e.g. in `tmux`), fully sandboxed
(no network, no host access), and the broker is **just a plugin** — one stdio MCP server
that also implements the channel spec. It exposes escalation tools, runs a **policy
engine** (named scripts with per-class auto-approval), serves an **approval web UI**
with **AI risk summaries**, and **pushes async approve/reject notifications** back into
the session. It does not drive claude.

Chat is via the **fakechat** channel; the broker handles requests, policies, review,
and notifications.

Repo layout: broker source + `clawmini.sh` at the root, the workspace `CLAUDE.md`
template in `templates/`, design docs in `docs/`, and the behavioral audit in `tests/`.

## Why interactive (and not `-p`)

Pushing an async notification into a running session needs the channel spec. A *custom*
channel plugin **does not activate in headless (`-p`) mode** — its notifications are
silently dropped (verified). In an **interactive** session it *does* activate and
deliver. Verified end-to-end here: chat in via fakechat → agent files a broker request →
you approve → the broker pushes a `<channel source="broker">` notification → the agent
wakes and acts on it. (An earlier SDK-driver variant that drove headless claude via the
Agent SDK's input stream lived in this repo as `example/` — see git history if you need
that pattern.)

## Run it

**One-time install** — puts the broker where the agent can't touch it and prints the UI
password (prereq: install fakechat once with `/plugin install fakechat@claude-plugins-official`
inside claude):

```bash
./clawmini.sh install     # copies the broker to ~/.clawmini-demo/app + npm install
```

**Launch** — from an agent workspace, i.e. any directory that does **not** contain the
broker source (the launcher refuses the source tree and the protected store). Do this in
a tmux pane so it keeps running:

```bash
~/.clawmini-demo/app/clawmini.sh launch ~/clawmini-workspace
```

`launch` does two things:

1. **(Re)stamps the workspace config** — `.claude/settings.json`, `.claude/settings.local.json`,
   `.mcp.json` — from the protected install, and drops a `CLAUDE.md` if the workspace has
   none. Stamping on *every* launch means a config the agent tampered with mid-session
   (file tools are guard-blocked, but sandboxed bash can still write inside its own
   workspace) is never what actually launches.
2. Execs `claude --channels plugin:fakechat@claude-plugins-official
   --dangerously-load-development-channels server:broker`.

- `--channels plugin:fakechat@...` — the chat surface. fakechat is a **plugin channel**:
  it ships its own MCP server (`bun … start`, tools `reply`/`edit_message`) that both
  serves the web UI on `localhost:8787` and delivers the reply tool.
- `--dangerously-load-development-channels server:broker` — promotes the broker MCP server
  to a channel so it can push notifications (custom channels need this flag during the
  research preview). The broker itself loads from the stamped `.mcp.json` automatically
  (`enableAllProjectMcpServers` + the pre-trust in the stamped `settings.local.json`) —
  and its command path points into `~/.clawmini-demo/app`, not the workspace.

**Why the broker must not live in the workspace:** the workspace is agent-writable by
design (sandboxed bash + the allowed `Edit`/`Write` tools). If `broker.mjs`/`guard.mjs`
sat there — as an earlier version of this example had it — the agent could rewrite the
very code that executes approvals and enforces the guard, and its edits would run with
full host privileges at the next launch. The install dir sits under `~/.clawmini-demo`,
which the sandbox `denyRead` and the guard hook already deny to the agent, and the guard
hook itself is loaded from that protected path **fail-closed** (`node …/guard.mjs || exit 2`:
if the guard is missing or crashes, the tool call is blocked, not waved through).

> **Why not `--strict-mcp-config --mcp-config .mcp.json`?** An earlier version of this doc
> launched with those flags to make MCP an *allowlist* (only the vetted broker server
> loads). That is **incompatible with the fakechat plugin channel**: `--strict-mcp-config`
> ignores *all* MCP config except the named file — **including plugin-provided servers** —
> so it strips fakechat's own MCP server, and the chat surface (and its 8787 UI) never
> starts. Because fakechat delivers its tools *as* a plugin MCP server, you cannot both
> strict-allowlist MCP and run it. So this example uses the **denylist** instead: the
> `mcp__claude_ai_*` entries in `permissions.deny` (see below). That is genuinely weaker —
> you must name each dangerous server, and a server you connect *later* isn't denied by
> default — so check `/mcp` for anything unexpected, and deny it. If you don't need a
> plugin chat surface (e.g. an SDK-driver setup where MCP is controlled in code), the
> strict-allowlist posture is still the stronger choice.

Then open the **approval UI** at `http://127.0.0.1:8790` and **sign in** with the
password from `~/.clawmini-demo/secrets/password` (printed by `install`; overwrite the
file with your own to change it). Login mints a 30-day session carried in an **HttpOnly
`SameSite=Lax` cookie** — page JS never sees a credential, and every API route (reads
included) requires the session, so an unauthenticated visitor gets a login form, not a
ticket list. Five wrong passwords locks login for 30 seconds; logins and failures land in
`audit.log`. For **AI risk summaries** on tickets, have `ANTHROPIC_API_KEY` set in the
environment you launch `claude` from (the broker inherits it and makes one Haiku call per
ticket). No key → tickets simply show "summary unavailable" and you review from the raw
facts.

**Sharing a request with a remote user.** When the agent files a ticket it gets back a
credential-free `url` (e.g. `http://127.0.0.1:8790/?req=REQ-2`) and is told to relay it,
so a user chatting in over fakechat/Telegram gets a link straight to that request, which
the UI scrolls to and highlights. On a device that hasn't signed in yet the link lands on
the login form first — enter the password once and the request is right there, actionable.
If the UI is reachable off-box (Tailscale, a tunnel, a domain), set **`CLAWMINI_UI_URL`**
when you run `clawmini.sh launch` (it's stamped into the broker's `.mcp.json` env) so the
shared link resolves for the user; it defaults to `http://127.0.0.1:<port>`. The shared
URL is deliberately **credential-free** — the sandboxed agent never receives the password
or a session, only a pointer to the request.

The stamped sandbox config lands at **`<workspace>/.claude/settings.json`** so it
auto-loads — no `--settings` flag needed. (A plain `settings.json` in the workspace root
is *not* auto-loaded, which would silently run with no sandbox at all. The audit's Part C
verifies the sandbox actually engages on a stamped launch.) You can confirm it's live by
asking the agent to run `env | grep SANDBOX_RUNTIME` — `SANDBOX_RUNTIME=1` only appears
when sandboxed (and `HTTP_PROXY` should point at the deny-all proxy on `:8791`).

On first launch claude asks you to trust the workspace — accept. A startup line confirms
the channel: `Channels: server:broker`.

## Test it

Open **http://localhost:8787** (fakechat) and send:

> Please run the host command: echo hello-from-plugin — show me the output.

The agent replies that it filed a broker request and keeps going (non-blocking). In the
**approval UI** (port 8790) the ticket appears live: the exact argv, the AI risk summary
(when ready), and the agent's justification — visually quarantined as an untrusted
claim. Click **Approve once**. The broker runs the snapshot on the host and pushes the
outcome; the agent wakes and posts `hello-from-plugin` back into fakechat. **Deny** with
an optional message feeds your text back to the agent instead.

Policies, in the same chat:

> What's the host's uptime?

The agent calls `request_action({policy: "host-info"})` — class `readonly`, so it
auto-runs with **no ticket and no human**, and the answer comes straight back (the run
still lands in `~/.clawmini-demo/audit.log`). Then:

> Fetch https://example.com and summarize it.

`fetch-url` is class `public-write` (network egress = potential exfil), so every run is
a ticket — the UI shows the exact URL for review. Finally, ask the agent to *register* a
new policy for something recurring: the proposed script itself arrives as a ticket, with
the full source (and a diff, if it updates an existing policy) rendered for review.

## Permission relay — answer the terminal's own prompts from the UI

The broker also declares the channel [permission-relay capability](https://code.claude.com/docs/en/channels-reference#relay-permission-prompts)
(`claude/channel/permission`). When **Claude Code itself** opens a tool-approval dialog —
a `Bash`/`Write`/`Edit` prompt — it forwards that prompt to the broker, which surfaces it
in the **same 8790 queue** as a `permission` item (with an AI risk summary). Approve/Deny
there emits the verdict back to Claude Code. The terminal dialog stays open in parallel;
**whichever answers first wins**, so this is a second way to answer, not an auto-deny.

**What the relay does NOT cover:** the `SandboxNetworkAccess` prompt (a sandboxed command
reaching an off-allowlist domain) is never relayed — the docs scope relay to *tool-use
approvals*, and we confirmed behaviorally that no domain prompt ever reaches the broker in
any relay mode. Suppressing those prompts is the [deny-all egress proxy](#deny-all-egress-proxy)'s
job, which kills them at the source.

This is why the broker is the right home for it and **fakechat is not**: the docs warn
that *anyone who can reply through the channel can approve or deny tool use*, so the
capability may only be declared on a channel that authenticates the approver. The broker's
UI is behind a password login; fakechat has no auth, so it must never declare it.

### Relay mode (`CLAWMINI_RELAY`)

Set it at launch time — the launcher stamps it into the workspace `.mcp.json` env:

```bash
CLAWMINI_RELAY=forward ~/.clawmini-demo/app/clawmini.sh launch ~/clawmini-workspace
```

| Mode | Behavior |
|---|---|
| `forward` | Surface each relayed prompt in the UI queue and wait for a human verdict. Best for the demo / when you want to review. |
| `deny` (stamped default) | **Auto-deny every relayed prompt immediately** — no human, no UI ticket, just an `audit.log` entry. |
| `off` | Don't declare the relay capability at all; prompts stay in the terminal (pre-relay behavior). |

(The broker binary's own fallback when the variable is unset is `forward`; the launcher
stamps `deny` because the stamped settings already allow every tool the box is meant to
have.)

**`deny` is the "my allow-list is complete" mode.** The premise: your `settings.json`
already auto-allows every tool you care about (`Bash`, `Read`, `Edit`, … and the
broker/fakechat MCP tools), so *anything that still reaches the relay is by definition not
pre-approved* and gets denied without a human. Note this denies **anything** unapproved
that reaches the relay, so your allow-list must be complete — a tool you forgot to allow
gets silently denied, not prompted. It does **not** affect the `SandboxNetworkAccess`
domain prompts, which never relay; see the next section for those.

## Deny-all egress proxy

The one prompt the relay can't touch is `SandboxNetworkAccess` — the dialog the built-in
sandbox proxy opens when a sandboxed command reaches a domain not in `allowedDomains`. To
make network egress **fail closed with no prompt at all**, the broker replaces that proxy
entirely: `proxy.mjs` is a deny-all HTTP proxy on `127.0.0.1:8791` plus a deny-all SOCKS5
listener on `8792` for the non-HTTP protocols the sandbox routes over SOCKS (git-ssh via
`ProxyCommand`, ftp, grpc, rsync). `CLAWMINI_PROXY_PORT` moves the pair; SOCKS is always
HTTP+1. `.claude/settings.json` points the sandbox at both:

```json
{ "sandbox": { "network": { "allowedDomains": [], "httpProxyPort": 8791, "socksProxyPort": 8792 } } }
```

With [`httpProxyPort`/`socksProxyPort`](https://code.claude.com/docs/en/sandboxing#custom-proxy-configuration)
set, all sandboxed traffic routes to the custom proxies and the built-in proxy — and its
prompt — is out of the path. (Leave `socksProxyPort` unset and non-HTTP protocols still
route to the *built-in* SOCKS proxy, which can prompt — check `env | grep -i proxy` in a
sandboxed shell to see the wiring.) The per-host decision is ours, and the policy is:
deny everything, instantly, audit-logged.

Verified behaviorally, all three states fail closed:

- **proxy up**: sandboxed `curl https://example.com` dies immediately with
  `CONNECT tunnel failed, response 403`; the attempt lands in `broker.log`
  (`PROXY DENY CONNECT example.com:443`) and `audit.log` (`proxy_denied`). No dialog.
- **port dead** (broker crashed): instant `connection refused` — the sandbox still routes
  to the configured port and there is no fallback to the built-in proxy or its prompt.
- **second session** (port already held): that broker's proxy logs `EADDRINUSE` and the
  session is served by whichever broker got the port — which runs the same deny-all policy.

The proxy only ever refuses — it executes nothing and has no approval surface — so unlike
the ticket path there is nothing on it to protect. Legitimate egress still goes through
the broker (`fetch-url` policy or a ticket), where a human reviews the exact request.

## How it works

```
you (fakechat UI) ──▶ agent (interactive claude, sandboxed: no network/host)
                         │ outside-VM need ──▶ request_action / register_policy   [broker tools]
                         │                       auto class ──▶ runs now, output inline
                         ▼                       review class ─▶ { ticket, pending }
                   broker: pending REQ-N ──▶ AI risk summary (Haiku, broker-owned)
   you ─▶ web UI (127.0.0.1:8790 + login) ─▶ Approve/Deny ─▶ broker executes the SNAPSHOT
                   and PUSHES <channel source="broker" ticket="REQ-N" verdict="…"> ─▶ agent wakes,
                   replies via fakechat
```

- `broker.mjs` — MCP server + channel push + ticket lifecycle + permission relay.
  Resolution exists **only** on the web UI's authenticated endpoints; the MCP surface can
  create and read tickets, never resolve them. It also handles
  `notifications/claude/channel/permission_request` (Claude Code's relayed tool prompts)
  and emits the `…/permission` verdict when you answer in the UI.
- `store.mjs` — durable state under `~/.clawmini-demo` (tickets, policies, the UI
  password + login sessions, append-only `audit.log`), a path the sandbox + guard hook
  deny to the agent. Tickets snapshot the exact argv/script at request time — the
  approved bytes are what run.
- `policies.mjs` — named scripts pinned by sha256 in the private store, invoked as
  `execve(script, args)` (never a shell). Seeds `host-info` (readonly) and `fetch-url`
  (public-write).
- `server.mjs` — the web UI: password login → HttpOnly session cookie, live queue (SSE),
  raw facts first, AI summary as an advisory panel, agent claim quarantined, POST-only
  approve/deny — every API route session-gated.
- `proxy.mjs` — deny-all egress proxy the sandbox routes through (`httpProxyPort`):
  refuses every CONNECT/request instantly, audit-logged, no prompt. Fail-closed even when
  down. The broker is the only way out of the box.
- `reviewer.mjs` — one direct API call per ticket, verified facts only, strict JSON
  schema, cached by content hash. Advisory, never load-bearing.
- `clawmini.sh` — `install` copies all of the above to `~/.clawmini-demo/app`
  (agent-inaccessible); `launch` re-stamps the workspace's `.mcp.json` /
  `.claude/settings.json` from there (register + pre-trust the broker; sandbox on with
  network routed to the deny-all proxy, so the agent *must* use the broker to leave the
  box) and execs claude.
- `guard.mjs` — `PreToolUse` hook (loaded from the protected install, fail-closed): one
  global choke point denying file tools on protected paths — the crown-jewel dirs,
  `~/.clawmini-demo` (store **and** broker code), and the workspace's own launch config.
- `templates/CLAUDE.md` — tells the agent the rules of the box (stamped into new
  workspaces; it lives in `templates/` so it isn't picked up as *this* repo's
  project instructions).

## Security posture

Why the approve path is out of the agent's reach — three independent layers:

1. the sandbox routes all egress to the deny-all proxy (`httpProxyPort`, empty
   `allowedDomains` behind it), blocking bash from **all** hosts including localhost
   (verified; re-proven by the audit's Part E against the live UI port);
2. the **MCP surface has no resolve tool** — by construction there is no code path from
   an agent-invokable interface to a ticket-state transition;
3. approve/deny require a **login session**: the password lives in
   `~/.clawmini-demo/secrets/password` (denyRead- and guard-protected), and the session
   rides in an HttpOnly cookie the page's JS can't read.

And why the **broker itself** is out of the agent's reach:

4. the broker's code runs from `~/.clawmini-demo/app` — inside the same denyRead- and
   guard-protected dir as its state — never from the agent's writable workspace;
5. the workspace launch config (`.claude/`, `.mcp.json`) is guard-protected against file
   tools **and** re-stamped from the protected install on every launch, so pointing
   `.mcp.json` at a different broker or dropping the sandbox doesn't survive;
6. the guard hook is loaded from the protected install and **fails closed**
   (`node …/guard.mjs || exit 2`): a missing or crashing guard blocks tool calls instead
   of waving them through.

The sandbox is hardened (network denied, escape hatch closed via
`allowUnsandboxedCommands: false`, `denyRead` on crown-jewel paths). Interactive claude
has no `canUseTool` backstop, so containment rests entirely on the settings:
- **`guard.mjs` (a `PreToolUse` hook)** blocks the native file tools on protected paths.
  These tools bypass `sandbox.filesystem.denyRead` (which only covers bash), and per-tool
  deny rules are leaky — you'd need `Read()`, `Edit()`, `Write()`, `Grep()`, `Glob()`, …
  and any future tool. The hook is wired with a `*` matcher, so it is a true global choke
  point: it runs before *every* tool call, resolves the target path with `realpath` (so a
  workspace symlink or `..` can't disguise a protected target), and denies — the settings
  equivalent of the Agent SDK's `canUseTool`. Its behavioral denial is exercised by the
  audit's Part D.
- **Non-broker MCP is denied by a denylist** (`mcp__claude_ai_Gmail/Calendar/Drive` in
  `permissions.deny`). MCP servers run outside the sandbox, so each connected one is a
  network + private-data path. The stronger posture is an *allowlist* — `--strict-mcp-config
  --mcp-config .mcp.json`, loading only the vetted broker — but that flag also strips
  **plugin-provided** MCP servers, and fakechat *is* one (it delivers its tools as a plugin
  MCP server), so strict mode disables the chat surface. This example therefore uses the
  denylist, which is weaker: you must name each dangerous server, and one connected *later*
  isn't denied by default. **Check `/mcp` for anything unexpected and deny it.** Note
  fakechat itself won't appear in `/mcp` — channels are listed separately (confirmed by
  the startup `Channels:` line), and its tools are pre-allowed as
  `mcp__plugin_fakechat_fakechat` in the stamped `settings.json`.
- **Hash pinning** makes registration review meaningful: policy bytes live only in the
  private store; a workspace copy the agent edits after approval is irrelevant, and an
  *update* re-enters review with an old→new diff (behaviorally proven by audit Part F).

Verify all of it with `node tests/sandbox-audit.mjs` (Parts E–G cover the broker surface:
UI unreachable from the sandbox, hash pinning holds, auto-approve stays in class).

## Not included (see docs/claude-cli-security-proposal.md and docs/PROPOSAL.md)

File-reference payloads + CAS ingestion, cooldowns and rate caps, phone push, passkey +
tailnet binding for the UI (the demo uses a password login + session cookie on
localhost), the batch audit digest, subagent launching.
