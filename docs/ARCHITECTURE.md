# How Escape Clause works

This is the deep dive on the moving parts: the launcher, the channel setup, the
permission relay, and the deny-all egress proxy. For the layered security model —
*why* the broker and the approve path are out of the agent's reach — see
[SECURITY.md](SECURITY.md). For a component-by-component map of the source, see the
[repo layout table in the README](../README.md#repo-layout).

## The launcher

Two commands with one job each:

1. **`escape-clause.sh init <workspace>` stamps the workspace config** —
   `.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json` — from the
   protected install, and drops a `CLAUDE.md` if the workspace has none.
2. **`escape-clause.sh launch <workspace>` runs claude** — it prints and execs
   `claude --dangerously-load-development-channels server:broker` in the workspace
   (plus `--channels $ESCAPE_CLAUSE_CHANNELS` if you opted into a chat channel). First,
   though, it verifies the stamped config is byte-identical to what `init` would write
   right now; if not — a stale init, changed `ESCAPE_CLAUSE_*` env, or tampering — it
   refuses and tells you to inspect and re-run `init`. Tampering from inside the box
   shouldn't be possible at all (file tools are guard-blocked and sandboxed bash is
   denyWrite-blocked on the config paths), so the verify is a backstop, not the
   defense. A tampered config is never what actually launches, and nothing is
   rewritten behind your back.

- **The chat surface is yours to pick** — the launcher doesn't bundle one. Chat in the
  launch terminal, hand the session to claude.ai or the Claude app with
  `/remote-control` ([remote control docs](https://code.claude.com/docs/en/remote-control)),
  or connect a channel plugin — Telegram, Discord, iMessage, fakechat
  ([channels docs](https://code.claude.com/docs/en/channels)). For a channel, set two
  env vars before `init`/`launch`: `ESCAPE_CLAUSE_CHANNELS` (the `--channels` spec,
  e.g. `plugin:fakechat@claude-plugins-official`; space-separate several) and
  `ESCAPE_CLAUSE_CHANNEL_TOOLS` (comma-separated permission entries for the channels'
  reply tools, e.g. `mcp__plugin_fakechat_fakechat` — stamped into the allow-list so
  replies aren't auto-denied by the `deny` relay mode). If you chat over remote control
  or a channel, make the approval UI reachable from your device — see
  [Sharing a request with a remote user](#sharing-a-request-with-a-remote-user).
- `--dangerously-load-development-channels server:broker` — promotes the broker MCP
  server to a channel so it can push notifications (custom channels need this flag
  during the research preview). The broker itself loads from the stamped `.mcp.json`
  (`enableAllProjectMcpServers` + the pre-trust in the stamped `settings.local.json`) —
  and its command path points into `~/.escape-clause/app`, not the workspace.

Both commands refuse the broker source tree and the protected store as workspaces —
the whole point is keeping broker code out of the agent's reach.

The stamped sandbox config lands at `<workspace>/.claude/settings.json` so it
auto-loads — no `--settings` flag needed. You can confirm the sandbox is live by asking
the agent to run `env | grep SANDBOX_RUNTIME` — `SANDBOX_RUNTIME=1` only appears when
sandboxed (and `HTTP_PROXY` should point at the deny-all proxy on `:8791`).

## Why interactive claude (and not headless `-p`)

Pushing an async approve/reject notification into a running session needs the channel
spec, and a *custom* channel plugin **does not activate in headless (`-p`) mode** — its
notifications are silently dropped (verified). In an interactive session it does
activate and deliver, so the full loop works: chat in (terminal, remote control, or a
channel) → agent files a broker request → you approve → the broker pushes a
`<channel source="broker">` notification → the agent wakes and acts on it. (An earlier variant drove headless claude
via the Agent SDK's input stream — see git history for that pattern.)

## Sharing a request with a remote user

When the agent files a ticket it gets back a credential-free `url` (e.g.
`http://127.0.0.1:8790/?req=REQ-2`) and is told to relay it, so a user chatting
remotely — over remote control or a channel — gets a link straight to that request,
which the UI scrolls to and highlights. On a device that hasn't signed in yet, the link
lands on the login form first — enter the password once and the request is right there.

A localhost link only resolves on the machine running the broker, and the UI server
deliberately binds to `127.0.0.1` only — never `0.0.0.0` — so no `ESCAPE_CLAUSE_*`
setting exposes it to the network. Remote chat therefore needs two things:

1. **Forward traffic to the loopback port.** [Tailscale](https://tailscale.com) is the
   recommended way: `tailscale serve --bg 8790` proxies
   `https://<machine>.<tailnet>.ts.net` (tailnet-only, TLS included) to
   `127.0.0.1:8790`. An SSH tunnel or any reverse proxy you trust also works.
2. **Set `ESCAPE_CLAUSE_UI_URL`** to that reachable address (e.g.
   `https://<machine>.<tailnet>.ts.net`) when you run `init`, so shared links carry it;
   it defaults to `http://127.0.0.1:<port>`. This changes only the URL written into
   links and pages — not what the server listens on.

The shared URL is deliberately credential-free — the sandboxed agent never receives the
password or a session, only a pointer to the request.

## Permission relay — answer the terminal's own prompts from the UI

The broker also declares the channel
[permission-relay capability](https://code.claude.com/docs/en/channels-reference#relay-permission-prompts)
(`claude/channel/permission`). When Claude Code itself opens a tool-approval dialog — a
`Bash`/`Write`/`Edit` prompt — it forwards that prompt to the broker, which surfaces it
in the same 8790 queue as a `permission` item (with an AI risk summary). Approve/Deny
there emits the verdict back to Claude Code. The terminal dialog stays open in parallel;
whichever answers first wins, so this is a second way to answer, not an auto-deny.

Set the mode with `ESCAPE_CLAUSE_RELAY` when you run `init` — it's stamped into the
workspace `.mcp.json` env. Keep it set for `launch` too, since launch verifies the
config against the current environment:

```bash
export ESCAPE_CLAUSE_RELAY=forward
~/.escape-clause/app/escape-clause.sh init ~/escape-clause-workspace
~/.escape-clause/app/escape-clause.sh launch ~/escape-clause-workspace
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

The broker is the right home for this capability and **a chat channel is not**: the
docs warn that anyone who can reply through a permission-relaying channel can approve or
deny tool use, so it may only be declared on a channel that authenticates the approver.
The broker's UI is behind a password login; a chat surface like fakechat has no auth, so
it must never declare it.

Note the relay does **not** cover the `SandboxNetworkAccess` prompt (a sandboxed command
reaching an off-allowlist domain) — that never relays in any mode (verified). Killing
those prompts is the deny-all proxy's job, below.

## Deny-all egress proxy

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

## Viewer proxy — browsing agent-built web apps without an exfil path

The sandbox blocks the agent's *egress*, but the agent can still bind dev servers on
localhost — that's inbound, and it's the whole point of asking it to build you a web
app. The catch is where that page eventually runs: **your browser, on your device,
outside every sandbox rule**. A page the agent authored can `fetch()` any origin on
the open internet the moment you open it, or dress up a link that navigates you
somewhere else with data packed into the URL — a clean exfiltration channel that never
touches the deny-all proxy.

`viewer.mjs` closes that channel by making *your browser* the last sandbox wall. The
broker starts one viewer listener per agent app port (`8793+i → ESCAPE_CLAUSE_APP_PORTS[i]`,
default a single `8793 → 3000`), each a reverse proxy that stamps every response with:

- **`Connection-Allowlist: (response-origin)`** — Chrome's
  [connection allowlist](https://developer.chrome.com/blog/connection-allowlists-origin-trial)
  (origin trial in Chrome 148–151, shipping by default in 152). The browser blocks
  **every** connection the page initiates — subresource fetches, *link navigations*,
  redirects, WebSocket/WebRTC/WebTransport, prefetch/preload — unless the destination
  is on the list. `response-origin` means the page may talk only to the viewer's own
  origin: both exfil paths (background fetch *and* the disguised link) die in the
  browser.
- **`Origin-Trial: <your token(s)>`** — enables the trial before Chrome 152. Register
  the exact origin you browse from (e.g. `https://<machine>.<tailnet>.ts.net:8793`) at
  the [origin trials dashboard](https://developer.chrome.com/origintrials) and paste
  the token(s), one per line, into `~/.escape-clause/secrets/origin-trial-tokens`
  (picked up per-request — no restart). Omitted if the file doesn't exist.
- **`Content-Security-Policy`** (same-origin `default-src`, `form-action 'self'`,
  `base-uri 'self'`, `object-src 'none'`) — the widely-supported fallback: the same
  posture for fetches, subresources, and form posts in every browser. CSP cannot block
  a plain `<a>` click to another origin — that's exactly the gap Connection-Allowlist
  closes, which is why both are sent.
- `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`.

Any attempt by the upstream (agent-controlled) server to set these headers itself —
including `Connection-Allowlist`, any CSP, `Origin-Trial`, reporting endpoints, or a
`Refresh` redirect header — is **stripped before ours are written**, so the page can
never loosen the policy it's served under. WebSocket upgrades (dev-server HMR) are
spliced through untouched; where the *page* may dial is already governed by its
document's headers. Need a deliberate hole (say, the app genuinely calls one external
API)? `ESCAPE_CLAUSE_VIEWER_ALLOW=https://api.example.com` adds that origin to both
the allowlist and the CSP.

Like everything else, the viewer binds loopback only. Put it on your tailnet next to
the approval UI (the convention is tailnet HTTPS port = viewer port, so URLs stay
predictable and `:443` stays reserved for the UI):

```bash
tailscale serve --bg 8790                 # approval UI  → https://<machine>.<tailnet>.ts.net
tailscale serve --bg --https=8793 8793    # app viewer   → https://<machine>.<tailnet>.ts.net:8793
```

You can also let the **agent** manage this step: the seeded `tailscale-serve` policy
(class `private-write`, so it auto-runs) accepts `on <viewer-port>` /
`off <viewer-port>` / `status`. Auto-run is earned, not assumed: the pinned script
refuses every port not on the broker-published list (`~/.escape-clause/viewer-ports`,
written by `viewer.mjs` at startup — never taken from the agent's arguments), so the
agent cannot serve a raw app port (bypassing the headers), cannot touch the `:443`
mapping your approval UI lives on, and never reaches `tailscale funnel` (public
internet). What it can expose is tailnet-private *and* viewer-hardened — both halves
of "private" — which is what justifies the `private-write` class.

Two rules make the design hold:

1. **Never `tailscale serve` an agent port directly.** The agent's own server would
   pick its own headers. Only the viewer ports go on the tailnet; the stamped
   workspace `CLAUDE.md` tells the agent to serve on the app ports and to keep
   everything same-origin.
2. **Keep the viewer on a different port (origin) than the approval UI** — the default.
   Same-*site* is unavoidable on one ts.net hostname, which is why the UI additionally
   refuses cross-origin POSTs server-side (see `server.mjs`), but same-*origin* would
   let an agent page use the UI's logged-in session outright.

### The self-check page

"Am I actually protected?" shouldn't be unfalsifiable until the day it matters, so
every viewer port serves a self-check page at `/__escape-clause-check__` — answered by
the viewer itself (never proxied; it works with no app running, and an agent app can
never serve that path through the viewer), with the same header set an app response
gets. Its checks are layered, because no single probe covers everything:

- **Are you on the viewer at all?** The page's status endpoint only exists on viewer
  ports — hitting a raw agent port by mistake fails loudly. It also shows which app
  port this viewer fronts and the exact allowlist being enforced.
- **Token sanity.** Your origin-trial token(s) are decoded (not signature-verified —
  only Chrome can do that) and compared against the page's own origin: a token
  registered for the wrong port, or expired, is flagged before you'd silently browse
  unprotected. Plus a browser-version hint (Chromium ≥ 148 trial, ≥ 152 default-on).
- **CSP layer (automatic, every browser).** A canary `<img>` must fire
  `securitypolicyviolation` — positive proof the fallback layer enforces. The canary
  host is under the RFC 2606-reserved `.example` TLD, so even a fully unprotected
  browser only gets NXDOMAIN; nothing real is ever contacted.
- **Connection-Allowlist itself (automatic, Chrome).** CSP blocks fetches *before*
  the allowlist ever sees them, so this probe runs in an iframe whose response —
  alone — loosens `connect-src` for the canary and adds a `report-to` param plus a
  `Reporting-Endpoints` header pointing back at the viewer. A violation report
  arriving is positive proof the allowlist is actively enforcing. Agent app
  responses never get this loosened variant.
- **The manual link test (ground truth).** A plain `<a>` to another origin — the one
  vector CSP cannot block and the reason the origin trial matters. If the click is
  blocked, you're protected; if example.com loads, that browser would follow a
  disguised link out of an agent app.

Run it per browser and per device, after browser updates, and after rotating tokens.
(The `/__escape-clause-check__` path prefix is reserved by the viewer; an app using
that exact path would be shadowed — pick another name.)

Residual gaps, stated honestly: a non-Chrome browser (or Chrome without a valid token,
before 152) ignores `Connection-Allowlist`, leaving only the CSP layer — fetches and
forms still blocked, but a disguised cross-origin *link* would navigate. Until the
feature ships everywhere you browse from, open agent apps in Chrome ≥ 148 with your
token installed — and let the self-check page prove it. And nothing about the viewer
stops the agent from *asking you in chat* to visit an external URL — links in chat
deserve the same suspicion as ticket justifications.
