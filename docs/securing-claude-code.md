# Securing Claude Code with its settings

How to lock down a stock Claude Code install using nothing but its settings format —
no broker, no wrapper scripts. This is the subset of Claude Code that Escape Clause
builds on; for why this repo goes further (deny-all proxy, human-approved escapes),
see [SECURITY.md](SECURITY.md) and [securing-agent.md](securing-agent.md).

Everything below uses documented keys from the official
[settings](https://code.claude.com/docs/en/settings),
[permissions](https://code.claude.com/docs/en/permissions), and
[sandboxing](https://code.claude.com/docs/en/sandboxing) docs. Sandboxing is a preview
feature; syntax last verified against **Claude Code v2.1.202** (the version this repo
targets).

## Where settings live

Claude Code merges settings from several files. Higher entries win; deny rules at
*any* level beat allow rules at every level.

| File | Scope |
|---|---|
| `/etc/claude-code/managed-settings.json` (or MDM/registry) | Machine-wide, cannot be overridden |
| CLI flags (`--settings`, `--add-dir`, …) | This invocation |
| `.claude/settings.local.json` | This project, personal (gitignored) |
| `.claude/settings.json` | This project, shared (committed) |
| `~/.claude/settings.json` | All your projects |

Put security config in the **project** `.claude/settings.json` when it protects a
repo, and in **managed settings** when users shouldn't be able to loosen it — a user
can always edit their own project files, so project-level rules are a guardrail
against the *agent*, not against the human.

## Two layers: permissions and the sandbox

Claude Code has two independent enforcement mechanisms, and a hardened setup uses both:

- **Permissions** (`permissions.allow` / `deny` / `ask`) gate *tool calls* — which
  tools the model may invoke, with what arguments, and whether you're prompted. They
  are enforced by Claude Code itself.
- **The sandbox** (`sandbox.*`) confines *what a Bash command can actually do* at the
  OS level — Seatbelt on macOS, bubblewrap + socat on Linux/WSL2 (install with
  `apt install bubblewrap socat`). A sandboxed `curl` fails even if the model was
  allowed to run it.

Permissions alone are bypassable by a sufficiently creative shell command (`python -c
"import urllib..."` isn't `curl`). The sandbox alone doesn't cover network-capable
tools like `WebFetch`, which run in the Claude Code process, not in a shell. Use
permissions to remove tools, and the sandbox to contain the ones that remain.

A minimal hardened baseline:

```json
{
  "permissions": {
    "defaultMode": "default",
    "deny": ["WebFetch", "WebSearch"]
  },
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "autoAllowBashIfSandboxed": true,
    "allowUnsandboxedCommands": false,
    "network": { "allowedDomains": [] },
    "filesystem": {
      "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gcloud"]
    }
  }
}
```

What each piece buys you:

- `sandbox.enabled` — every Bash command runs inside the OS sandbox: writes are
  confined to the workspace, network is confined to `allowedDomains`.
- `failIfUnavailable` — refuse to start rather than silently run unsandboxed on a
  machine missing bubblewrap/Seatbelt.
- `allowUnsandboxedCommands: false` — close the escape hatch where a command that
  fails in the sandbox gets re-offered as a normal permission prompt outside it.
- `autoAllowBashIfSandboxed` — since the sandbox is doing the enforcement, sandboxed
  commands run without prompting. This is what makes a locked-down agent *usable*:
  safety comes from the box, not from you reviewing every `ls`.
- `network.allowedDomains: []` — deny all Bash network egress (see below).
- `denyRead` — keep credentials out of the box entirely, so a prompt-injected agent
  has nothing to exfiltrate even if it finds a hole.
- Denying `WebFetch`/`WebSearch` — these tools do their own networking outside the
  sandbox, so if you want "no network", they must be removed at the permissions layer.

## Limiting folder access

Two knobs, one per layer:

**Sandbox filesystem rules** (`sandbox.filesystem`) are OS-enforced and apply to Bash.
By default the sandbox allows reads everywhere and writes only in the workspace;
tighten or extend with:

```json
{
  "sandbox": {
    "enabled": true,
    "filesystem": {
      "denyRead":  ["~/.ssh", "~/.aws", "~/Documents/taxes"],
      "denyWrite": ["./.claude", "./.mcp.json"],
      "allowWrite": ["/tmp/build"]
    }
  }
}
```

Paths accept `/absolute`, `~/home-relative`, and `./project-relative` forms. `allowRead`
carves exceptions back out of a denied region — `"denyRead": ["~/"]` with
`"allowRead": ["."]` hides your entire home directory from Bash while keeping a
workspace that lives under it readable. Note the
`denyWrite` on `./.claude` and `./.mcp.json`: the settings file lives *inside* the
workspace the agent can write to, so an agent that can edit `.claude/settings.json`
can turn its own sandbox off at the next session. Escape Clause additionally verifies
these files byte-for-byte at launch; without that, `denyWrite` on the config is the
minimum.

**Permission path rules** gate the `Read`/`Edit`/`Write` file tools:

```json
{
  "permissions": {
    "deny": [
      "Read(./.env)",
      "Read(./secrets/**)",
      "Edit(//etc/**)"
    ]
  }
}
```

Patterns are gitignore-style: `//` prefix for absolute paths, `~/` for home, plain or
`./` for project-relative.

**To grant an additional folder** beyond the workspace, use
`permissions.additionalDirectories` (or `--add-dir` on the CLI, or `/add-dir` in a
session):

```json
{
  "permissions": {
    "additionalDirectories": ["~/shared-notes", "/data/fixtures"]
  }
}
```

Keep this list as small and as read-mostly as you can — every directory you add is
more private data inside the box (one more leg of the
[lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)). If the
agent also needs to *write* there under the sandbox, add the same path to
`sandbox.filesystem.allowWrite`.

## Limiting network access

Sandboxed Bash egress goes through a proxy that enforces a domain allowlist:

```json
{
  "sandbox": {
    "enabled": true,
    "network": {
      "allowedDomains": ["github.com", "*.npmjs.org"],
      "deniedDomains": []
    }
  }
}
```

- `allowedDomains: []` means **no network at all** — every fetch, clone, and install
  fails. This is Escape Clause's default posture.
- Wildcards like `*.npmjs.org` match subdomains. `deniedDomains` carves exceptions out
  of a broader allow.
- **To allow an additional domain**, append it to `allowedDomains`. Prefer narrow,
  well-understood hosts (a package registry, your company's git host) over anything a
  webpage can redirect: any allowed domain that serves user-controlled content is a
  potential exfiltration channel *and* a prompt-injection source.

Remember the tools that bypass the sandbox proxy: deny `WebFetch` and `WebSearch`
outright, or scope them per-domain at the permissions layer —
`"allow": ["WebFetch(domain:docs.example.com)"]` with `"deny": ["WebFetch(domain:*)"]`.
MCP servers you connect also do their own networking; only connect ones you trust
with the reach they have, and pin the set with `enabledMcpjsonServers` /
`deniedMcpServers` so the agent can't quietly gain new ones.

## Recipes

### 1. Workspace only, no network (strictest)

The agent can read and edit the project, run builds and tests, and nothing else. Good
default for working on untrusted code or with private data in the repo.

```json
{
  "permissions": {
    "defaultMode": "default",
    "deny": ["WebFetch", "WebSearch"]
  },
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "autoAllowBashIfSandboxed": true,
    "allowUnsandboxedCommands": false,
    "network": { "allowedDomains": [] },
    "filesystem": {
      "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gcloud"],
      "denyWrite": ["./.claude", "./.mcp.json"]
    }
  }
}
```

Trade-off: `npm install`, `git push`, and doc lookups all fail. Pre-install
dependencies before the session, or handle escapes out-of-band (that gap is exactly
what Escape Clause's broker exists for).

### 2. Web app development on localhost

Same box, but the agent can start a dev server, curl it, and run browser tests
against it. Loopback stays inside the machine, so this doesn't reopen the
exfiltration channel — just don't allowlist real domains alongside it out of habit.

```json
{
  "permissions": {
    "defaultMode": "default",
    "deny": ["WebFetch", "WebSearch"]
  },
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "autoAllowBashIfSandboxed": true,
    "allowUnsandboxedCommands": false,
    "network": { "allowedDomains": ["localhost", "127.0.0.1"] },
    "filesystem": {
      "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gcloud"],
      "denyWrite": ["./.claude", "./.mcp.json"]
    }
  }
}
```

Caveat: the moment *you* open that dev server in a real browser, the page can fetch
anywhere — the sandbox confines the agent's processes, not your browser. Treat
"agent-authored web app in my browser" as network access for review purposes (see
[securing-agent.md](securing-agent.md) for the siloed-subagent approach).

### 3. Allow package registries

Development needs `npm install` / `pip install` but nothing else. Registries are a
real (if audited) exfiltration and supply-chain surface, so this is a step down in
strictness — take it deliberately.

```json
{
  "sandbox": {
    "enabled": true,
    "network": {
      "allowedDomains": ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"]
    }
  }
}
```

### 4. Add a second folder

The project needs fixtures from a sibling directory, read-write:

```json
{
  "permissions": {
    "additionalDirectories": ["../fixtures"]
  },
  "sandbox": {
    "enabled": true,
    "filesystem": { "allowWrite": ["../fixtures"] }
  }
}
```

Drop the `allowWrite` entry if read-only access is enough — it usually is.

## Gotchas

- **`settings.local.json` merges in.** A permissive local file can add allow rules on
  top of the shared one (deny rules still win everywhere). Check both when auditing.
- **The config is in the writable workspace.** `denyWrite` on `./.claude` and
  `./.mcp.json` (and a hook guarding the file tools) is what keeps the agent from
  editing its own cage; verify at launch if you can.
- **`--dangerously-skip-permissions` skips permissions, not the sandbox** — but the
  person at the keyboard can also just not enable the sandbox. Settings protect you
  from the agent; managed settings (plus
  `permissions.disableBypassPermissionsMode`) protect an org from its users.
- **Hooks run as you, outside the sandbox.** Only load hooks from paths the agent
  can't write, and make them fail closed (`… || exit 2`).
- **Sandbox needs platform support**: built-in on macOS; `bubblewrap` + `socat` on
  Linux/WSL2; unavailable on native Windows and WSL1. `failIfUnavailable: true` turns
  "silently unprotected" into a startup error.
