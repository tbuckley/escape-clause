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
import { readFileSync } from 'node:fs'
import { uiPassword, createSession, checkSession, destroySession, listTickets, audit, DIR } from './store.mjs'
import { listPolicies, policyScript } from './policies.mjs'

// Single self-contained page (no framework, no build step, no external requests) — see
// ui.html. Served verbatim with __BASE_URL__ substituted; auth stays the HttpOnly cookie.
const PAGE = readFileSync(new URL('./ui.html', import.meta.url), 'utf8')

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
      } else if (req.method === 'GET' && path === '/api/policies') {
        // Installed policies incl. script text, for the UI's Policies tab. Read-only, and
        // session-gated like everything else — the agent can already read the same facts
        // via the MCP list_policies tool, minus the script bytes (those stay broker-side).
        const policies = listPolicies().map((p) => ({ ...p, script: policyScript(p.name) }))
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(policies))
      } else if (req.method === 'POST' && path === '/api/tickets/deny-all') {
        // Clear the whole pending queue in one action. Each ticket goes through the same
        // resolveTicket path as a single deny, so every agent gets its channel outcome.
        const note = 'The human cleared the whole pending queue in one action — this is not a ' +
          'verdict on this specific request. Re-request anything you still need.'
        const pending = listTickets().filter((t) => t.status === 'pending')
        for (const t of pending) await resolveTicket(t.ticket, 'rejected', note)
        audit('ui_deny_all', { count: pending.length })
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, denied: pending.length }))
        broadcast()
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

