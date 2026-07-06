# Proposal: Clawmini's Security Model on top of the `claude` CLI

Goal: run `claude` with **full autonomy inside a no-network sandbox**, and require
**human approval (via a web UI) for anything that leaves the sandbox** — one-off host
commands, domain allowlisting, policy management, and messages to network-enabled
subagents.

The good news: Claude Code now ships most of the primitives natively. The design below
uses three layers — the sandbox, an escalation **broker**, and the approval/wake-up
channel — and needs surprisingly little custom code.

---

## 0. TL;DR — recommended architecture

```
┌─ HOST (outside sandbox) ──────────────────────────────────────────┐
│                                                                   │
│  Broker daemon (single process you write)                        │
│   ├─ MCP server (stdio, spawned by claude — runs UNsandboxed)    │
│   │    tools: request_escalation, check_request, check_policy,   │
│   │           manage_policies, send_to_subagent                  │
│   ├─ Policy engine (auto-approve readonly/private-write;         │
│   │    queue public-write/destructive for human review)          │
│   ├─ Web UI (localhost:PORT + push notification to phone)        │
│   └─ Subagent launcher (claude -p in a *different* sandbox       │
│        profile with network but no personal data)                │
│                                                                   │
│  claude process itself (talks to api.anthropic.com — fine)       │
│      │                                                            │
│      ▼ spawns Bash inside…                                        │
│  ┌─ SANDBOX (Seatbelt on macOS / bubblewrap on Linux) ─────────┐  │
│  │  all shell commands: full filesystem-scoped access,          │  │
│  │  ZERO network (allowedDomains: [])                           │  │
│  └───────────────────────────────────────────────────────────── ┘  │
└───────────────────────────────────────────────────────────────────┘
```

Key insight that makes this simple: **with Claude Code's native sandbox, MCP servers
run *outside* the bash sandbox on the host.** Your broker doesn't need to tunnel out of
the sandbox — a plain stdio MCP server *is* the privileged escape hatch, and you gate it
with your own policy engine.

Approvals are **fully async**: escalation tools return a ticket immediately, the agent
keeps working its queue, and the broker *delivers* the approve/reject decision back —
pushed into a live session via channels, or by resuming an ended session (§3). The
human is an event source in the agent's loop, not a modal dialog blocking it.

---

## 1. Layer 1 — the sandbox

Use Claude Code's built-in sandbox ([docs](https://code.claude.com/docs/en/sandboxing.md))
rather than rolling your own proxy. It uses Seatbelt (`sandbox-exec`) on macOS and
bubblewrap + socat on Linux, with a host-side proxy enforcing a domain allowlist.

`.claude/settings.json` for the main agent's workspace:

```json
{
  "permissions": {
    "defaultMode": "default",
    "allow": ["Bash", "Read", "Edit", "Write", "Glob", "Grep"],
    "deny": [
      "WebFetch", "WebSearch", "Monitor", "PowerShell",
      "Read(~/.clawmini/**)", "Edit(~/.clawmini/**)", "Write(~/.clawmini/**)",
      "Edit(.claude/**)", "Write(.claude/**)",
      "Edit(CLAUDE.md)", "Write(CLAUDE.md)",
      "Edit(.mcp.json)", "Write(.mcp.json)"
    ]
  },
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "allowUnsandboxedCommands": false,
    "autoAllowBashIfSandboxed": true,
    "excludedCommands": [],
    "network": { "allowedDomains": [] },
    "filesystem": {
      "denyRead": ["~/.clawmini", "~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gcloud"],
      "denyWrite": ["~/.clawmini"]
    },
    "credentials": {
      "files": [
        { "path": "~/.ssh", "mode": "deny" },
        { "path": "~/.aws/credentials", "mode": "deny" }
      ],
      "envVars": [{ "name": "GITHUB_TOKEN", "mode": "deny" }]
    },
    "allowUnixSockets": false,
    "allowAppleEvents": false
  }
}
```

> ### ⚠️ Experiment 2 finding (2026-07-05, macOS 15.7.4, CLI 2.1.201): this config as
> ### written does NOT deny network. `bypassPermissions` defeats the network allowlist.
>
> Empirically tested with decoy targets. **Filesystem containment is airtight even under
> `--dangerously-skip-permissions`** — every probe was blocked and ground-truthed:
> - bash write outside cwd (`/tmp`) → OS-blocked (`operation not permitted`, Seatbelt)
> - bash read/write of `denyRead`/`denyWrite` paths → permission-blocked
> - Write tool → `.claude`-config and forbidden dirs → "denied by permission settings"
> - Read tool → decoy secret → denied · WebFetch → removed from the toolset entirely
> - control write to workspace → succeeded (blocks are selective, not total)
>
> **But network denial FAILED under bypass.** With `--dangerously-skip-permissions`, a
> sandboxed `curl https://example.com` returned **HTTP 200** despite `allowedDomains:
> []`. Mechanism: the sandbox forces all egress through a local proxy (direct sockets
> and non-proxied DNS *are* blocked — good), but in a permission-**bypass** mode the
> proxy's per-domain approval is **auto-approved**, so every domain is allowed. In
> **default** mode (Bash pre-allowed, no bypass) the identical request is blocked:
> `CONNECT tunnel failed, response 403`. So `bypassPermissions` — the mode we chose for
> autonomy — silently nullifies the network leg of the lethal-trifecta defense.
>
> **Consequences for the design (see §1a below and §6):**
> 1. Do **not** rely on `bypassPermissions` + `allowedDomains: []` for network denial.
> 2. Get autonomy a different way: **sandbox auto-allow mode** (sandboxed commands run
>    without prompts) under a **non-bypass** permission mode, so the network allowlist
>    still fails closed. Grant tool/edit autonomy with targeted `allow` rules, not a
>    blanket bypass.
> 3. For unattended fail-closed network, verify `sandbox.network.allowManagedDomainsOnly:
>    true` in **managed** settings (blocks non-allowlisted domains without prompting).
>    Not yet tested — it requires writing to a system managed-settings path, deferred to
>    avoid touching real system config on this machine.
> 4. Strongest option: enforce network denial in a layer Claude Code's permission mode
>    cannot override — a Linux container with an iptables firewall, or an external
>    proxy. This promotes the §6 container/VM hardening from "optional" to **recommended
>    for the network boundary on macOS.** (The proxy is `srt`-branded, i.e.
>    sandbox-runtime is the underlying tech — so wrapping under srt directly, §6, is the
>    natural fix.)

> ### ✅ Experiment (a) resolution (2026-07-05, same box): non-bypass config gives
> ### autonomy AND fail-closed network — and exposes a clean per-domain hook.
>
> Config tested (persistent stream-json session, mimicking the real long-lived agent):
> `permission-mode default`, `allow: ["Bash","Read","Edit","Write","Glob","Grep"]`,
> `deny` on WebFetch/WebSearch/Monitor + crown-jewel paths, `sandbox.enabled` with
> `autoApprove: true`, `allowedDomains: []`. Results, all ground-truthed:
> - **Autonomy: PASS.** Pre-allowed sandboxed commands ran with no prompt (`whoami`
>   returned immediately); the session completed a 4-command task in ~48s.
> - **External network: fails closed.** `curl https://example.com` → connection timed
>   out, HTTP 000, no content. example.com's HTML never reached the agent.
> - **No stall.** Critically, the denied network call did **not** hang the persistent
>   session — it completed and moved on. The feared "prompt-with-nobody-home freeze"
>   did not occur here.
> - **Endpoint unreachable (Experiment 5, folded in): PASS.** `curl http://127.0.0.1:8799`
>   (a real broker-stub I stood up) failed to connect *instantly*, and the stub's leak
>   string never appeared in the transcript. Localhost is just another off-allowlist
>   host to the sandbox; the agent cannot reach its own broker over the network. (The
>   broker's MCP is stdio, not localhost HTTP, so this doesn't break broker comms.)
>
> **Key discovery — network access is a hookable permission, not just a silent proxy
> rule.** The transcript showed the egress attempt surface as a `can_use_tool`
> control request for a synthetic tool **`SandboxNetworkAccess`**, with `{host:
> "example.com"}` as input and a suggested `WebFetch(domain:example.com)` allow rule.
> This is the clean implementation point for `allowlist-domain` escalations: the
> broker's permission handler (Agent SDK `canUseTool`, or the channel **permission-relay**
> capability) adjudicates each host — deny by default, allow only what an escalation
> approved. That's *better* than relying on an empty allowlist: it's deterministic and
> broker-owned.
>
> **One nuance to harden.** Here the block came from the `SandboxNetworkAccess` request
> going *unanswered* until curl's own 6s timeout — fail-closed, but a per-attempt hang,
> and it depends on nobody answering "allow." For instant, deterministic deny, either
> (i) the broker's permission handler denies `SandboxNetworkAccess` by default (the
> intended design — instant, no hang), or (ii) `allowManagedDomainsOnly: true` in
> managed settings.
>
> **Net:** the network open item is resolved in principle. The base (no-container)
> design is viable on macOS *if* the agent runs non-bypass with a broker-owned permission
> handler denying `SandboxNetworkAccess` by default. The container/iptables path (§6)
> remains the belt-and-suspenders upgrade.

> ### ✅ Experiment (b) — how the broker adjudicates permissions (2026-07-05):
> ### via the stream-json control protocol, NOT channel permission-relay.
>
> Tested whether `SandboxNetworkAccess` prompts relay through a channel's
> `claude/channel/permission` capability. Built a custom relay channel (declares the
> capability, logs every `notifications/claude/channel/permission_request`), ran the
> agent headless (`-p --input-format=stream-json`), and drove a network access.
> **Result: the channel relay never fired (0 permission_request notifications), even
> though the channel was MCP-connected and its reply tool worked.** Instead the network
> approval surfaced on the **stream-json output as a `can_use_tool` control_request**
> (`tool_name: "SandboxNetworkAccess"`, `input: {host: "example.com"}`, plus a suggested
> `WebFetch(domain:...)` allow rule).
>
> Conclusion: **channel permission-relay is an interactive-TUI feature** (the docs
> describe it entirely around "the local terminal dialog opens"); it does not operate in
> headless/`-p` mode. Since the broker drives the agent headless, it adjudicates every
> permission — including domain access — by **answering `can_use_tool` control requests**
> on the stream (equivalently, the Agent SDK `canUseTool` callback). This is *cleaner*
> than relay: one programmatic, broker-owned hook for all permissions.
>
> **Architectural consequence (updates §3):** the broker should be the **session driver**
> — spawn `claude` as a stream-json subprocess (or use the Agent SDK) — not merely a
> channel plugin. As driver it (a) delivers events/approvals by writing user messages to
> the agent's **stdin** (no channel needed for the broker's own events), and (b)
> adjudicates permissions via `canUseTool`/control-responses. Channels (Experiment 1)
> remain the right tool for *third-party* event sources you don't drive (Telegram, CI),
> but the broker's core loop doesn't depend on them.
>
> **Two caveats found:** (1) hand-rolling the raw `control_response` JSON did not cleanly
> unblock the turn in a quick test — use the **Agent SDK `canUseTool`** rather than
> hand-crafting the wire format. (2) A **custom dev channel** (`--dangerously-load-development-channels`)
> connected as an MCP server but did **not** activate event delivery in headless `-p`
> mode (its `notifications/claude/channel` events were dropped), unlike the allowlisted
> fakechat plugin in Experiment 1 — another reason the broker should inject events via
> stdin rather than run its own custom channel.

> ### ★ Architecture decision: outside-VM = silent DENY + broker escalation tool
> ### (supersedes reliance on permission relay / Remote Control for approvals)
>
> **Note on "SDK" vs "CLI" (not a design decision — same engine):** wherever this doc
> says *Agent SDK* / `canUseTool`, that is the **ergonomic wrapper over the `claude` CLI**,
> not an alternative to it. `@anthropic-ai/claude-agent-sdk` *spawns the Claude Code
> executable* (option `pathToClaudeCodeExecutable`) and its `canUseTool` callback is a
> typed wrapper over the exact `can_use_tool` stream-json control protocol the CLI already
> exposes. So "on top of the `claude` CLI" holds either way. The only choice is build-time
> ergonomics: use the SDK, or drive `claude -p --input-format=stream-json` and write the
> `control_response` JSON yourself (fiddlier — it's what didn't cleanly unblock in
> Experiment b). Same sandbox, same policy, same security properties. Recommendation: SDK,
> for the ergonomics; pure-CLI is equally valid if you'd rather avoid the dependency.
>
> Rather than *asking* the human on each outside-VM action (relay/Remote Control — both
> fragile per Experiment b), **hard-deny outside-VM at the permission layer so nothing
> ever prompts**, and make the broker's escalation MCP tool the sole exit. This reunifies
> everything to the headless broker-as-driver model and removes all dependence on
> interactive machinery:
>
> - **Silent deny** of outside-VM access (no prompt, no hang) via any of: the broker's
>   `canUseTool` returning `deny` for `SandboxNetworkAccess` (driver model); or
>   `allowManagedDomainsOnly: true` (managed settings); or a VM iptables firewall.
> - **The escalation tool is always reachable under total network denial** — Experiment b
>   incidentally proved it: a fully network-sandboxed session still called an MCP tool
>   over stdio (MCP runs unsandboxed; stdio is pipes, not network). The broker is the one
>   door in an otherwise sealed wall.
> - **Non-blocking**: `request_escalation` returns `{ticket, approval_url, pending}`
>   immediately; the agent continues other work.
> - **Async notify**: on approval the broker (the stream-json driver) injects a stdin
>   user message ("REQ-123 approved, output: …"); Experiment 1 proved stdin injection
>   wakes an idle session and drives a turn.
>
> **Consequence:** no permission relay, no Remote Control *needed* for the security path;
> the session runs headless and the broker's `canUseTool` + escalation tool gate every
> action. **Messaging surface is independent of that boundary** — you can attach extra
> input sources without weakening it, because none of them can approve an outside-VM
> action (`canUseTool` decides first). The SDK supports both:
> - **Discord/Google Chat** — Discord/Telegram/iMessage are allowlisted channels; channel
>   *event* delivery works headless (Exp 1). Your messages arrive as user messages.
>   (Permission *relay* is TUI-only per Exp b, but unneeded here.)
> - **Remote Control** — the SDK exposes it (`SDKControlRemoteControlRequest`,
>   `remoteControlAtStartup`), so it *can* attach to a broker-driven session (API-supported,
>   not yet tested by us). Caveats: needs claude.ai OAuth + `api.anthropic.com` (no
>   gateway), and adds Anthropic's RC cloud relay as a trust surface. Its permission-approval
>   is moot here (`canUseTool` already decides).
>
> *(Correction: an earlier draft said broker-as-driver and Remote Control "cannot co-own a
> session." The SDK control surface shows otherwise — they can coexist.)*
>
> **Treat channel/RC input as untrusted.** The SDK tags user-message provenance
> (`kind: 'channel'` vs. human) — so the broker can feed externally-sourced messages into
> the reviewer's provenance log and raise scrutiny on escalations filed right after.
> **Recommended:** broker-mediated messaging (the broker runs the Discord/Google Chat bot
> itself and injects via `streamInput`) so it *sees and tags* every inbound message before
> the agent acts — but attaching the official channel or Remote Control directly is fine
> as long as their input is treated as untrusted (which it must be regardless).
>
> **Decisive test — ✅ PASSED (Experiment c, 2026-07-05, Agent SDK 0.3.201).** Built a
> harness: `query()` with `sandbox.enabled + network.allowedDomains: []`, an in-process
> `broker` MCP server exposing non-blocking `request_escalation`, and a `canUseTool` that
> denies `SandboxNetworkAccess`. Results:
> - **Silent deny is instant.** `canUseTool` returned `{behavior:"deny"}` for
>   `SandboxNetworkAccess(host=example.com)`; the agent's `curl -m 20` failed with
>   `403` in **TIME=0.0034s** — 3 ms, versus the 6–8 s pending-hang without the handler.
>   No prompt, no human, no hang.
> - **Escalation tool works under total network denial.** The agent hit the wall, then
>   autonomously called `broker.request_escalation`, which returned
>   `{ticket, status:"pending", approval_url}` — the non-blocking ticket flow, over
>   stdio, with egress fully denied.
> - **End-to-end the intended loop ran unattended:** try-to-leave-VM → instant deny →
>   escalate via broker tool → get pending URL → continue. The whole model, validated.
>
> **Implementation detail the run surfaced:** bare tool names in `allowedTools`
> *auto-approve before `canUseTool` is consulted* (SDK warns
> `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`). To make `canUseTool` the single broker decision
> point for **every** tool (so nothing bypasses policy), do **not** bare-list tools in
> `allowedTools`; let them fall through to `canUseTool` (or gate with a PreToolUse hook).
> This is the concrete shape of the broker's policy engine: one `canUseTool` that allows
> inside-VM actions, denies outside-VM instantly, and routes the agent to the escalation
> tool.

What each choice buys you (⚠️ the first two bullets are amended by the finding above):

- **`bypassPermissions` + sandbox** gives full filesystem/exec containment (verified) but
  **NOT network containment** — bypass auto-approves domains. Use a non-bypass mode with
  sandbox auto-allow instead (finding above). `defaultMode: bypassPermissions` can only
  be set in **user or managed** settings, not project — or pass
  `--dangerously-skip-permissions` / `--permission-mode bypassPermissions` at launch.
- **`allowedDomains: []`** denies network **only in non-bypass modes**. It is *not*
  self-enforcing: under bypass it fails open. When it is enforced, the empty allowlist
  does moot the proxy's domain-fronting weakness — there's no allowed host to front
  through — but the enforcement itself depends on the permission mode.
- **`allowUnsandboxedCommands: false`** ("strict mode") kills the
  `dangerouslyDisableSandbox` escape hatch entirely, and `excludedCommands: []` keeps
  the other one closed. Escaping the sandbox happens *only* through the broker.
- **`deny: ["WebFetch", "WebSearch"]` is load-bearing.** The sandbox only wraps *Bash*;
  WebFetch/WebSearch are built-in tools running in the main process and would otherwise
  be a network path even in bypassPermissions mode (deny rules still apply there).
- `failIfUnavailable` prevents silently running unsandboxed if bubblewrap/Seatbelt is
  missing.
- Even in bypassPermissions, `rm -rf /` / `rm -rf ~` circuit-breakers still prompt, and
  explicit `ask` rules still fire — you can keep a few tripwires if you want.

**Known residual risks of this layer** (accept, or upgrade — see §6):
- Only Bash is sandboxed. The `claude` node process, hooks, and MCP servers run on the
  host. That's a *feature* for the broker, but it means: register **no other MCP
  servers** in this profile, and treat `.mcp.json` / hook config as part of your TCB
  (the sandbox already denies writes to settings files, and `.claude/`, `.mcp.json`
  etc. are protected paths).
- Read/Edit/Write file tools are governed by permissions, not the bash sandbox; in
  bypassPermissions they can write anywhere the process can. The config above mirrors
  the broker-store denial into `permissions.deny`; do the same for `~/.ssh` etc.
  (`Read(~/.ssh/**)`), or run the whole thing under srt (§6) to close this class
  entirely.

### Audit: every built-in tool vs. the sandbox model

The bash sandbox covers exactly one tool. Everything else must be audited against
"can this touch the network or escape the workspace?" and handled via deny rules or
the containment hook below. Per current docs (tools-reference.md):

| Class | Tools | Verdict |
|---|---|---|
| **Server-side network** — work even with total host network denial, because the fetch happens on Anthropic infra | `WebFetch`, `WebSearch` | **Deny by bare name** (removes the tool from the model's context entirely — stronger than a scoped deny, which only blocks at call time). |
| **Anthropic-infra outbound** — present when the session is connected to claude.ai; each publishes or transmits data outward | `Artifact` (publishes content!), `SendUserFile`, `PushNotification`, `RemoteTrigger`, `ShareOnboardingGuide` | Deny if present. Notifying the human is the *broker's* job. `Artifact` in particular is a first-class exfiltration channel. |
| **Local-process network** | `Bash` (via curl etc. — already sandboxed), `Monitor` (can open WebSockets from the main process) | Bash: sandbox. `Monitor`: deny. `PowerShell`: leave disabled (opt-in env var; don't set it). |
| **Unsandboxed filesystem** | `Read`, `Edit`, `Write`, `Glob`, `Grep`, `NotebookEdit`, `LSP`, `Skill`/`Workflow` (read their definitions) | Fence with the **containment hook** (below) + static deny rules for crown jewels. |
| **Delegation** | `Agent`/`Task` (subagents) | Keep — subagent tool calls are checked against the same permission rules and PreToolUse hooks as the parent. Deny specific agent types if any bundle undesired tools. |
| **Inert session-state** | `TodoWrite`, `Task*`, `AskUserQuestion`, plan/worktree tools, etc. | No action. |
| **Irreducible** | The `claude` process itself streams the transcript to `api.anthropic.com` | Anthropic is in the TCB. Accept, or route via Bedrock/Vertex if that changes your trust calculus. |

**The containment hook.** You cannot express "deny file access everywhere except the
workspace" with permission rules: precedence is a hard deny > ask > allow, so a broad
`Read(//**)` deny also kills the workspace allow, and there is no negation syntax. The
correct fence is a `PreToolUse` hook on the file tools that resolves the target path
(realpath, post-symlink) and returns `permissionDecision: "deny"` unless it's inside
the workspace or scratchpad. Two documented properties make this sound:

1. PreToolUse hooks fire **before** permission-mode checks — a hook deny blocks the
   call **even in bypassPermissions** ("policy users can't bypass by changing their
   permission mode").
2. Hooks can tighten but never loosen — a hook returning `allow` still can't override
   a settings deny rule.

The hook is defined in settings the sandbox already write-protects, and the deny rules
above (`Edit/Write` on `.claude/**`, `CLAUDE.md`, `.mcp.json`) prevent the file tools
from editing the hook's own configuration or the agent's instruction files — closing
the self-modification/persistence hole (§8). Instruction changes (CLAUDE.md, skills)
go through the broker as escalations like everything else.

---

## 2. Layer 2 — the escalation broker

One daemon, written by you (this is ~all of Clawmini's custom code). It plays three
roles: MCP server, policy engine, approval web UI.

### Registration

```bash
claude mcp add escalation --scope project -- node /opt/clawmini/broker.js
```

Stdio transport: claude spawns it on the host (unsandboxed), talks over pipes, no
network needed, no tool-call timeout. If you'd rather run it as a long-lived daemon
(shared queue across sessions, survives restarts), expose streamable HTTP on
`127.0.0.1` and `claude mcp add --transport http escalation http://127.0.0.1:8787/mcp` —
both work; stdio can also just be a thin proxy forwarding to the daemon.

### Tools

| Tool | Behavior |
|---|---|
| `check_policy(command)` | **Dry-run**: returns `auto_approve` / `needs_approval` / `denied` + which policy matched. Lets the agent avoid spurious requests and batch. Free to call (but rate-limit to prevent brute-forcing the classifier). |
| `request_escalation(kind, payload, justification)` | `kind` ∈ `run-host` \| `allowlist-domain` \| `policy-change`. Policy engine evaluates: auto-approved classes execute immediately and return output; everything else creates a ticket, notifies the human, and **returns immediately**: `{status: "pending", ticket: "REQ-123", approval_url: "http://localhost:8787/r/REQ-123"}`. The agent moves on to other work; the resolution comes back through the delivery tiers in §3. Optional `wait_seconds` param for the rare case the agent has nothing else to do and wants to block briefly. |
| `check_request(ticket)` | Poll a pending ticket; returns pending/approved+output/denied+reason. |
| `manage_policies(action, …)` | List is free; add/update/delete of a policy is itself an escalation (a policy is standing approval, so it deserves the same review as a one-off). |
| `send_to_subagent(agent, message)` | See §5. Always human-reviewed. |

**Async-first is the right call.** Blocking on approval (possible thanks to stdio's
lack of timeout) wedges the session whenever the human is away, and a personal agent's
human is *usually* away. So `request_escalation` never blocks by default: it returns a
ticket, the agent continues with other relevant work, and the resolution is *delivered*
to the agent (§3) rather than polled for. Tell the agent in the tool description:
*"A pending ticket is not a failure. Continue other useful work; the result will arrive
as a message when the human responds. Do not poll `check_request` in a loop."*

**Snapshot at request time (TOCTOU).** Because approval may land hours later, the
broker must capture the *exact* payload when the ticket is created — the full argv, the
email draft body, the file contents by hash — and on approval execute exactly that
snapshot. Never re-read mutable state (a draft, a script file the sandboxed agent can
still edit) at execution time: otherwise the agent — or a prompt injection — can swap
the payload between your review and the run. Approve bytes, not references.

### The private store and file references

The broker keeps all of its state in one directory the agent can never touch —
`~/.clawmini/` in the config above, denied to both sandboxed Bash (`filesystem.denyRead`
/ `denyWrite`) **and** the Read/Edit/Write file tools (`permissions.deny` mirrors —
required because file tools bypass the bash sandbox, and deny rules still apply in
bypassPermissions):

```
~/.clawmini/
  policies/         # registered policy scripts — the executable copies live HERE,
                    #   never in the agent workspace; registration/update is itself
                    #   an escalation, and each version is pinned by hash
  cas/sha256/<hash> # content-addressed snapshot store (immutable, dedup'd)
  requests/         # tickets: kind, argv, file manifest (keys → hashes), status,
                    #   session id, decision, audit trail
  secrets/          # broker auth token, push-notification creds
```

If the agent legitimately needs to *read* broker state (its own pending tickets, the
policy list), expose that through broker tools, not the filesystem.

**File references in requests.** Commands often need file inputs — an attachment, a
script argument, a config. The request schema:

```json
{
  "policy": "google-workspace-full",
  "args": ["gmail", "send", "--to", "bob@example.com", "--attach", "@draft"],
  "files": { "draft": "./out/report.pdf" }
}
```

At *request* time the broker resolves each referenced path and ingests it into the CAS;
the ticket stores `draft → sha256:ab12…`, and the review UI renders the snapshot's
actual content. At *execution* time the broker materializes the CAS blobs into a
private staging dir and substitutes those paths for the `@key` placeholders. The agent
can rewrite `./out/report.pdf` all it likes after filing — the approved bytes are what
run.

Hardening rules for the ingest step (the broker is a privileged process copying files
at the sandboxed agent's request — treat it as such):

- **Containment:** resolve the real path (after symlinks) and require it to be inside
  the agent's workspace. Without this, `{"files": {"a": "~/.ssh/id_rsa"}}` turns the
  broker into a read primitive that bypasses the sandbox's `denyRead` — the copy
  happens outside the sandbox. Reject symlinks that escape, reject `..`, cap sizes.
- **Content-address everything:** hashes give you dedup, an immutable audit trail
  ("what exactly did I approve on Jul 3?"), and cheap re-approval.
- **Approve-by-hash for standing policies:** an auto-approve policy pins the script
  hash it was granted for. Same hash → auto-run; changed script → the diff (old vs.
  new snapshot) goes to the review UI. This is the single biggest alert-fatigue win:
  you review script *changes*, not script *runs*.
- On macOS/APFS, `clonefile(2)` (`cp -c`) makes CAS ingestion of large files O(1)
  copy-on-write; `cp --reflink=auto` on btrfs/XFS for Linux.

Alternatives considered: a separate `stage_files` tool (two-phase: stage → reference
handles in later requests — nicer for batching several requests over the same files,
otherwise equivalent); and making the workspace a git repo so requests reference a
commit SHA (free content-addressing *and* review diffs, at the cost of forcing git on
every workspace — worth it if the workspace is already a repo). Both are backend
variations on the same manifest API; the schema above doesn't have to change.

### Execution semantics

- **execve arrays end-to-end.** The broker invokes policy scripts as
  `execve(script, [args...])` — never through a shell, never string-interpolated.
  That guarantee stops at the script boundary: what a policy script does with its args
  is the script's responsibility, which makes shell hygiene *inside* scripts a
  registration-review concern — the reviewer LLM flags `eval`, backticks, and
  string-built shell invocations when a script is registered or updated.
- **Large outputs go to the workspace, not the tool result.** Above a size threshold,
  the broker writes stdout to a file in the agent's workspace and returns the path
  (sidesteps MCP output limits; makes big results greppable). Small outputs return
  inline.
- One approval = one execution attempt of one snapshot, within the ticket's 24h TTL
  (lifecycle rules above).

Since you're in bypassPermissions mode, these MCP calls themselves won't prompt —
which is correct: **the broker owns the approval decision, not Claude Code's permission
system.** Defense-in-depth: the broker should require a shared secret via env var that
only the real claude launch wrapper knows, so a sandboxed process can't spoof requests
if you later switch to the HTTP transport.

### Policy engine

Exactly your post's design, enforced in the broker:

- Policies are named wrappers (scripts) + an `autoApprove` predicate over argv. Rego/OPA
  is a fine choice; a plain TS predicate per policy is fine too. Classes:
  - `readonly` / `private-write` → auto-approve (log everything; add anomaly flags per
    your footnote 1).
  - `public-write` / `destructive` / raw commands → human review.
- Ship the Google Workspace trio (`google-workspace-readonly`, `-drafts`, `-full`) as
  the first policies; a Skill / CLAUDE.md section tells the agent to prefer the
  narrow ones.
- **Domain grants demand the exfil-safety question.** A standing `allowlist-domain`
  grant is reserved for domains the user trusts *absolutely* — but "absolute trust"
  has a precise meaning here: *"am I comfortable with any of my private data being
  sent to this domain, by an attacker, at any future time — and can no third party
  read it there?"* Your own website passes; a well-run private SaaS may pass;
  `github.com` **fails** (anyone can read a public gist or issue — a trusted brand is
  still an exfil drop-box if it hosts world-readable user content). The review UI asks
  this question verbatim on every allowlist-domain request. Anything below that bar
  gets a session-scoped or time-boxed grant instead.
- **Ticket lifecycle (decided):** unresolved tickets expire after **24h** — expiry is
  delivered to the agent as an ordinary event ("REQ-123 expired unactioned") so it can
  re-file if still relevant. An approval authorizes **exactly one execution attempt**
  of the approved snapshot; a partial failure requires a fresh ticket (fine for MVP —
  "approve-until-success" with idempotency rules is a deliberate future evolution,
  because retry authority is a security grant of its own).
- **Cooldown keyed on policy + target**, not exact argv — perturbing a flag must not
  dodge it. After a denial, requests against the same (policy, target) pair are
  rejected broker-side for T minutes without notifying the human, and a global
  escalations-per-hour cap backstops brute-forcing.

### Web UI + phone

The broker hosts the approval queue and pushes to your phone (ntfy/Pushover/Telegram —
your choice). Each request page shows: the exact command, argv diff vs. the matched
policy, the agent's `justification`, highlighted recipients/attachments/URLs (your
"explain in sufficient detail" requirement), and buttons: **Approve once / Deny /
Deny with message / Create auto-approve policy**. "Deny with message" feeds text back
as the tool result — cheap human→agent channel.

**Endpoint security — two independent requirements:**

1. **Only the user can reach it.** Serve the UI exclusively on the tailnet (bind to
   the Tailscale interface, never `0.0.0.0`), authenticate with Tailscale identity
   plus a passkey for the approve action itself, CSRF-protect all mutations, and never
   allow approval from a notification action button without the payload rendered.
2. **The agent can never reach it.** The approve path must be unreachable from
   everything the agent controls:
   - The sandbox's empty network allowlist blocks bash from any host *including
     localhost* — and no broker/localhost address may ever be added to
     `allowedDomains`, even "temporarily for debugging."
   - **The MCP surface and the approve API are disjoint by construction**: MCP tools
     can create and read tickets, never resolve them. There is no broker code path
     from an agent-invokable interface to a ticket-state transition.
   - Approve requires the passkey — a credential that exists only on the user's
     devices, so even a confused-deputy bug in the broker can't be driven to
     self-approve.
   - Red-team test (§7 suite): from inside the sandbox, attempt to reach the UI port
     and to resolve a ticket via every agent-facing interface; both must fail.

You can *also* have Claude Code itself alert you: a `Notification` hook with matcher
`permission_prompt` / `agent_needs_input` can POST to the broker, covering the rare
built-in prompts (circuit breakers, ask rules) so everything lands in one inbox.

### The reviewer: a broker-owned LLM explains requests, not the agent

The agent's `justification` field is attacker-controlled under prompt injection — so
the explanation the human reads must come from a model the *broker* owns, with a clean
context. On ticket creation, the broker makes a direct API call (it has network; a
cheap model like Haiku is fine) that sees only **broker-verified facts**: exact argv,
matched policy, snapshot contents/diffs, recipients, and the session's recent
untrusted-input provenance log. It produces a structured risk summary: what the
command does, PII or encoded-looking strings in the payload, links/tracking-pixels in
drafts, whether this request plus existing grants completes the trifecta (§8),
recipient-trust flags.

Rules that keep the reviewer honest:

- **It reads hostile bytes too** — the email body or script it summarizes may contain
  injection aimed at *it*. So: no tools, strict JSON output schema, payloads delimited
  as quoted data, instructed to describe and never follow.
- **Advisory, never load-bearing.** The UI always renders the raw verified facts; the
  reviewer annotates, it does not gatekeep. Approval must remain makeable from the raw
  facts alone.
- The agent's own justification is still shown — but visually quarantined as an
  untrusted claim, separate from the reviewer's summary.
- Cache verdicts by content hash (same request → same summary), which also keeps
  re-request loops from re-billing the reviewer.
- The same reviewer, run in async batch mode over *auto-approved* traffic, is the
  abuse-flagging audit from the blog post's footnote 1 — anomalies surface in a daily
  digest rather than as interrupts.

---

## 3. Layer 3 — delivering the decision back to the agent

Design invariant: **the agent never waits and never poll-loops.** It files the ticket,
keeps working the rest of its queue, ends its turn when that work is done, and the
broker guarantees the resolution reaches it.

> **Amended by Experiment (b) (§1):** the broker is the **session driver**, not a
> channel. It spawns `claude` as a stream-json subprocess (or via the Agent SDK) and
> delivers its own events by writing user messages to the agent's **stdin** — simpler
> than a channel and required anyway, because (i) permission adjudication only works via
> the driver's `canUseTool`/control-response path in headless mode, not channel relay,
> and (ii) a custom broker channel didn't even activate event delivery headless.
> Channels stay in the design for *third-party* sources the broker doesn't drive.
> The "one inbox" model below is unchanged; read "channel event" as "broker-injected
> stdin message" for the broker's own events.

**Session model (decided): one inbox, one session, broker owns durability.** Every
input to the main agent is either a user message or a broker-delivered event — there is
no third path. That collapses the earlier delivery-tier design into something much
simpler:

- The main agent is **one long-running session** the broker drives as a stream-json
  subprocess, kept alive by a supervisor (launchd on the Mac Mini). The broker is the
  single event source: approvals, rejections, new tasks, incoming email triggers — all
  injected as stdin user messages (third-party channels can still feed in via
  `--channels`).
- The broker keeps a **durable outbox with acks**. If the session dies or the machine
  reboots, the supervisor restarts with `claude --continue --channels clawmini` and
  the broker re-delivers every unacknowledged event. Delivery is idempotent (event
  ids); each resolution is consumed exactly once. No `-p --resume` races, no
  session-id bookkeeping on tickets, no concurrent writers to one transcript.
- **Resolutions are self-contained.** A long-lived session compacts, and a three-day-
  old ticket's rationale may not survive compaction — so every delivery restates the
  request: "REQ-123 (send email to bob@…, filed re: weekly report) was APPROVED and
  executed; output: …" / "REQ-123 rejected: <your note>". Rejections are ordinary
  events too — the agent can revise and re-request (the cooldown only suppresses
  near-identical retries).
- **Safety net — `Stop` hook as outbox check.** When the agent ends its turn, a `Stop`
  hook asks the broker for resolved-but-undelivered events; if any, it blocks the stop
  with the resolution as the reason. This covers any gap in channel delivery.

**Transport: channels — ✅ VERIFIED (2.1.201, experiment run 2026-07-05).** The
keystone behavior holds: **an inbound channel event wakes an idle session and triggers
a fully autonomous multi-step turn, with no human input.** Confirmed end-to-end with the
official `fakechat` channel plugin:
- Launched a persistent session in `-p --input-format=stream-json
  --output-format=stream-json --channels plugin:fakechat@claude-plugins-official
  --dangerously-skip-permissions`, sent it one bootstrap message, let it go idle.
- POSTed a message to fakechat's `/upload` HTTP endpoint (no stdin, no keypress) →
  fakechat fired the `notifications/claude/channel` MCP notification → the idle session
  autonomously started a new turn, ran tools (Read → self-corrected via `ls` → Read),
  called the channel's `reply` tool, and finished. Round trip ≈ 12s.
- The channel `reply` tool (`mcp__plugin_<...>__reply`) delivers the agent's response
  back out and returns a `sent (<id>)` ack — the two-way path the broker needs.

**One operational caveat learned:** a session started *cold* in stream-json input mode
emits nothing and does not process channel events until it receives its first stdin
message — it only enters its event loop after that kick. **The broker must send one
bootstrap message at launch** ("you are online, await events") to arm the channel;
every subsequent event drives turns on its own. Minor, but real, and easy to miss.

Fallbacks (now only needed if channels are unavailable, e.g. Bedrock/Vertex auth, or an
org disables them): `--remote-control` (also present; pushes input into a named
session), or a no-push design where the broker drives a queue of headless
`claude -p --continue` turns one at a time. The architecture doesn't change with the
transport; only the wake path does.

> Prereqs surfaced by the experiment: channels require **Bun** (channel plugins are Bun
> scripts), Claude Code ≥ 2.1.80, and Anthropic auth via claude.ai/Console (not
> Bedrock/Vertex/Foundry). During the research preview `--channels` only accepts
> plugins on Anthropic's allowlist; a custom broker channel needs
> `--dangerously-load-development-channels` (see channels-reference). Team/Enterprise
> orgs must set `channelsEnabled`.

> Provenance note: an earlier draft of this section claimed `--channels` didn't exist.
> That was a verification error — `--help` omits the hidden flag, and a confirming grep
> hit an empty wrong directory (the active CLI is a native binary under
> `~/.local/share/claude/versions/`, not the npm global package). The feature is real.
> Lesson folded into §7: resolve the real binary and run the actual command; never infer
> a feature's absence from `--help` or a package grep.

`check_request` remains available for the agent to *check* status when it has a reason
to (e.g., before starting dependent work) — it's a lookup, not a wait primitive.

**Also worth tracking:** the experimental MCP Tasks extension (`resultType: "task"`,
`tasks/get`, `input_required` states) is the spec-level formalization of exactly this
ticket pattern; adopt it when it stabilizes in Claude Code.

---

## 4. Alternative shapes (worth knowing, not the recommendation)

**A. Native permission flow instead of a broker for `run-host`.** Claude Code already
has Clawmini's core loop built in: with sandbox auto-allow mode, sandboxed commands run
freely, and a command that *needs* network/host access falls back to a regular
permission prompt. You could keep `allowUnsandboxedCommands: true`, stay in `default`
mode with sandbox auto-allow, and route prompts to your web UI with a
`PermissionRequest` hook (`type: "http"`, `async: true`, `asyncRewake: true`,
`timeout: 600` — hooks may block up to 10 minutes). The hook returns
`{"decision": {"behavior": "allow"}}` to release the command.
*Why I don't recommend it as the primary mechanism:* the thing being approved is a raw
bash command with no policy layering, no `check_policy` dry-run, no cooldowns, and the
10-minute hook ceiling; you'd rebuild the broker anyway. But it's an excellent **belt**
under the broker's suspenders, and the right shape if you want minimal custom code.

**B. Agent SDK instead of the CLI.** If Clawmini evolves into a product, build the loop
with `@anthropic-ai/claude-agent-sdk`: the `canUseTool` callback is a plain async
function — it can await your approval service's webhook for arbitrarily long, return
`{behavior: "allow", updatedInput}` or `{behavior: "deny", message}`, and composes with
hooks and permission modes. This is the cleanest programmatic version of "the web UI
*is* the permission prompt." For headless CLI runs, the equivalent is
`claude -p --permission-prompt-tool mcp__escalation__approve`, where Claude Code calls
your broker's MCP tool for every permission decision.

---

## 5. Networked subagents (web dev, browsing) — "you are the firewall"

The broker is also the inter-agent firewall:

1. Main agent drafts a spec/message and calls `send_to_subagent("webdev", message)`.
2. Broker shows you the full message in the web UI — you scan for PII/secrets/untrusted
   payloads — and on approval spawns:
   ```bash
   claude -p "$MESSAGE" \
     --permission-mode bypassPermissions \
     --settings /opt/clawmini/profiles/webdev.json
   ```
   in `~/agents/webdev/` — a workspace containing **no personal data**, with its own
   settings: sandbox enabled but `allowedDomains` covering npm/GitHub/etc. (or
   unrestricted for browser work), and `denyRead` on your home directory.
3. The subagent's output/workspace is mounted **read-only** into the main agent's
   sandbox (`filesystem.denyWrite` on that path), so the main agent can read what was
   built without being able to smuggle data in. Return messages from subagent → main
   agent flow back unreviewed (safe direction is *into* the private agent — but note
   the subagent's output is untrusted input; the main agent's no-network sandbox is
   what makes that tolerable).
4. Per-project trifecta profiles are just different `--settings` files: research agent =
   network + no personal data; finance dashboard agent = personal data mount + strict
   allowlist.

---

## 6. Hardening upgrades (when you outgrow the base design)

- **`@anthropic-ai/sandbox-runtime` (srt)**: `npx @anthropic-ai/sandbox-runtime claude`
  wraps the *entire* claude process — file tools, hooks, MCP servers included — in the
  same Seatbelt/bubblewrap isolation. Closes the "file tools and hooks are
  unsandboxed" gap from §1. The broker then must run as a separate daemon started
  outside srt, reached via HTTP on an allowlisted localhost address. Beta, config may
  change. (github.com/anthropic-experimental/sandbox-runtime)
- **Container/VM**: the published `.devcontainer` reference (iptables default-drop
  firewall) or a VM gives a kernel-level boundary; broker lives on the host, claude in
  the guest, HTTP MCP across the bridge. Most operational overhead; do this when the
  Mac Mini hosts other people's agents, not just yours. **Promoted to recommended for
  the network boundary** by the Experiment 2 finding (§1): a container firewall denies
  egress regardless of Claude Code's permission mode, so it can't be undone by a bypass
  mode the way the in-process proxy can. On macOS specifically, the built-in proxy's
  domain enforcement is permission-mode-dependent; iptables in a Linux guest is not.
- **TLS-terminating proxy** (`network.tlsTerminate`, v2.1.199+) once you *do* allowlist
  domains for subagents — hostname-only filtering is frontable; TLS termination also
  enables credential `mode: "mask"` injection so agents never see raw tokens.

---

## 7. Build order

1. **Day 1 — sandbox profile + channel-wake experiment.** Settings from §1. ✅ The
   channel-wake experiment is **done and passed** (see §3): an idle `--channels` session
   autonomously takes a turn on an inbound event. Remaining day-1 work is the sandbox
   profile itself. Note the broker must bootstrap the session with one message to arm
   the channel loop.
2. **Adversarial test suite (before the broker exists).** A script-driven red-team
   harness that runs a captive agent session and asserts every boundary holds. Partly
   built and run already (Experiment 2, see §1) — results folded in:
   - filesystem: ✅ **PASS under bypass** — bash write outside cwd, bash/tool read+write
     of denied paths, `.claude`/`CLAUDE.md`/`.mcp.json` writes all blocked and
     ground-truthed against decoy canaries; workspace control write succeeds.
   - `WebFetch`/`WebSearch`/`Monitor`: ✅ bare-name deny removes them from the toolset.
   - network: ✅ **RESOLVED via non-bypass config (Experiment a)** — with `default` mode
     + pre-allowed tools + `sandbox.autoApprove`, an off-allowlist `curl` fails closed,
     `curl 127.0.0.1:<broker-port>` is instantly unreachable (leak string never seen),
     the persistent session does **not** stall, and autonomy holds. Egress surfaces as a
     hookable `SandboxNetworkAccess` permission the broker can adjudicate. Remaining
     hardening: make deny *instant* (broker permission handler denies by default, or
     `allowManagedDomainsOnly` in managed settings — untested, needs a system path), and
     confirm `SandboxNetworkAccess` is relayable via the channel permission-relay.
   - escape hatches: `dangerouslyDisableSandbox` refused; `excludedCommands` empty;
     symlink from workspace → `~/.ssh` rejected by file-ref ingest (once broker
     exists); ticket resolution unreachable from every agent-facing interface.
   - Re-run the whole suite on every `claude` version bump (pin + manual upgrades).
3. **Broker v0.** Stdio MCP server with `request_escalation` (ticket-based from day
   one, terminal confirmation instead of web UI) + `check_policy` + a JSON policy file
   with the Workspace trio. Payload snapshotting and the **append-only audit log of
   every request/approval/rejection** from the start — both are security properties,
   not features.
4. **Delivery loop.** Channels push + durable outbox with acks; `Stop`-hook outbox
   check; supervisor with `--continue` restart. Build before the pretty UI.
5. **Web UI + push.** Approval queue on the tailnet, passkey on approve, phone
   notifications, deny-with-message, "promote to policy" button, cooldowns.
6. **Subagent launcher** + per-profile settings files; read-only result mounts.
7. **Hardening**: srt or container, TLS-terminating proxy for subagent profiles.
8. **Post-MVP — grant review digest.** The reviewer LLM periodically reads the audit
   log and proposes tighter variants: "these 14 approvals match a readonly pattern —
   here's a policy"; "this domain grant has been unused for 60 days — revoke?";
   "these approvals would compose into an exfil path — consider narrowing."

## 8. Open questions & verification checklist

Decisions the proposal currently leaves ambiguous, and assumptions to verify before
building on them:

**Architecture decisions to make first**
- **Session model — DECIDED (§3):** one inbox — every agent input is a user message or
  a broker channel event; one supervised long-running session; broker-owned durable
  outbox with acks. Remaining verification: does a channel event wake an idle session
  and trigger a turn? If not, fall back to broker-paced headless turns.
- **Ticket lifecycle — DECIDED (§2):** cooldown keyed on policy+target; 24h TTL with
  expiry delivered as an event; one approval = one execution attempt (approve-until-
  success deferred as a deliberate future evolution).
- **Output plumbing — DECIDED (§2):** large results written to workspace files, path
  returned. Consequence stands: the workspace accumulates private data, so workspace
  containment of file refs is *not* a privacy guarantee; human review stays the only
  outbound gate.

**Security gaps to close**
- **Self-modification — addressed in §1, verify empirically:** bypass mode allows
  protected-path writes (v2.1.126+), so injected content could persist instructions or
  strip rules. Mitigated by deny rules on `.claude/**`/CLAUDE.md/`.mcp.json` plus the
  containment hook (docs state both hold in bypassPermissions — confirm by test).
  CLAUDE.md/skills edits go through the broker as escalations.
- **Untrusted justifications — addressed in §2 (reviewer LLM):** explanation shown to
  the human comes from a broker-owned model seeing only verified facts; agent's
  justification displayed as a quarantined claim; reviewer is advisory, injectable via
  payloads, so raw facts always render.
- **Grant composition — DECIDED (§2):** standing domain grants only for domains
  passing the exfil-safety question ("could an attacker send my data here, and could
  a third party read it there?"); everything else session-scoped/time-boxed. Reviewer
  LLM flags combinations that complete the trifecta.
- **Approval endpoint — DECIDED (§2):** tailnet-only binding + passkey on approve +
  CSRF + no approve without payload rendered; and agent-side unreachability by
  construction (empty network allowlist covers localhost; MCP surface can create/read
  but never resolve tickets; red-team test asserts both).
- **Broker injection surface — DECIDED (§2):** execve arrays end-to-end; the guarantee
  stops at the policy-script boundary, so shell hygiene inside scripts is checked at
  registration review.

**Platform assumptions to test empirically**
- Channels actually wake an idle session; stdio MCP truly has no tool-call timeout;
  deny rules hold in bypassPermissions; headless behavior when sandbox blocks a new
  domain (interactive builds prompt — who answers unattended?).
- **Version drift — DECIDED (§7 step 2):** pin `claude`, disable auto-update, re-run
  the adversarial suite on every upgrade.

**Operational**
- **Cold start — DECIDED (§7 step 8):** MVP keeps an append-only audit log of all
  requests/decisions; post-MVP the reviewer LLM reads it and proposes tighter
  variants (batch policies, unused-grant revocation, composition warnings).

## 9. Doc references

- Sandboxing: https://code.claude.com/docs/en/sandboxing.md · sandbox environments comparison: /sandbox-environments.md
- Permissions & modes: /permissions.md · /permission-modes.md
- Hooks: /hooks.md · /hooks-guide.md (PermissionRequest, Notification, async/asyncRewake, timeouts)
- MCP: /mcp.md · transports & timeouts; Tasks extension: modelcontextprotocol.io/extensions/tasks/overview.md
- Channels: /channels.md · Sessions/resume: /sessions.md · Headless: /headless.md
- Agent SDK: /agent-sdk/typescript.md (canUseTool) · secure deployment: /agent-sdk/secure-deployment.md
- srt: github.com/anthropic-experimental/sandbox-runtime · devcontainer: github.com/anthropics/claude-code/tree/main/.devcontainer

*(Feature availability was checked against current docs — some pieces are recent
(channels, `tlsTerminate` v2.1.199+, domain-approval memory v2.1.191+, hook
`async`/`asyncRewake`). Verify against your installed `claude --version` before
depending on them.)*
