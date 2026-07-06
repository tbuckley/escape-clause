// Durable broker state, all under one private dir the agent can never touch
// (~/.clawmini-demo — covered by sandbox denyRead AND the guard hook). Tickets are
// one JSON file each: the file IS the request-time snapshot, so what the human
// approves is what runs (TOCTOU closed for argv-style requests).
import { mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync, existsSync } from 'node:fs'
import { randomBytes, createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DIR = process.env.CLAWMINI_DIR || join(homedir(), '.clawmini-demo')
const TICKETS = join(DIR, 'tickets')
const SECRETS = join(DIR, 'secrets')
const CACHE = join(DIR, 'reviewer-cache')
export const POLICY_DIR = join(DIR, 'policies')
for (const d of [TICKETS, SECRETS, CACHE, POLICY_DIR]) mkdirSync(d, { recursive: true, mode: 0o700 })

export const sha256 = (s) => createHash('sha256').update(s).digest('hex')

// Append-only audit trail: every request, decision, execution, registration.
export const audit = (event, data = {}) =>
  appendFileSync(join(DIR, 'audit.log'), JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + '\n')

// Bearer token the approve/deny endpoints require. Lives only in the protected store;
// the human reads it out-of-band (the broker logs the tokened URL at startup).
export function uiToken() {
  const f = join(SECRETS, 'ui-token')
  if (!existsSync(f)) writeFileSync(f, randomBytes(24).toString('hex'), { mode: 0o600 })
  return readFileSync(f, 'utf8').trim()
}

// Monotonic across restarts, so REQ-N is never reused and the audit trail stays unambiguous.
export function nextTicketId() {
  const f = join(DIR, 'counter')
  let n = 0
  try { n = parseInt(readFileSync(f, 'utf8'), 10) || 0 } catch {}
  writeFileSync(f, String(n + 1))
  return `REQ-${n + 1}`
}

export function saveTicket(t) { writeFileSync(join(TICKETS, `${t.ticket}.json`), JSON.stringify(t, null, 2)) }
const TICKET_ID_RE = /^(REQ-\d+|PERM-[a-km-z]{5})$/ // REQ-N broker tickets; PERM-<id> relayed permission prompts
export function getTicket(id) {
  if (!TICKET_ID_RE.test(String(id))) return null
  try { return JSON.parse(readFileSync(join(TICKETS, `${id}.json`), 'utf8')) } catch { return null }
}
export function listTickets() {
  return readdirSync(TICKETS).filter((f) => f.endsWith('.json'))
    .map((f) => { try { return JSON.parse(readFileSync(join(TICKETS, f), 'utf8')) } catch { return null } })
    .filter(Boolean)
    .sort((a, b) => (b.created || '').localeCompare(a.created || '') || b.ticket.localeCompare(a.ticket))
}

// Reviewer verdict cache, keyed by content hash of the verified facts — a re-filed
// identical request costs nothing and can't be used to spin the reviewer.
export function cacheGet(key) { try { return JSON.parse(readFileSync(join(CACHE, `${key}.json`), 'utf8')) } catch { return null } }
export function cachePut(key, val) { writeFileSync(join(CACHE, `${key}.json`), JSON.stringify(val)) }
