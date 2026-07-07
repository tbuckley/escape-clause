# Reference

Quick lookups: the terms Escape Clause uses and the ports it binds. For how the pieces
fit together, see [ARCHITECTURE.md](ARCHITECTURE.md); for the threat model,
[SECURITY.md](SECURITY.md).

## Words you'll meet

| Term | Meaning |
|---|---|
| **MCP server** | A local process exposing tools an agent can call ([Model Context Protocol](https://modelcontextprotocol.io)). The broker is one. |
| **Channel** | A Claude Code mechanism that can *push* messages into a running session — how approvals wake the agent without polling. See the [channels docs](https://code.claude.com/docs/en/channels-reference). |
| **fakechat** | An off-the-shelf Claude Code plugin channel that serves a local web chat UI — how you talk to the sandboxed agent. Not part of this repo. |
| **Broker** | This project's MCP server + channel: files tickets, runs policies, serves the approval UI, pushes outcomes back. |
| **Ticket** | A snapshotted request (`REQ-N`) — approving runs the exact command/script captured at request time, not whatever changed since. |
| **Policy** | A named, hash-pinned script with a risk class; `readonly` ones auto-run, risky classes always ticket. |
| **Protected install** | `~/.escape-clause/` — broker code + state, deliberately outside every workspace the agent can touch. |

## Ports

Everything binds to localhost. You only ever open the first two in a browser; the
proxies exist to refuse.

| Port | What | Who serves it |
|---|---|---|
| 8787 | fakechat — chat with the agent | fakechat plugin |
| 8790 | approval UI | broker (`ESCAPE_CLAUSE_UI_PORT` moves it) |
| 8791 | deny-all HTTP proxy (all sandboxed egress dies here) | broker (`ESCAPE_CLAUSE_PROXY_PORT` moves the pair) |
| 8792 | deny-all SOCKS5 proxy (git-ssh, ftp, grpc, rsync) | broker (always HTTP proxy port + 1) |
