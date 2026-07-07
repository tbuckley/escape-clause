# Security posture

This is the layered security model: why the approve path and the broker itself are out
of the agent's reach. For how the pieces fit together mechanically (launcher, channels,
relay, proxy), see [ARCHITECTURE.md](ARCHITECTURE.md).

Everything below is ground-truthed by the adversarial audit — run
`node tests/sandbox-audit.mjs` after `npm install` in `tests/` (Parts E–G cover the
broker surface: UI unreachable from the sandbox, hash pinning holds, auto-approve stays
in class).

## Why the approve path is out of the agent's reach

Three independent layers:

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

## Why the broker itself is out of the agent's reach

4. The broker's code runs from `~/.escape-clause/app` — inside the same denyRead- and
   guard-protected dir as its state — never from the agent's writable workspace. (An
   earlier version kept it in the workspace; the agent could then rewrite the very code
   that executes approvals, and its edits would run with full host privileges at the
   next launch.)
5. The workspace launch config (`.claude/`, `.mcp.json`) is protected three ways:
   guard-blocked against file tools, `sandbox.filesystem.denyWrite`-blocked against
   sandboxed bash (OS-enforced; the audit's Part C tamper-probes it), **and** verified
   byte-for-byte against the protected install on every launch — drift refuses to
   launch. Pointing `.mcp.json` at a different broker or dropping the sandbox doesn't
   survive to a next session.
6. The guard hook is loaded from the protected install and **fails closed**
   (`node …/guard.mjs || exit 2`): a missing or crashing guard blocks tool calls
   instead of waving them through.

## Details worth knowing

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
  that flag also strips **plugin-provided** MCP servers, and channel plugins (fakechat,
  Telegram, Discord, …) deliver their reply tools as one, so strict mode disables any
  plugin chat surface. The denylist is genuinely weaker: you must name each dangerous
  server, and one connected later isn't denied by default. **Check `/mcp` for anything
  unexpected and deny it.** (Channel plugins themselves won't appear in `/mcp` —
  channels are listed separately, confirmed by the startup `Channels:` line. If you
  chat in the terminal or over remote control — no channel plugin — prefer the strict
  allowlist.)
- **Hash pinning** makes policy review meaningful: policy bytes live only in the
  private store, invoked as `execve(script, args)` — never a shell. A workspace copy the
  agent edits after approval is irrelevant, and an *update* re-enters review with an
  old→new diff (proven by audit Part F).
- **Tickets snapshot the exact argv/script at request time** — the approved bytes are
  what run, not whatever the agent has changed since.
