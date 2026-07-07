# Reference

Quick lookups: the terms Escape Clause uses and the ports it binds. For how the pieces
fit together, see [ARCHITECTURE.md](ARCHITECTURE.md); for the threat model,
[SECURITY.md](SECURITY.md).

## Words you'll meet

| Term | Meaning |
|---|---|
| **MCP server** | A local process exposing tools an agent can call ([Model Context Protocol](https://modelcontextprotocol.io)). The broker is one. |
| **Channel** | A Claude Code mechanism that can *push* messages into a running session — how approvals wake the agent without polling. See the [channels docs](https://code.claude.com/docs/en/channels-reference). |
| **Chat surface** | How you talk to the sandboxed agent: the launch terminal itself, [remote control](https://code.claude.com/docs/en/remote-control) (claude.ai / the Claude app), or an optional channel plugin (Telegram, Discord, iMessage, fakechat). |
| **fakechat** | An off-the-shelf Claude Code plugin channel that serves a local web chat UI — one optional chat surface. Not part of this repo. |
| **Broker** | This project's MCP server + channel: files tickets, runs policies, serves the approval UI, pushes outcomes back. |
| **Ticket** | A snapshotted request (`REQ-N`) — approving runs the exact command/script captured at request time, not whatever changed since. |
| **Policy** | A named, hash-pinned script with a risk class; `readonly` ones auto-run, risky classes always ticket. |
| **Protected install** | `~/.escape-clause/` — broker code + state, deliberately outside every workspace the agent can touch. |

## Ports

Everything binds to localhost. The approval UI is the only port you must open in a
browser (over Tailscale if you chat remotely); the proxies exist to refuse.

| Port | What | Who serves it |
|---|---|---|
| 8790 | approval UI | broker (`ESCAPE_CLAUSE_UI_PORT` moves it) |
| 8791 | deny-all HTTP proxy (all sandboxed egress dies here) | broker (`ESCAPE_CLAUSE_PROXY_PORT` moves the pair) |
| 8792 | deny-all SOCKS5 proxy (git-ssh, ftp, grpc, rsync) | broker (always HTTP proxy port + 1) |
| 8787 | fakechat web chat — only if you connect the optional fakechat channel | fakechat plugin |

## Environment variables

All read by `escape-clause.sh`; the stamped config is a function of them, so run `init`
and `launch` with the same values set.

| Variable | What it does |
|---|---|
| `ESCAPE_CLAUSE_DIR` | Moves the protected install (default `~/.escape-clause`). |
| `ESCAPE_CLAUSE_UI_PORT` | Approval-UI port (default `8790`). |
| `ESCAPE_CLAUSE_UI_URL` | Base URL written into shared ticket links (default `http://127.0.0.1:<port>`). Link text only — the server always binds loopback; expose it with e.g. `tailscale serve` and set this to that address. |
| `ESCAPE_CLAUSE_PROXY_PORT` | Deny-all HTTP proxy port; SOCKS is always +1 (default `8791`). |
| `ESCAPE_CLAUSE_RELAY` | Permission-relay mode: `forward`, `deny` (default), or `off`. |
| `ESCAPE_CLAUSE_CHANNELS` | Optional `--channels` spec(s) for chat channel plugins, e.g. `plugin:fakechat@claude-plugins-official` (space-separate several). |
| `ESCAPE_CLAUSE_CHANNEL_TOOLS` | Comma-separated permission entries for those channels' reply tools, stamped into the allow-list, e.g. `mcp__plugin_fakechat_fakechat`. |
