# Minimal Clawmini broker — async approvals

A ~90-line example of the validated Clawmini architecture: a sandboxed agent with **no
network / no host access**, whose only way out is a **broker** that requires human
approval. Approvals/rejections are delivered **asynchronously** — the agent files a
request, keeps going, and is notified later when you decide. No web UI.

## What it demonstrates

```
you (chat) ──▶ agent (sandboxed: no network, no host)
                 │  needs something outside the sandbox
                 ▼
           request_action(argv, reason)          ← broker MCP tool, NON-BLOCKING
                 │  returns { ticket, pending } immediately; agent continues
                 ▼
           broker writes ~/.clawmini-demo/pending/REQ-N.json
                 │
   you ─▶ ./approve REQ-N   (or ./deny REQ-N)     ← human decision, no web UI
                 │
           broker runs the command ON THE HOST, then INJECTS the outcome
                 ▼
           agent wakes on the notification and reports the result
```

Three things are enforced, all verified end-to-end:

1. **Outside-VM is silently denied.** `canUseTool` denies `SandboxNetworkAccess`
   instantly (the agent's own `curl` fails in ~3 ms, no prompt). The agent must use the
   broker.
2. **The broker is the only exit.** `request_action` runs the approved command in the
   broker's host context — reachable even with the sandbox denying all network.
3. **Approvals are async.** `request_action` returns a ticket immediately; the outcome
   arrives later as a notification that wakes the idle agent.

## Why not the channel spec?

Pushing a message into a running session needs **either** the channel spec **or** the
driver's input stream. A *custom* channel (via `--dangerously-load-development-channels`)
connects as an MCP server but **does not activate as a channel in headless mode** — its
`notifications/claude/channel` events are silently dropped (verified). Allowlisted
plugins like `fakechat` do activate; custom ones only (maybe) activate interactively.

So for reliable, headless async delivery this broker **is the SDK driver** and injects
the approval/rejection as a normal user message via the streaming input (`streamInput`).
That is the same wake mechanism a channel would use, minus the activation problem.

## Architecture notes

- **Broker = SDK driver.** It runs `query()` (which drives the same `claude` engine),
  owns `canUseTool` (the policy engine), and owns the input stream.
- **`canUseTool` is the policy point.** Here it just denies `SandboxNetworkAccess` and
  allows everything else. A real broker would allow read-only/private-write host actions
  by policy and only ticket the risky ones.
- **The escalation tool runs in an isolated context.** The SDK runs in-process MCP tool
  handlers isolated from the driver, so the tool and the driver **communicate via the
  filesystem** (`pending/` + `verdicts/`), not shared memory. (This bit us during
  development; it's why the tool writes a file instead of touching a Map.)
- **Chat is not the broker's job.** The first injected message stands in for chat. In
  real use, chat arrives on a normal channel — fakechat, or **Remote Control** from your
  phone — and feeds the same `inject()`; the broker only manages requests + notifications.

## Run it

```bash
cd example
# deps (already vendored here; to reinstall):  bun add @anthropic-ai/claude-agent-sdk zod
node broker.mjs
```

The agent (per the built-in demo task) asks the broker to run `echo hello-async`. Watch
`~/.clawmini-demo/pending/` for the request, then in another terminal:

```bash
./approve REQ-1     # broker runs echo on the host, agent wakes and reports "hello-async"
# or
./deny REQ-1        # agent wakes, reports the rejection, won't retry
```

Set your own task: `DEMO_TASK="…" node broker.mjs`.

### Chat via the fakechat channel (verified)

Instead of the hardcoded task, chat with the agent through the real fakechat channel:

```bash
# one-time: /plugin install fakechat@claude-plugins-official  (from inside `claude`)
USE_FAKECHAT=1 node broker.mjs
```

Open **http://localhost:8787** and type a message, e.g.:

> Please run the host command: echo hello-from-fakechat — I want to see the output.

The agent replies in the fakechat UI that it has filed a broker request, then keeps
going. Approve it from another terminal with `./approve REQ-1` (or `./deny REQ-1`); the
agent is notified asynchronously and posts the command output back into the fakechat UI.
This is the full loop — chat in via a normal channel, escalation via the broker, async
approval, reply out via the channel — with the broker only handling requests +
notifications.

## Files

| File | Role |
|---|---|
| `broker.mjs` | The whole thing: SDK driver + `canUseTool` policy + `request_action` tool + verdict watcher that injects the async outcome. |
| `approve` / `deny` | One-line human decision helpers (`touch` a verdict file). No web UI. |
| `~/.clawmini-demo/` | Runtime state: `pending/` requests, `verdicts/` decisions, `counter`. |

## What this is NOT (yet)

Deliberately omitted for minimalism — see the proposal for the full design: policy
engine (auto-approve read-only/private-write), payload snapshotting/CAS (TOCTOU),
reviewer LLM, cooldowns, audit log, a real approval UI (tailnet + passkey), and the
crown-jewel filesystem deny rules. This example is just the request → async approve/reject
→ notify loop.
