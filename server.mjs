// Approval web UI + resolution API. This is the ONLY place a ticket can be resolved:
// the MCP surface (broker.mjs) can create and read tickets but has no resolve tool, so
// there is no code path from an agent-invokable interface to an approval.
//
// Reaching it: binds 127.0.0.1 only (never 0.0.0.0); the sandbox's empty network
// allowlist blocks the agent from localhost entirely (verified — see the audit's Part E).
//
// Auth: password login (the password lives in the denyRead-protected secrets dir) mints a
// session token set as an HttpOnly SameSite=Lax cookie. Every API route requires a
// session, so the token-free ?req=... links the agent shares land on a login form and
// become actionable after one login per device. Approvals are POST-only from the page
// that renders the full payload — no approve-by-link, and the cookie is invisible to page
// JS. Scripts can use the session from /api/login's response body as a Bearer header.
import { createServer } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import { uiPassword, createSession, checkSession, destroySession, listTickets, audit, DIR } from './store.mjs'

const COOKIE = 'escape_clause_session'
const SESSION_MAX_AGE_S = 30 * 24 * 3600

// Constant-time string compare (hash both sides so length never leaks).
const safeEqual = (a, b) => {
  const h = (x) => createHash('sha256').update(String(x)).digest()
  return timingSafeEqual(h(a), h(b))
}

function sessionOf(req) {
  const m = /(?:^|;\s*)escape_clause_session=([0-9a-f]{64})/.exec(req.headers.cookie || '')
  if (m && checkSession(m[1])) return m[1]
  const b = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization || '')
  if (b && checkSession(b[1])) return b[1]
  return null
}

export function startServer({ port, baseUrl, resolveTicket, log }) {
  uiPassword() // seed on first run so the file exists for the human to find
  const page = PAGE.replace(/__BASE_URL__/g, baseUrl || `http://127.0.0.1:${port}`)
  const sseClients = new Set()
  const broadcast = () => { for (const c of sseClients) c.write('data: update\n\n') }

  // Brute-force damper: 5 straight failures -> 30s lockout (single shared counter — the
  // UI is single-operator; anything noisier belongs in audit.log anyway).
  let failures = 0, lockedUntil = 0

  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    try {
      if (req.method === 'GET' && path === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page)
        return
      }
      if (req.method === 'POST' && path === '/api/login') {
        if (Date.now() < lockedUntil) {
          res.writeHead(429, { 'content-type': 'text/plain' }).end('too many attempts — wait 30s')
          return
        }
        const body = await readBody(req)
        if (!safeEqual(String(body.password || ''), uiPassword())) {
          if (++failures >= 5) { lockedUntil = Date.now() + 30_000; failures = 0 }
          audit('ui_login_failed', {})
          res.writeHead(401, { 'content-type': 'text/plain' }).end('wrong password')
          return
        }
        failures = 0
        const session = createSession()
        audit('ui_login', {})
        log('UI LOGIN ok — session created')
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': `${COOKIE}=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_S}`,
        }).end(JSON.stringify({ ok: true, session }))
        return
      }

      // Everything below requires a session.
      const session = sessionOf(req)
      if (!session) {
        res.writeHead(401, { 'content-type': 'text/plain' }).end('not logged in')
        return
      }
      if (req.method === 'POST' && path === '/api/logout') {
        destroySession(session)
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
        }).end(JSON.stringify({ ok: true }))
      } else if (req.method === 'GET' && path === '/api/tickets') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(listTickets()))
      } else if (req.method === 'GET' && path === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        res.write('data: hello\n\n')
        sseClients.add(res)
        req.on('close', () => sseClients.delete(res))
      } else if (req.method === 'POST' && /^\/api\/tickets\/(REQ-\d+|PERM-[a-km-z]{5})\/(approve|deny)$/.test(path)) {
        const [, , , id, verdict] = path.split('/')
        const body = await readBody(req)
        const result = await resolveTicket(id, verdict === 'approve' ? 'approved' : 'rejected', String(body.message || ''))
        if (result.error) res.writeHead(409, { 'content-type': 'text/plain' }).end(result.error)
        else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }))
        broadcast()
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
      }
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end(String(e?.message || e))
    }
  })

  // If the port is taken (e.g. a second session), keep the MCP side alive — the UI is
  // served by whichever broker got the port; they share the same ticket store.
  server.on('error', (e) => log(`web UI failed to start: ${e.message} (MCP tools still up)`))
  server.listen(port, '127.0.0.1', () =>
    log(`web UI ready: http://127.0.0.1:${port}/   (login password: ${DIR}/secrets/password)`))
  return { broadcast }
}

function readBody(req) {
  return new Promise((res) => {
    let data = ''
    req.on('data', (d) => { data += d; if (data.length > 1e6) req.destroy() })
    req.on('end', () => { try { res(JSON.parse(data || '{}')) } catch { res({}) } })
  })
}

// Single self-contained page: no framework, no build step, no external requests.
// Auth is the HttpOnly session cookie — page JS never sees a credential; it only posts
// the password once at login. Without a session the page shows the login form.
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Escape Clause broker — approvals</title>
<style>
  body{font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;background:#f4f5f7;color:#1b1e22}
  header{background:#16181c;color:#fff;padding:12px 20px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
  header h1{font-size:15px;margin:0;font-weight:600}
  #authstate{font-size:12px;color:#e8b84d}
  #authstate button{background:none;border:1px solid #555;color:#ccc;font-size:11px;padding:2px 10px}
  main{max-width:900px;margin:20px auto 60px;padding:0 16px}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:#5b6472;margin:26px 0 10px}
  .card{background:#fff;border:1px solid #dce0e6;border-radius:10px;padding:14px 16px;margin-bottom:12px;scroll-margin-top:16px}
  .card.resolved{opacity:.75}
  .card.focus{border-color:#7a5ea8;box-shadow:0 0 0 3px rgba(122,94,168,.35)}
  .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .id{font-weight:700;font-family:ui-monospace,Menlo,monospace}
  .tag{font-size:11px;padding:2px 8px;border-radius:99px;background:#e8ebf0;color:#3d4550}
  .tag.approved{background:#dcf2df;color:#1d7a2e}.tag.rejected{background:#fbe3e3;color:#b3261e}.tag.pending{background:#fdf1de;color:#9a6b00}
  .risk{font-size:11px;font-weight:700;padding:2px 8px;border-radius:99px}
  .risk-low{background:#dcf2df;color:#1d7a2e}.risk-medium{background:#fdf1de;color:#9a6b00}.risk-high{background:#fbe3e3;color:#b3261e}
  .age{margin-left:auto;font-size:12px;color:#8a93a0}
  pre{background:#f0f2f5;border:1px solid #e3e6eb;border-radius:6px;padding:9px 11px;overflow-x:auto;margin:8px 0;font-size:12.5px;white-space:pre-wrap;word-break:break-all}
  .lbl{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#7a828e;margin-top:10px}
  .summary{border-left:3px solid #7a5ea8;background:#f7f4fb;border-radius:0 6px 6px 0;padding:8px 12px;margin:8px 0}
  .summary .flags span{display:inline-block;font-size:12px;background:#ece4f7;color:#4d3a75;border-radius:99px;padding:1px 9px;margin:2px 4px 2px 0}
  .claim{border:1.5px dashed #c9a227;background:#fdf9ec;border-radius:6px;padding:8px 12px;margin:8px 0;font-size:13px}
  .claim .lbl{color:#9a6b00;margin-top:0}
  .actions{display:flex;gap:8px;margin-top:12px;align-items:center;flex-wrap:wrap}
  button{border:0;border-radius:7px;padding:7px 16px;font-size:13px;font-weight:600;cursor:pointer}
  button:disabled{opacity:.45;cursor:not-allowed}
  .ok{background:#1d7a2e;color:#fff}.no{background:#b3261e;color:#fff}
  input[type=text],input[type=password]{flex:1;min-width:180px;border:1px solid #ccd2da;border-radius:7px;padding:7px 10px;font-size:13px}
  .empty{color:#8a93a0;font-style:italic}
  .out{max-height:200px;overflow-y:auto}
  #login{max-width:420px;margin:60px auto;background:#fff;border:1px solid #dce0e6;border-radius:10px;padding:22px}
  #login h2{margin:0 0 8px;text-transform:none;font-size:15px;letter-spacing:0;color:#1b1e22}
  #login p{font-size:13px;color:#5b6472;margin:0 0 14px}
  #login form{display:flex;gap:8px}
  #login button{background:#16181c;color:#fff}
  #loginerr{color:#b3261e;font-size:13px;margin-top:10px;min-height:1em}
  @media (max-width:600px){
    header{padding:10px 14px}
    header h1{font-size:14px}
    main{margin:14px auto 44px;padding:0 10px}
    .card{padding:12px;border-radius:8px}
    pre{font-size:12px;padding:8px 9px}
    input[type=text],input[type=password]{font-size:16px} /* <16px triggers iOS focus-zoom */
    .actions button{flex:1;min-height:44px}
    .actions input[type=text]{flex-basis:100%}
    #login{margin:24px 12px;padding:18px 16px}
    #login form{flex-wrap:wrap}
    #login button{flex:1;min-height:44px}
  }
</style></head>
<body>
<header><h1>Escape Clause broker — approval queue</h1><div id="authstate"></div></header>
<div id="login" hidden>
  <h2>Sign in to review requests</h2>
  <p>The password is on the broker host in <code>~/.escape-clause/secrets/password</code>.
  After signing in, links to individual requests (like the one that brought you here) work directly.</p>
  <form onsubmit="return login(event)">
    <input type="password" id="pw" placeholder="password" autocomplete="current-password" autofocus>
    <button type="submit">Sign in</button>
  </form>
  <div id="loginerr"></div>
</div>
<main hidden>
  <h2>Pending</h2><div id="pending"></div>
  <h2>History</h2><div id="history"></div>
</main>
<script>
function esc(s){var d=document.createElement('div');d.textContent=String(s==null?'':s);return d.innerHTML}
function age(iso){var s=Math.max(0,(Date.now()-Date.parse(iso))/1000)
  return s<60?Math.round(s)+'s ago':s<3600?Math.round(s/60)+'m ago':Math.round(s/3600)+'h ago'}

function facts(t){
  var h=''
  if(t.kind==='permission'){
    h+='<div class="lbl">Claude Code permission request — '+esc(t.tool_name)+' (relayed from the terminal)</div>'
    h+='<pre>'+esc(t.description||'(no description)')+'</pre>'
    if(t.input_preview) h+='<div class="lbl">Input preview</div><pre>'+esc(t.input_preview)+'</pre>'
    h+='<div class="lbl" style="color:#9a6b00">Answering here is parallel to the terminal dialog \\u2014 whichever answers first wins.</div>'
  }
  if(t.kind==='command') h+='<div class="lbl">Exact command (argv — approving runs exactly this)</div><pre>'+esc(JSON.stringify(t.command))+'</pre>'
  if(t.kind==='policy') h+='<div class="lbl">Policy run</div><pre>'+esc(t.policy)+'  (class: '+esc(t.policyClass)+')\\nargs: '+esc(JSON.stringify(t.args||[]))+'</pre>'
  if(t.kind==='policy-registration'){var r=t.registration
    h+='<div class="lbl">'+(r.previousScript?'Policy UPDATE':'New policy')+': '+esc(r.name)+' (class: '+esc(r.class)+')</div>'
    h+='<div>'+esc(r.description)+'</div>'
    if(r.previousScript) h+='<div class="lbl">Current script (installed)</div><pre>'+esc(r.previousScript)+'</pre><div class="lbl">Proposed script (replaces it)</div>'
    else h+='<div class="lbl">Proposed script</div>'
    h+='<pre>'+esc(r.script)+'</pre>'}
  return h
}
function summary(t){
  if(!t.summary) return '<div class="lbl">AI risk summary</div><div class="summary" style="color:#8a93a0">'+(t.status==='pending'?'pending or unavailable — review the raw facts above':'unavailable')+'</div>'
  var s=t.summary
  var h='<div class="lbl">AI risk summary (broker-owned reviewer — advisory only)</div><div class="summary">'
  h+='<span class="risk risk-'+esc(s.risk)+'">'+esc(s.risk.toUpperCase())+'</span> '+esc(s.what_it_does)
  if(s.flags&&s.flags.length){h+='<div class="flags">';for(var i=0;i<s.flags.length;i++)h+='<span>'+esc(s.flags[i])+'</span>';h+='</div>'}
  if(s.exfil_note)h+='<div><b>Exfil:</b> '+esc(s.exfil_note)+'</div>'
  return h+'</div>'
}
function card(t){
  var h='<div class="card'+(t.status==='pending'?'':' resolved')+'" id="t-'+esc(t.ticket)+'"><div class="row">'
  h+='<span class="id">'+esc(t.ticket)+'</span><span class="tag">'+esc(t.kind)+'</span>'
  h+='<span class="tag '+esc(t.status)+'">'+esc(t.status)+'</span><span class="age">'+age(t.created)+'</span></div>'
  h+=facts(t)+summary(t)
  h+='<div class="claim"><div class="lbl">Agent\\u2019s claim (untrusted — may be attacker-controlled)</div>'+esc(t.reason||'(none)')+'</div>'
  if(t.status==='pending'){
    h+='<div class="actions"><button class="ok" onclick="act(\\''+t.ticket+'\\',\\'approve\\')">Approve once</button>'
    h+='<button class="no" onclick="act(\\''+t.ticket+'\\',\\'deny\\')">Deny</button>'
    h+='<input type="text" id="msg-'+t.ticket+'" placeholder="optional message back to the agent (sent on deny)"></div>'
  } else {
    if(t.note)h+='<div class="lbl">Decision note</div><div>'+esc(t.note)+'</div>'
    if(t.output)h+='<div class="lbl">Output</div><pre class="out">'+esc(t.output)+'</pre>'
  }
  return h+'</div>'
}
function render(ts){
  var p=ts.filter(function(t){return t.status==='pending'}),r=ts.filter(function(t){return t.status!=='pending'})
  document.getElementById('pending').innerHTML=p.length?p.map(card).join(''):'<div class="empty">nothing waiting on you</div>'
  document.getElementById('history').innerHTML=r.length?r.map(card).join(''):'<div class="empty">no resolved requests yet</div>'
  focusReq()
}
// The agent-shared link is __BASE_URL__/?req=REQ-N — scroll to and highlight that request.
var focusedOnce=false
function focusReq(){
  var req=new URLSearchParams(location.search).get('req'); if(!req)return
  var el=document.getElementById('t-'+req); if(!el)return
  el.classList.add('focus')
  if(!focusedOnce){focusedOnce=true; el.scrollIntoView({behavior:'smooth',block:'center'})}
}

// Auth flow: probe /api/tickets; a 401 means no session -> show the login form. The
// session lives in an HttpOnly cookie the browser attaches automatically.
var sse=null
function showLogin(){
  document.getElementById('login').hidden=false
  document.querySelector('main').hidden=true
  document.getElementById('authstate').textContent='signed out'
  if(sse){sse.close();sse=null}
}
function showQueue(ts){
  document.getElementById('login').hidden=true
  document.querySelector('main').hidden=false
  document.getElementById('authstate').innerHTML='signed in &nbsp;<button onclick="logout()">sign out</button>'
  render(ts)
  if(!sse){sse=new EventSource('/events');sse.onmessage=load}
}
function load(){
  fetch('/api/tickets').then(function(r){
    if(r.status===401){showLogin();return null}
    return r.json()
  }).then(function(ts){if(ts)showQueue(ts)})
}
function login(ev){
  ev.preventDefault()
  var pw=document.getElementById('pw').value
  fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:pw})})
    .then(function(r){
      if(r.ok){document.getElementById('pw').value='';document.getElementById('loginerr').textContent='';load()}
      else r.text().then(function(t){document.getElementById('loginerr').textContent=t})
    })
  return false
}
function logout(){fetch('/api/logout',{method:'POST'}).then(function(){showLogin()})}
function act(id,verdict){
  var msg=(document.getElementById('msg-'+id)||{}).value||''
  fetch('/api/tickets/'+id+'/'+verdict,{method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({message:msg})
  }).then(function(r){if(!r.ok)return r.text().then(function(t){alert(verdict+' failed: '+t)});load()})
}
load()
</script>
</body></html>`
