#!/usr/bin/env node
// Minimal Clawmini broker — PURE PLUGIN version.
//
// Here claude runs NORMALLY (interactive, e.g. in tmux). The broker is just a plugin:
// an MCP server that also implements the channel spec, so it can (a) expose a
// request_action tool and (b) PUSH async approve/reject notifications into the session.
// It is NOT the driver — it does the minimum to let the agent make requests and be
// notified of the outcome.
//
// Unlike the SDK-driver example, this is a single stdio process, so the tool handler and
// the verdict watcher share memory directly (no filesystem hand-off needed).
//
// Human approval, no web UI:  ./approve REQ-1   or   ./deny REQ-1
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { execFile } from 'node:child_process'
import { mkdirSync, appendFileSync, existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DIR = join(homedir(), '.clawmini-demo')
const VERDICTS = join(DIR, 'verdicts')
const LOG = join(DIR, 'broker.log')
mkdirSync(VERDICTS, { recursive: true })
const log = (m) => { const s = `[${new Date().toISOString().slice(11, 19)}] ${m}\n`; appendFileSync(LOG, s); process.stderr.write(s) }

const pending = new Map() // ticket -> command (argv)
let n = 0

const mcp = new Server(
  { name: 'broker', version: '0.0.1' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} }, // channel spec -> lets the broker PUSH notifications
      tools: {},
    },
    instructions:
      'The broker lets you act OUTSIDE your sandbox (network/host), which is otherwise blocked. ' +
      'Call request_action(command, reason) with an argv array; it returns a ticket immediately and does NOT block. ' +
      'The outcome arrives later as a channel message: <channel source="broker" ticket="REQ-N" verdict="approved|rejected">. ' +
      'On "approved" the command output is in that message — relay it to whoever asked. Never try to bypass the sandbox; use the broker.',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'request_action',
    description: 'Request a command OUTSIDE the sandbox (host/network). NON-BLOCKING: returns a ticket now; the ' +
      'approve/reject outcome arrives later as a broker channel message. Pass command as an argv array (no shell).',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'array', items: { type: 'string' }, description: 'argv, e.g. ["echo","hello"]' },
        reason: { type: 'string', description: 'why you need this, shown to the human' },
      },
      required: ['command', 'reason'],
    },
  }],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'request_action') throw new Error(`unknown tool: ${req.params.name}`)
  const { command, reason } = req.params.arguments
  const ticket = `REQ-${++n}`
  pending.set(ticket, command)
  log(`PENDING ${ticket}: ${JSON.stringify(command)} — ${reason}`)
  log(`   approve:  ./approve ${ticket}     reject:  ./deny ${ticket}`)
  return { content: [{ type: 'text', text: JSON.stringify({ ticket, status: 'pending', note: 'You will be notified when a human decides. Continue other work.' }) }] }
})

const runOnHost = (argv) => new Promise((res) =>
  execFile(argv[0], argv.slice(1), { timeout: 15000 }, (e, out, err) =>
    res({ exitCode: e?.code ?? 0, stdout: String(out), stderr: String(err || e?.message || '') })))

// Push a channel event into the session — this is the async "notification".
function notify(ticket, verdict, body) {
  void mcp.notification({
    method: 'notifications/claude/channel',
    params: { content: `Request ${ticket} was ${verdict}. ${body}`, meta: { ticket, verdict } },
  })
  log(`NOTIFIED ${ticket}: ${verdict}`)
}

// Watch for human verdict files; resolve the pending request and push the outcome.
setInterval(async () => {
  for (const [ticket, command] of pending) {
    const ok = join(VERDICTS, `${ticket}.approve`), no = join(VERDICTS, `${ticket}.deny`)
    if (existsSync(ok)) {
      rmSync(ok, { force: true }); pending.delete(ticket)
      const r = await runOnHost(command)
      notify(ticket, 'approved', `exit=${r.exitCode}, stdout: ${r.stdout.trim() || '(none)'}${r.stderr ? ' | stderr: ' + r.stderr.trim() : ''}`)
    } else if (existsSync(no)) {
      rmSync(no, { force: true }); pending.delete(ticket)
      notify(ticket, 'rejected', 'The human declined. Do not retry the same request.')
    }
  }
}, 400)

await mcp.connect(new StdioServerTransport())
log('broker channel up (stdio). watching verdicts in ' + VERDICTS)
