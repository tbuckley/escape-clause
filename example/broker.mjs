#!/usr/bin/env node
// Minimal Clawmini broker — ASYNC via the SDK driver's INPUT STREAM.
//
// Pushing into a running session needs EITHER the channel spec OR the driver's input
// stream. A *custom* channel does not activate headless (verified), so we use the driver
// path: the broker IS the SDK driver and injects the approval/rejection as a normal user
// message. The broker's scope stays "requests + notifications"; chat plugs into the same
// input queue (from a fakechat/Remote Control channel or a bot the broker bridges).
//
// NOTE: the SDK runs in-process MCP tool handlers in an ISOLATED context, so the tool
// handler can't share memory with the driver. They communicate via the filesystem:
//   tool handler  -> writes  ~/.clawmini-demo/pending/REQ-N.json
//   human         -> writes  ~/.clawmini-demo/verdicts/REQ-N.{approve,deny}   (./approve, ./deny)
//   driver watcher-> reads both, runs the command, injects the outcome into the live query
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { mkdirSync, existsSync, rmSync, writeFileSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'

const DIR = join(homedir(), '.clawmini-demo')
const PENDING = join(DIR, 'pending')
const VERDICTS = join(DIR, 'verdicts')
const COUNTER = join(DIR, 'counter')

// Paths the native file tools (Read/Edit/Write) must not touch. sandbox.filesystem.denyRead
// only covers bash; these tools run in the main process and bypass it, so canUseTool
// enforces the same paths below. Resolve symlinks and `..` first (realpath) — a raw
// file_path like `./link` -> ~/.ssh or workspace/../../.ssh disguises a protected target,
// so a literal startsWith() is bypassable; compare REAL paths on both sides.
const expand = (p) => (p && p.startsWith('~') ? join(homedir(), p.slice(1)) : p)
function realish(p) {
  const e = expand(p); if (!e) return e
  const abs = resolve(e); const tail = []
  for (let dir = abs; ; dir = dirname(dir)) {
    try { return join(realpathSync(dir), ...tail.reverse()) } catch {}
    const parent = dirname(dir); if (parent === dir) return abs
    tail.push(basename(dir))
  }
}
const PROTECTED = ['.ssh', '.aws', '.gnupg', '.config/gcloud', '.clawmini-demo'].map((p) => realish(join(homedir(), p)))
const isProtected = (fp) => { const a = realish(fp); return !!a && PROTECTED.some((p) => a === p || a.startsWith(p + '/')) }
for (const d of [PENDING, VERDICTS]) mkdirSync(d, { recursive: true })
const now = () => new Date().toISOString().slice(11, 19)
const log = (m) => process.stderr.write(`[broker ${now()}] ${m}\n`)

// ---- async input queue feeding the live query (driver context) ----
const q = []
let wake = null
function inject(text) {
  q.push({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null })
  if (wake) { const w = wake; wake = null; w() }
}
async function* inputStream() {
  for (;;) { while (q.length) yield q.shift(); await new Promise((r) => (wake = r)) }
}

// ---- broker MCP tool (ISOLATED context): only touches the filesystem ----
const broker = createSdkMcpServer({
  name: 'broker', version: '0.0.1',
  tools: [
    tool('request_action',
      'Request a command OUTSIDE the sandbox (host/network). NON-BLOCKING: returns a ticket now; ' +
      'the approve/reject outcome arrives LATER as a normal message. Pass command as an argv array.',
      { command: z.array(z.string()), reason: z.string() },
      async ({ command, reason }) => {
        let n = 0; try { n = parseInt(readFileSync(COUNTER, 'utf8')) || 0 } catch {}
        n++; writeFileSync(COUNTER, String(n))
        const ticket = `REQ-${n}`
        writeFileSync(join(PENDING, `${ticket}.json`), JSON.stringify({ command, reason }))
        return { content: [{ type: 'text', text: JSON.stringify({ ticket, status: 'pending', note: 'You will be notified when a human decides. Continue other work.' }) }] }
      }),
  ],
})

const runOnHost = (argv) => new Promise((res) =>
  execFile(argv[0], argv.slice(1), { timeout: 15000 }, (e, out, err) =>
    res({ exitCode: e?.code ?? 0, stdout: String(out), stderr: String(err || e?.message || '') })))

// ---- driver watcher: reads request + verdict files, runs command, injects the outcome ----
const seen = new Set()
setInterval(async () => {
  let files = []; try { files = readdirSync(VERDICTS) } catch {}
  for (const f of files) {
    const m = /^(REQ-\d+)\.(approve|deny)$/.exec(f)
    if (!m || seen.has(f)) continue
    seen.add(f)
    const ticket = m[1], approved = m[2] === 'approve'
    rmSync(join(VERDICTS, f), { force: true })
    const reqPath = join(PENDING, `${ticket}.json`)
    if (!existsSync(reqPath)) { log(`verdict for unknown ${ticket}, ignoring`); continue }
    const { command } = JSON.parse(readFileSync(reqPath, 'utf8'))
    rmSync(reqPath, { force: true })
    if (!approved) {
      log(`REJECTED ${ticket}; injecting`)
      inject(`[broker notification] Request ${ticket} was REJECTED by the human. Do not retry it. Tell the user.`)
    } else {
      const r = await runOnHost(command)
      log(`APPROVED ${ticket} -> exit ${r.exitCode}; injecting`)
      inject(`[broker notification] Request ${ticket} was APPROVED and ran on the host. exit=${r.exitCode}, stdout: ${r.stdout.trim() || '(none)'}. Report this to the user.`)
    }
  }
}, 400)

// ---- drive the agent ----
// USE_FAKECHAT=1 -> chat comes from the fakechat channel (localhost:8787); the bootstrap
// just arms the session. Otherwise the DEMO_TASK message stands in for chat.
const USE_FAKECHAT = process.env.USE_FAKECHAT === '1'
inject(USE_FAKECHAT
  ? 'You are online. The user talks to you through the fakechat channel — their messages arrive as <channel source="fakechat" chat_id="..."> tags. Reply to them ONLY via the fakechat reply tool (pass the chat_id from the tag); your normal text is not shown to them. You are sandboxed: NO network, NO host access. To do anything outside the sandbox, call the broker request_action tool (argv + reason); it is non-blocking and its approve/reject outcome arrives later as a "[broker notification]" message — when it does, relay the result to the user via the fakechat reply tool. Acknowledge readiness now with a one-line fakechat reply.'
  : (process.env.DEMO_TASK ||
     "Call broker request_action with command ['echo','hello-async'] and reason 'demo'. It returns a ticket immediately — acknowledge it, then wait. When a broker notification tells you the outcome, report the command output to the user."))

for await (const m of query({
  prompt: inputStream(),
  options: {
    permissionMode: 'default',
    // headless demo: don't load project config. fakechat mode: allow plugin/channel loading.
    ...(USE_FAKECHAT ? { extraArgs: { channels: 'plugin:fakechat@claude-plugins-official' } } : { settingSources: [] }),
    disallowedTools: ['WebFetch', 'WebSearch'],
    mcpServers: { broker },
    sandbox: {
      enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false, excludedCommands: [],   // close the dangerouslyDisableSandbox escape hatch
      network: { allowedDomains: [] },
      filesystem: { denyRead: ['~/.ssh', '~/.aws', '~/.gnupg', '~/.config/gcloud', '~/.clawmini-demo'] },
    },
    canUseTool: async (toolName, input) => {
      if (toolName === 'SandboxNetworkAccess') { log(`DENY SandboxNetworkAccess host=${input?.host}`); return { behavior: 'deny', message: 'Outside-VM denied. Use broker request_action.' } }
      // native file tools bypass the bash sandbox — deny any tool touching a protected path
      // (path-based, not a fixed tool list, so Read/Edit/Write/Grep/Glob/NotebookEdit/future all covered)
      if (toolName !== 'Bash') {
        const fp = String(input?.file_path || input?.notebook_path || input?.path || '')
        if (fp && isProtected(fp)) { log(`DENY ${toolName} on protected path ${fp}`); return { behavior: 'deny', message: 'Protected path — not accessible to file tools.' } }
      }
      // MCP servers run OUTSIDE the sandbox. Allow only the broker (+ fakechat chat); deny any
      // other MCP tool (e.g. mcp__claude_ai_Gmail/Drive/Calendar — network + private data).
      if (toolName.startsWith('mcp__') && !/__broker__|fakechat/i.test(toolName)) {
        log(`DENY MCP tool ${toolName} (only broker/fakechat allowed)`); return { behavior: 'deny', message: 'This MCP tool is disabled.' }
      }
      return { behavior: 'allow', updatedInput: input }
    },
  },
})) {
  if (m.type === 'assistant') for (const c of m.message.content) {
    if (c.type === 'text' && c.text.trim()) console.log(`\n[agent ${now()}] ${c.text.trim()}`)
    if (c.type === 'tool_use') console.log(`[agent ${now()}] -> ${c.name} ${JSON.stringify(c.input).slice(0, 80)}`)
  }
  if (m.type === 'result') console.log(`[turn ${now()}] idle`)
}
