# Minimal Clawmini broker — pure plugin, interactive claude

The counterpart to `../example` (the SDK-driver version). Here **claude runs normally**
in an interactive session (e.g. in `tmux`), and the broker is **just a plugin** — an MCP
server that also implements the channel spec. It does the minimum: expose a
`request_action` tool, and **push async approve/reject notifications** back into the
session. It does not drive claude.

Chat is via the **fakechat** channel; the broker only handles requests + notifications.

## Why interactive (and not `-p`)

Pushing an async notification into a running session needs the channel spec. A *custom*
channel plugin **does not activate in headless (`-p`) mode** — its notifications are
silently dropped (verified). In an **interactive** session it *does* activate and
deliver. Verified end-to-end here: chat in via fakechat → agent files a broker request →
you approve → the broker pushes a `<channel source="broker">` notification → the agent
wakes and acts on it. (If you need headless/service operation, use the SDK-driver version
in `../example`, which injects via the input stream and works headless.)

## Run it

From inside this directory, launch claude with both channels (do this in a tmux pane so
it keeps running):

```bash
cd example-plugin
claude \
  --channels plugin:fakechat@claude-plugins-official \
  --dangerously-load-development-channels server:broker
```

- `--channels plugin:fakechat@...` — the chat surface (allowlisted plugin).
- `--dangerously-load-development-channels server:broker` — our custom broker channel
  (custom channels need this flag during the research preview).

On first launch claude asks you to trust the workspace and the new MCP server — accept
both. A startup line confirms the channel: `Channels: server:broker`. (Prereq: install
fakechat once with `/plugin install fakechat@claude-plugins-official` inside claude.)

## Test it

Open **http://localhost:8787** (fakechat) and send:

> Please run the host command: echo hello-from-plugin — show me the output.

The agent replies that it filed a broker request and keeps going (non-blocking). From
another terminal:

```bash
./approve REQ-1        # or:  ./deny REQ-1
```

The broker runs the command on the host and pushes the outcome; the agent wakes and posts
the result back into the fakechat UI: `hello-from-plugin` (or the rejection).

## How it works

```
you (fakechat UI) ──▶ agent (interactive claude, sandboxed: no network/host)
                         │ needs outside-VM ──▶ request_action(argv, reason)   [broker tool]
                         │                        returns { ticket, pending }  (non-blocking)
                         ▼
                   broker: pending REQ-N
   you ─▶ ./approve REQ-N ─▶ broker runs it on the host, then PUSHES
                   <channel source="broker" ticket="REQ-N" verdict="approved"> ─▶ agent wakes, replies via fakechat
```

- `broker.mjs` — MCP server with `claude/channel` capability. Single stdio process, so the
  tool handler and verdict watcher share memory directly (no filesystem hand-off — that
  complication only exists in the SDK in-process variant).
- `.mcp.json` / `settings.json` — register + pre-trust the broker; sandbox on with network
  denied, so the agent *must* use the broker to leave the box.
- `CLAUDE.md` — tells the agent the rules of the box.
- `approve` / `deny` — one-line human decision helpers (no web UI).

## Plugin vs. driver — when to use this one

Use this (plugin) when you want to run claude **normally / interactively** and keep the
broker as a small side component. Trade-offs vs. the SDK-driver version:

| | Plugin (this) | Driver (`../example`) |
|---|---|---|
| claude runs | normally, interactive (tmux) | headless, driven by the broker |
| async notifications | ✅ interactive only | ✅ headless too (input-stream) |
| enforce "broker is the only exit" | sandbox denies; agent *should* use broker | `canUseTool` denies alternatives instantly |
| per-host network policy / instant deny | ✗ (sandbox default behavior) | ✅ `canUseTool` |
| sees full session / lifecycle control | ✗ | ✅ |
| code size | smaller | larger |

## Not included (see the proposal)

Policy engine, payload snapshotting/CAS, reviewer LLM, cooldowns, audit log, real approval
UI. This is just the request → async approve/reject → notify loop as a plugin.

The sandbox is hardened (network denied, escape hatch closed via
`allowUnsandboxedCommands: false`, `denyRead` on crown-jewel paths). Because the plugin
variant has no `canUseTool` backstop, containment rests entirely on the settings, so two
extra layers are in `permissions.deny`:
- **`Read()/Edit()/Write()` deny rules** for crown-jewel paths and `~/.clawmini-demo` — the
  native file tools bypass `sandbox.filesystem.denyRead` (which only covers bash), so they
  need permission rules too. (Deny beats allow, so these win over the broad `allow` list.)
- **`mcp__claude_ai_Gmail/Google_Calendar/Google_Drive`** denied — MCP servers run outside
  the sandbox, so any connected integration is a network + private-data path. If you've
  connected other MCP servers, deny those too, or launch with `--strict-mcp-config` so only
  the broker is loaded. Check what's live with `/mcp` inside the session.

Verify all of it with `../tests/sandbox-audit.mjs`.
