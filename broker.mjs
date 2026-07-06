#!/usr/bin/env node
// Clawmini broker — PURE PLUGIN version, with a real approval surface.
//
// claude runs NORMALLY (interactive, e.g. in tmux). The broker is one stdio process
// playing four roles:
//   - MCP server (+ channel spec, so it can PUSH async approve/reject outcomes into the
//     session): tools request_action / list_policies / check_policy / register_policy
//   - policy engine: named scripts pinned by hash in the private store; readonly and
//     private-write classes auto-run, everything else files a ticket (policies.mjs)
//   - approval web UI on http://127.0.0.1:8790 with AI risk summaries (server.mjs,
//     reviewer.mjs) — the ONLY place tickets get resolved; MCP can't resolve by design
//   - deny-all egress proxies on 127.0.0.1:8791 (HTTP) + 8792 (SOCKS5, for git-ssh/ftp/
//     grpc/rsync) (proxy.mjs) — settings.json points the sandbox at them
//     (sandbox.network.httpProxyPort/socksProxyPort), so off-allowlist network fails
//     closed instantly with no SandboxNetworkAccess prompt; the broker is the only exit
//
// State is durable JSON under ~/.clawmini-demo (store.mjs), which the sandbox + guard
// hook deny to the agent. Tickets snapshot the exact argv/script at request time; the
// approved bytes are what run.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { execFile } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { DIR, audit, nextTicketId, saveTicket, getTicket } from './store.mjs'
import { CLASSES, AUTO_CLASSES, NAME_RE, getPolicy, listPolicies, policyScript, installPolicy, runPolicy, seedPolicies } from './policies.mjs'
import { review } from './reviewer.mjs'
import { startServer } from './server.mjs'
import { startProxy } from './proxy.mjs'

const PORT = Number(process.env.CLAWMINI_UI_PORT || 8790)
// Base URL the USER reaches the review UI at — override when the UI is behind a tunnel /
// reverse proxy (Tailscale, ngrok, a domain) so the link the agent shares is reachable.
// Deliberately TOKEN-FREE: this is the one URL the sandboxed agent is allowed to know and
// relay to a user; it must never carry the approval token (the token gates approve/deny).
const UI_URL = (process.env.CLAWMINI_UI_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '')
const ticketUrl = (id) => `${UI_URL}/?req=${encodeURIComponent(id)}`
const log = (m) => { const s = `[${new Date().toISOString().slice(11, 19)}] ${m}\n`; appendFileSync(join(DIR, 'broker.log'), s); process.stderr.write(s) }

// How the broker handles a permission prompt Claude Code relays to it (CLAWMINI_RELAY):
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
const RELAY = ['forward', 'deny', 'off'].includes((process.env.CLAWMINI_RELAY || '').toLowerCase())
  ? process.env.CLAWMINI_RELAY.toLowerCase() : 'forward'

seedPolicies()

const experimental = { 'claude/channel': {} } // channel spec -> lets the broker PUSH notifications
if (RELAY !== 'off') experimental['claude/channel/permission'] = {} // permission relay (see RELAY above)

const mcp = new Server(
  { name: 'broker', version: '0.1.0' },
  {
    // claude/channel/permission (added above unless RELAY=off) is what makes Claude Code forward
    // its OWN tool-approval prompts (Bash/Write/Edit class; NOT the SandboxNetworkAccess egress
    // prompt, which never relays) to the broker. Safe to declare only because this channel
    // authenticates the approver (bearer token on 8790); fakechat, which has no auth, must NOT
    // declare it.
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
      'A pending ticket is not a failure: continue other work; do not poll. Never try to bypass the sandbox; use the broker.',
  },
)

const TOOLS = [
  {
    name: 'request_action',
    description: 'Act OUTSIDE the sandbox. Give EITHER {policy, args} to run a named policy (auto-approved classes ' +
      'execute immediately and return output; others file a human-review ticket) OR {command} as a raw argv array ' +
      '(always human-reviewed). NON-BLOCKING when a ticket is filed: the outcome arrives later as a broker channel message.',
    inputSchema: {
      type: 'object',
      properties: {
        policy: { type: 'string', description: 'name of a registered policy (see list_policies)' },
        args: { type: 'array', items: { type: 'string' }, description: 'args for the policy script' },
        command: { type: 'array', items: { type: 'string' }, description: 'raw argv, e.g. ["echo","hello"] — always human-reviewed' },
        reason: { type: 'string', description: 'why you need this, shown to the human reviewer' },
      },
      required: ['reason'],
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
      if (a.policy) {
        const p = getPolicy(a.policy)
        if (!p) return fail(`unknown policy: ${a.policy} (see list_policies)`)
        const args = (a.args || []).map(String)
        if (AUTO_CLASSES.has(p.class)) {
          const r = await runPolicy(p.name, args)
          audit('auto_approved_run', { policy: p.name, class: p.class, args, exitCode: r.exitCode })
          log(`AUTO-RUN ${p.name} ${JSON.stringify(args)} -> exit=${r.exitCode}`)
          return json({ status: 'executed', policy: p.name, class: p.class, exitCode: r.exitCode, ...capOutput(r, p.name) })
        }
        return json(createTicket({ kind: 'policy', policy: p.name, policyClass: p.class, args, reason: String(a.reason || '') }))
      }
      if (Array.isArray(a.command) && a.command.length && a.command.every((x) => typeof x === 'string')) {
        return json(createTicket({ kind: 'command', command: a.command, reason: String(a.reason || '') }))
      }
      return fail('need {policy, args?} or {command: ["argv0", ...]}')
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
  const t = { ticket: nextTicketId(), status: 'pending', created: new Date().toISOString(), ...fields }
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

// The single resolution path, called only by the web UI's authenticated endpoints.
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

  // Approved: execute exactly the snapshot in the ticket file.
  let body
  if (t.kind === 'command') {
    const r = await runOnHost(t.command)
    t.output = fmtRun(r)
    body = `Output:\n${capOutput(r, id).output}`
  } else if (t.kind === 'policy') {
    const r = await runPolicy(t.policy, t.args || [])
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

const runOnHost = (argv) => new Promise((res) =>
  execFile(argv[0], argv.slice(1), { timeout: 15000 }, (e, out, err) =>
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

const ui = startServer({ port: PORT, baseUrl: UI_URL, resolveTicket, log })
const PROXY_PORT = Number(process.env.CLAWMINI_PROXY_PORT || 8791)
startProxy({ port: PROXY_PORT, socksPort: PROXY_PORT + 1, log, audit })
await mcp.connect(new StdioServerTransport())
log(`broker up (stdio MCP + channel, relay=${RELAY}). store: ${DIR}`)
