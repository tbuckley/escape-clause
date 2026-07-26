#!/usr/bin/env node
// Escape Clause broker — PURE PLUGIN version, with a real approval surface.
//
// claude runs NORMALLY (interactive, e.g. in tmux). The broker is one stdio process
// playing four roles:
//   - MCP server (+ channel spec, so it can PUSH async approve/reject outcomes into the
//     session): tools request_action / list_policies / check_policy / register_policy
//   - policy engine: named scripts pinned by hash in the private store; readonly and
//     private-write classes auto-run, everything else files a ticket (policies.mjs)
//   - approval web UI on http://127.0.0.1:8790 with AI risk summaries (server.mjs,
//     reviewer.mjs) — the ONLY place tickets get APPROVED; the MCP surface can withdraw
//     its own pending tickets (cancel_request — rejection-only, nothing ever executes)
//     but has no approve path by design
//   - deny-all egress proxies on 127.0.0.1:8791 (HTTP) + 8792 (SOCKS5, for git-ssh/ftp/
//     grpc/rsync) (proxy.mjs) — settings.json points the sandbox at them
//     (sandbox.network.httpProxyPort/socksProxyPort), so off-allowlist network fails
//     closed instantly with no SandboxNetworkAccess prompt; the broker is the only exit
//
// State is durable JSON under ~/.escape-clause (store.mjs), which the sandbox + guard
// hook deny to the agent. Tickets snapshot the exact argv/script at request time; the
// approved bytes are what run.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { execFile } from 'node:child_process'
import { appendFileSync, writeFileSync, realpathSync } from 'node:fs'
import { join, isAbsolute, relative } from 'node:path'
import { z } from 'zod'
import { DIR, audit, nextTicketId, saveTicket, getTicket, listTickets } from './store.mjs'
import { CLASSES, AUTO_CLASSES, NAME_RE, getPolicy, listPolicies, policyScript, installPolicy, runPolicy, seedPolicies } from './policies.mjs'
import { review } from './reviewer.mjs'
import { startServer } from './server.mjs'
import { startProxy } from './proxy.mjs'

const PORT = Number(process.env.ESCAPE_CLAUSE_UI_PORT || 8790)
// Base URL the USER reaches the review UI at — override when the UI is behind a tunnel /
// reverse proxy (Tailscale, ngrok, a domain) so the link the agent shares is reachable.
// Deliberately TOKEN-FREE: this is the one URL the sandboxed agent is allowed to know and
// relay to a user; it must never carry the approval token (the token gates approve/deny).
// `let`, not `const`: an exposure provider (expose.mjs) may report the public URL
// after startup, at which point new ticket links switch over to it.
let UI_URL = (process.env.ESCAPE_CLAUSE_UI_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '')
const ticketUrl = (id) => `${UI_URL}/?req=${encodeURIComponent(id)}`
const log = (m) => { const s = `[${new Date().toISOString().slice(11, 19)}] ${m}\n`; appendFileSync(join(DIR, 'broker.log'), s); process.stderr.write(s) }

// How the broker handles a permission prompt Claude Code relays to it (ESCAPE_CLAUSE_RELAY):
//   forward (default) — surface it in the UI queue and wait for a human verdict
//   deny              — auto-deny it immediately, no human, no UI ticket (just audit-logged).
//                       Use this when settings.json already auto-allows everything legitimate:
//                       anything reaching the relay is by definition NOT pre-approved.
//   off               — don't declare the relay capability at all; prompts stay in the terminal.
// SCOPE (verified against the channels docs + behaviorally): the relay only ever receives
// TOOL-USE approvals (Bash/Write/Edit class). The SandboxNetworkAccess (off-allowlist
// domain) prompt is NOT relayed — it never reaches the broker in any mode. Domain prompts
// are instead eliminated at the source by the deny-all egress proxy (proxy.mjs), which
// replaces the built-in sandbox proxy that generates them.
const RELAY = ['forward', 'deny', 'off'].includes((process.env.ESCAPE_CLAUSE_RELAY || '').toLowerCase())
  ? process.env.ESCAPE_CLAUSE_RELAY.toLowerCase() : 'forward'

seedPolicies()

// ---------- execution defaults ----------
// Every run (auto or approved) executes with cwd = WORKSPACE (the directory the broker
// was launched from, i.e. the agent workspace) and a 15s timeout unless the request
// overrides them. Overrides are snapshotted into the ticket, so the human approves the
// exact cwd/timeout alongside the exact argv.
const WORKSPACE = process.cwd()
const DEFAULT_TIMEOUT_MS = 15000
const MAX_TIMEOUT_MS = 600000 // 10 min hard cap — a run can't wedge the broker forever

// Validate agent-supplied overrides. Deliberately NO existence check on cwd here: a
// request-time "no such directory" error would be a free oracle for probing which host
// paths exist outside the sandbox; a bad cwd just fails at execution instead.
function parseExecOpts(a) {
  const o = {}
  if (a.cwd !== undefined) {
    if (typeof a.cwd !== 'string' || !isAbsolute(a.cwd)) return { error: 'cwd must be an absolute path string' }
    o.cwd = a.cwd
  }
  if (a.timeout_ms !== undefined) {
    const t = Number(a.timeout_ms)
    if (!Number.isInteger(t) || t < 1000 || t > MAX_TIMEOUT_MS) return { error: `timeout_ms must be an integer between 1000 and ${MAX_TIMEOUT_MS}` }
    o.timeout_ms = t
  }
  return { opts: o }
}

// Resolve an agent-supplied cwd and return its REAL path only if it lands inside the
// workspace subtree; null = outside or unresolvable -> human review (no error back to
// the agent, so no existence oracle). Auto-runs must execute with the RETURNED path,
// never the raw request string — the raw string would be re-resolved by the kernel at
// spawn time, so a symlink whose target is swapped after this check would move the run
// elsewhere. Residual race: swapping a real directory component of the resolved path
// itself between check and spawn (a same-tick window of pure JS) — every attempt costs
// an audit-logged MCP call, and the payoff is bounded to an approved auto-class script
// running with a different cwd.
function resolveWorkspaceCwd(cwd) {
  try {
    const real = realpathSync(cwd)
    const rel = relative(realpathSync(WORKSPACE), real)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) ? real : null
  } catch { return null }
}

const experimental = { 'claude/channel': {} } // channel spec -> lets the broker PUSH notifications
if (RELAY !== 'off') experimental['claude/channel/permission'] = {} // permission relay (see RELAY above)

const mcp = new Server(
  { name: 'broker', version: '0.1.0' },
  {
    // claude/channel/permission (added above unless RELAY=off) is what makes Claude Code forward
    // its OWN tool-approval prompts (Bash/Write/Edit class; NOT the SandboxNetworkAccess egress
    // prompt, which never relays) to the broker. Safe to declare only because this channel
    // authenticates the approver (bearer token on 8790); an unauthenticated chat channel
    // (fakechat, for one) must NOT declare it.
    capabilities: { experimental, tools: {} },
    instructions:
      'The broker lets you act OUTSIDE your sandbox (network/host), which is otherwise blocked. ' +
      'PREFER NAMED POLICIES over raw commands: list_policies() shows what exists; check_policy(policy, args) dry-runs the decision. ' +
      'request_action({policy, args, reason}) runs auto-approved classes (readonly/private-write) immediately and returns output; ' +
      'other classes and raw commands ({command: argv, reason}) return a ticket for human review — NON-BLOCKING. ' +
      'A filed ticket comes back with a `url`; if a user is waiting on this, share that link so they can view and approve the exact request in the web UI. ' +
      'The outcome arrives later as a channel message: <channel source="broker" ticket="REQ-N" verdict="approved|rejected">. ' +
      'On "approved" the output is in that message — relay it to whoever asked. ' +
      'register_policy() proposes a new/updated policy script (itself human-reviewed). ' +
      'cancel_request({ticket|tickets|all}) withdraws your own pending tickets with no human involved — rejection only, ' +
      'nothing executes; use it to clean up stale or superseded requests. ' +
      'Runs default to cwd = the launch workspace and a 15s timeout; request_action takes optional cwd/timeout_ms overrides ' +
      '(a cwd outside the workspace always needs human review, even for auto-approved classes). ' +
      'A pending ticket is not a failure: continue other work; do not poll. Never try to bypass the sandbox; use the broker.',
  },
)

const TOOLS = [
  {
    name: 'request_action',
    description: 'Act OUTSIDE the sandbox. Give EITHER {policy, args} to run a named policy (auto-approved classes ' +
      'execute immediately and return output; others file a human-review ticket) OR {command} as a raw argv array ' +
      '(always human-reviewed). NON-BLOCKING when a ticket is filed: the outcome arrives later as a broker channel message. ' +
      'Execution defaults: cwd = the workspace the broker was launched from, timeout = 15s; override with cwd/timeout_ms.',
    inputSchema: {
      type: 'object',
      properties: {
        policy: { type: 'string', description: 'name of a registered policy (see list_policies)' },
        args: { type: 'array', items: { type: 'string' }, description: 'args for the policy script' },
        command: { type: 'array', items: { type: 'string' }, description: 'raw argv, e.g. ["echo","hello"] — always human-reviewed' },
        cwd: { type: 'string', description: 'absolute working directory for the run (default: the launch workspace). ' +
          'A cwd outside the workspace always files a human-review ticket, even for auto-approved policy classes.' },
        timeout_ms: { type: 'integer', description: 'kill the run after this many ms, 1000–600000 (default: 15000)' },
        reason: { type: 'string', description: 'why you need this, shown to the human reviewer' },
      },
      required: ['reason'],
    },
  },
  {
    name: 'cancel_request',
    description: 'Withdraw your own pending tickets — no human involved, and strictly rejection-only: nothing can ever ' +
      'execute through this tool. Use it to clean up requests that are stale, superseded, or filed by mistake. Give ' +
      '{ticket: "REQ-N"}, {tickets: [...]}, or {all: true} (= every pending broker ticket of yours). Only tickets filed ' +
      'from this session\'s workspace are reachable; relayed permission prompts (PERM-*) are not cancellable — only the ' +
      'human answers those. Cancelled tickets stay in the audit trail and UI history.',
    inputSchema: {
      type: 'object',
      properties: {
        ticket: { type: 'string', description: 'a single ticket id, e.g. REQ-12' },
        tickets: { type: 'array', items: { type: 'string' }, description: 'several ticket ids' },
        all: { type: 'boolean', description: 'true = cancel every pending broker ticket' },
        reason: { type: 'string', description: 'optional note recorded in the audit log and shown in the UI history' },
      },
    },
  },
  {
    name: 'list_policies',
    description: 'List registered policies: name, description, class (readonly/private-write auto-run; public-write/destructive need human approval), script hash.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'check_policy',
    description: 'Dry-run: would request_action({policy, args}) auto-run or need human approval? Use this to avoid filing spurious tickets.',
    inputSchema: {
      type: 'object',
      properties: {
        policy: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
      },
      required: ['policy'],
    },
  },
  {
    name: 'register_policy',
    description: 'Propose a new or updated named policy script. This is ITSELF an escalation: it files a human-review ticket ' +
      'showing the full script (and a diff against any existing version). On approval the broker installs the script in its ' +
      'private store, pinned by hash. Scripts are invoked as execve(script, args) — no shell wrapping of args.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'kebab-case name, e.g. git-fetch-origin' },
        script: { type: 'string', description: 'full script content including shebang, e.g. "#!/bin/sh\\n..."' },
        class: { type: 'string', enum: CLASSES, description: 'readonly|private-write auto-run once installed; public-write|destructive are reviewed per run' },
        description: { type: 'string', description: 'what it does + expected args, shown in list_policies and to the reviewer' },
      },
      required: ['name', 'script', 'class', 'description'],
    },
  },
]

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

const json = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] })
const fail = (msg) => json({ error: msg })

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const a = req.params.arguments || {}
  switch (req.params.name) {
    case 'list_policies':
      return json(listPolicies())

    case 'check_policy': {
      const p = getPolicy(a.policy)
      if (!p) return json({ policy: a.policy, decision: 'unknown_policy' })
      return json({
        policy: p.name, class: p.class,
        decision: AUTO_CLASSES.has(p.class) ? 'auto_approve' : 'needs_approval',
      })
    }

    case 'request_action': {
      if (a.policy && a.command) return fail('give policy OR command, not both')
      const { error, opts } = parseExecOpts(a)
      if (error) return fail(error)
      if (a.policy) {
        const p = getPolicy(a.policy)
        if (!p) return fail(`unknown policy: ${a.policy} (see list_policies)`)
        const args = (a.args || []).map(String)
        // Auto-run keeps its class ONLY inside the workspace: an agent-chosen cwd
        // elsewhere (protected dirs, other repos, nonexistent probes) demotes to a ticket.
        const autoCwd = opts.cwd ? resolveWorkspaceCwd(opts.cwd) : undefined
        if (AUTO_CLASSES.has(p.class) && (!opts.cwd || autoCwd)) {
          const r = await runPolicy(p.name, args, { cwd: autoCwd, timeout: opts.timeout_ms })
          audit('auto_approved_run', { policy: p.name, class: p.class, args, exitCode: r.exitCode, ...opts })
          log(`AUTO-RUN ${p.name} ${JSON.stringify(args)} -> exit=${r.exitCode}`)
          return json({ status: 'executed', policy: p.name, class: p.class, exitCode: r.exitCode, ...capOutput(r, p.name) })
        }
        const ticket = createTicket({ kind: 'policy', policy: p.name, policyClass: p.class, args, ...opts, reason: String(a.reason || '') })
        if (AUTO_CLASSES.has(p.class)) ticket.note = 'This class normally auto-runs, but a cwd outside the workspace always needs human review. ' + ticket.note
        return json(ticket)
      }
      if (Array.isArray(a.command) && a.command.length && a.command.every((x) => typeof x === 'string')) {
        return json(createTicket({ kind: 'command', command: a.command, ...opts, reason: String(a.reason || '') }))
      }
      return fail('need {policy, args?} or {command: ["argv0", ...]}')
    }

    case 'cancel_request': {
      const reason = String(a.reason || '')
      let ids
      if (a.all === true) ids = listTickets().filter((t) => t.status === 'pending' && t.kind !== 'permission' && t.workspace === WORKSPACE).map((t) => t.ticket)
      else if (Array.isArray(a.tickets) && a.tickets.length) ids = a.tickets.map(String)
      else if (typeof a.ticket === 'string') ids = [a.ticket]
      else return fail('give {ticket: "REQ-N"}, {tickets: [...]}, or {all: true}')
      const results = ids.map((id) => cancelTicket(id, reason))
      if (results.some((r) => r.ok)) ui.broadcast()
      return json({
        cancelled: results.filter((r) => r.ok).map((r) => r.ticket),
        errors: results.filter((r) => r.error).map((r) => ({ ticket: r.ticket, error: r.error })),
      })
    }

    case 'register_policy': {
      if (!NAME_RE.test(String(a.name))) return fail('name must be kebab-case: ' + NAME_RE)
      if (!CLASSES.includes(a.class)) return fail(`class must be one of ${CLASSES.join('|')}`)
      if (typeof a.script !== 'string' || !a.script.trim()) return fail('script must be non-empty')
      const registration = {
        name: a.name, class: a.class,
        description: String(a.description || ''), script: a.script,
      }
      const previous = policyScript(a.name)
      if (previous !== null) registration.previousScript = previous
      return json(createTicket({ kind: 'policy-registration', registration, reason: String(a.reason || a.description || '') }))
    }

    default:
      throw new Error(`unknown tool: ${req.params.name}`)
  }
})

// ---------- tickets ----------
function createTicket(fields) {
  // workspace = ownership: several sessions may share one store (server.mjs), and
  // cancel_request must only reach tickets filed from this broker's own workspace.
  const t = { ticket: nextTicketId(), status: 'pending', created: new Date().toISOString(), workspace: WORKSPACE, ...fields }
  saveTicket(t)
  audit('ticket_created', { ticket: t.ticket, kind: t.kind })
  log(`PENDING ${t.ticket} (${t.kind}) — review at http://127.0.0.1:${PORT}`)
  ui.broadcast()
  kickReviewer(t)
  return {
    ticket: t.ticket, status: 'pending', url: ticketUrl(t.ticket),
    note: 'A human reviews this in the web UI. If a user is waiting, share the `url` so they can view and approve/deny this exact request. ' +
      'You will be notified of the outcome as a channel message. Continue other work; do not poll.',
  }
}

// AI risk summary, async: the item is already visible; the summary streams in when ready
// (or never, if no API key — the UI approves fine from raw facts alone).
function kickReviewer(t) {
  review(t).then((summary) => {
    if (!summary) return
    const cur = getTicket(t.ticket)
    if (!cur) return
    cur.summary = summary
    saveTicket(cur)
    ui.broadcast()
  }).catch(() => {})
}

// Agent-initiated withdrawal — the ONE ticket-state transition the MCP surface may
// perform. Safe because it only ever prevents execution: a cancelled ticket can never
// be approved afterwards (resolveTicket refuses non-pending), and approval itself stays
// exclusive to the web UI. Relayed permission prompts are excluded — those belong to
// Claude Code's own dialog and only the human (or relay=deny) answers them.
function cancelTicket(id, reason) {
  const t = getTicket(id)
  // Nonexistent and not-yours collapse to ONE answer: with a shared store, a
  // distinguishable reply would let one session probe another's ticket ids.
  if (!t || t.workspace !== WORKSPACE) return { ticket: id, error: 'unknown ticket' }
  if (t.kind === 'permission') return { ticket: id, error: 'permission prompts cannot be cancelled via MCP' }
  if (t.status !== 'pending') return { ticket: id, error: `already ${t.status}` }
  t.status = 'cancelled'
  t.resolved = new Date().toISOString()
  t.cancelledBy = 'agent'
  if (reason) t.note = reason
  saveTicket(t)
  audit('cancelled_by_agent', { ticket: id, note: reason })
  log(`CANCELLED ${id} (by agent)${reason ? ` — ${reason}` : ''}`)
  return { ticket: id, ok: true }
}

// The single APPROVAL path, called only by the web UI's authenticated endpoints.
async function resolveTicket(id, verdict, message) {
  const t = getTicket(id)
  if (!t) return { error: `unknown ticket: ${id}` }
  if (t.status !== 'pending') return { error: `${id} already ${t.status}` }
  t.status = verdict
  t.resolved = new Date().toISOString()
  if (message) t.note = message

  // Permission relay: this item is a prompt Claude Code forwarded, not a broker request.
  // Emit the verdict back on the permission channel; nothing executes here. The terminal
  // dialog is still open in parallel — if it was answered first, Claude Code has no open
  // request for this id and silently drops our verdict, which is harmless.
  if (t.kind === 'permission') {
    const behavior = verdict === 'approved' ? 'allow' : 'deny'
    void mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id: t.request_id, behavior },
    })
    saveTicket(t)
    audit('permission_verdict', { request_id: t.request_id, behavior })
    log(`PERMISSION ${id} -> ${behavior}`)
    return { ok: true }
  }

  if (verdict === 'rejected') {
    saveTicket(t)
    audit('rejected', { ticket: id, note: message })
    log(`REJECTED ${id}${message ? ` — ${message}` : ''}`)
    notify(id, 'rejected', `The human declined.${message ? ` Message from the human: ${message}` : ''} Do not retry the same request.`)
    return { ok: true }
  }

  // Persist 'approved' BEFORE executing: a cancel_request racing in mid-run then reads
  // a non-pending status and refuses, instead of stamping 'cancelled' over the record
  // of something that really did execute. (Output is persisted by the save below.)
  saveTicket(t)

  // Approved: execute exactly the snapshot in the ticket file (incl. cwd/timeout_ms —
  // the reviewer saw those alongside the argv).
  let body
  if (t.kind === 'command') {
    const r = await runOnHost(t.command, { cwd: t.cwd, timeout_ms: t.timeout_ms })
    t.output = fmtRun(r)
    body = `Output:\n${capOutput(r, id).output}`
  } else if (t.kind === 'policy') {
    const r = await runPolicy(t.policy, t.args || [], { cwd: t.cwd, timeout: t.timeout_ms })
    t.output = fmtRun(r)
    body = `Policy ${t.policy} ran. Output:\n${capOutput(r, id).output}`
  } else if (t.kind === 'policy-registration') {
    const m = installPolicy(t.registration)
    t.output = `installed ${m.name} (class ${m.class}, sha256 ${m.sha256})`
    body = `Policy '${m.name}' (class ${m.class}) is now registered — you can run it with request_action({policy: "${m.name}", args: [...]}).`
  } else {
    return { error: `unknown ticket kind: ${t.kind}` }
  }
  saveTicket(t)
  audit('approved_executed', { ticket: id, kind: t.kind })
  log(`APPROVED ${id} (${t.kind})`)
  notify(id, 'approved', body)
  return { ok: true }
}

const runOnHost = (argv, { cwd, timeout_ms } = {}) => new Promise((res) =>
  execFile(argv[0], argv.slice(1), { cwd, timeout: timeout_ms || DEFAULT_TIMEOUT_MS }, (e, out, err) =>
    res({ exitCode: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: String(out), stderr: String(err || e?.message || '') })))

const fmtRun = (r) => `exit=${r.exitCode}\nstdout: ${r.stdout.trim() || '(none)'}${r.stderr.trim() ? `\nstderr: ${r.stderr.trim()}` : ''}`

// Large outputs go to a workspace file, not the tool result / channel message.
function capOutput(r, tag) {
  const text = fmtRun(r)
  if (text.length <= 8000) return { output: text }
  const file = join(process.cwd(), `broker-output-${tag}-${Date.now()}.txt`)
  writeFileSync(file, text)
  return { output: `${text.slice(0, 500)}…\n(large output: full ${text.length} bytes written to ${file})` }
}

// Push a channel event into the session — the async "notification".
function notify(ticket, verdict, body) {
  void mcp.notification({
    method: 'notifications/claude/channel',
    params: { content: `Request ${ticket} was ${verdict}. ${body}`, meta: { ticket, verdict } },
  })
  log(`NOTIFIED ${ticket}: ${verdict}`)
}

// ---------- permission relay ----------
// Claude Code (the harness, NOT the agent) calls this when one of ITS OWN tool-approval
// dialogs opens — Bash/Write/Edit class only; the SandboxNetworkAccess egress prompt is
// not relayed (that case is handled by the deny-all proxy instead, see proxy.mjs).
// We surface it in the same UI queue as broker tickets (kind: 'permission'); resolving it
// there emits the allow/deny verdict above. Only fires in interactive mode — in headless
// `-p` the harness disables prompts entirely, so nothing is relayed.
const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string().optional().default(''),
    input_preview: z.string().optional().default(''),
  }),
})
mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  if (RELAY === 'deny') {
    // Auto-deny without a human: settings.json is expected to auto-allow everything legitimate,
    // so anything reaching the relay is unapproved. Instant deny, audit-logged, no UI clutter.
    void mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id: params.request_id, behavior: 'deny' },
    })
    audit('permission_auto_denied', { request_id: params.request_id, tool_name: params.tool_name })
    log(`PERMISSION ${params.tool_name} (${params.request_id}) AUTO-DENIED [relay=deny]`)
    return
  }
  const t = {
    ticket: `PERM-${params.request_id}`,
    request_id: params.request_id,
    kind: 'permission',
    status: 'pending',
    created: new Date().toISOString(),
    workspace: WORKSPACE,
    tool_name: params.tool_name,
    description: params.description,
    input_preview: params.input_preview,
    reason: `Claude Code is requesting permission to use ${params.tool_name}, relayed from the terminal. ` +
      'Answering here is parallel to the terminal dialog — whichever answers first wins.',
  }
  saveTicket(t)
  audit('permission_request', { request_id: params.request_id, tool_name: params.tool_name })
  log(`PERMISSION ${t.ticket}: ${params.tool_name} — ${params.description || params.input_preview}`)
  ui.broadcast()
  kickReviewer(t)
})

const ui = startServer({ port: PORT, resolveTicket, log })
const PROXY_PORT = Number(process.env.ESCAPE_CLAUSE_PROXY_PORT || 8791)
startProxy({ port: PROXY_PORT, socksPort: PROXY_PORT + 1, log, audit })
// Exposure provider (stamped into .mcp.json from the workspace config): arranges a
// reachable URL for the loopback-only UI and reports it; links switch over when it does.
const EXPOSE = (process.env.ESCAPE_CLAUSE_EXPOSE || '').trim()
if (EXPOSE) {
  const { startExpose } = await import('./expose.mjs')
  startExpose({ mode: EXPOSE, port: PORT, log, onUrl: (u) => {
    UI_URL = u.replace(/\/+$/, '')
    log(`expose: approval links now use ${UI_URL}`)
  } })
}
await mcp.connect(new StdioServerTransport())
log(`broker up (stdio MCP + channel, relay=${RELAY}). store: ${DIR}`)
