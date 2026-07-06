#!/usr/bin/env node
// PreToolUse guard — one global choke point for protected-path access.
//
// Per-tool deny rules (Read()/Edit()/Write()...) are verbose AND leaky: you'd also need
// Grep, Glob, NotebookEdit, and any future file tool. This hook is wired with a `*`
// matcher so it runs before EVERY tool call, pulls whatever path the tool touches, and
// denies if it resolves inside a protected path — covering all tools uniformly, present
// and future (the settings-based equivalent of the driver's canUseTool). Tools with no
// path (Bash, MCP, WebFetch, ...) simply fall through untouched.
//
// Path checks resolve symlinks and `..` first (realpath): the raw string a tool is handed
// can disguise a protected target — `./link` -> ~/.ssh, or workspace/../../.ssh — so a
// literal startsWith() is bypassable. We compare REAL paths on both sides.
//
// Wired in settings.json under hooks.PreToolUse. Denies win over allow rules and are not
// bypassable by permission mode.
import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'

const expand = (p) => (p && p.startsWith('~') ? join(homedir(), p.slice(1)) : p)

// Resolve to a real, absolute path: expand ~, collapse `..`, and follow symlinks. If the
// path doesn't exist yet (e.g. a Write to a new file), realpath the longest existing
// ancestor and re-append the missing tail — that still catches a symlinked parent dir.
function realish(p) {
  const e = expand(p)
  if (!e) return e
  const abs = resolve(e)
  const tail = []
  for (let dir = abs; ; dir = dirname(dir)) {
    try { return join(realpathSync(dir), ...tail.reverse()) } catch {}
    const parent = dirname(dir)
    if (parent === dir) return abs   // reached filesystem root, nothing resolved
    tail.push(basename(dir))
  }
}

let input = {}
try { input = JSON.parse(readFileSync(0, 'utf8')) } catch {}

// ~/.clawmini-demo covers the broker's state AND its installed code (~/.clawmini-demo/app)
// — the agent must not be able to modify the server that executes approvals. The
// workspace's own launch config (.claude/, .mcp.json) is protected too: editing it is how
// an agent would swap in its own broker or drop the sandbox on the NEXT launch. (The
// launcher also re-stamps that config from the protected store every launch.)
const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || ''
const PROTECTED = ['.ssh', '.aws', '.gnupg', '.config/gcloud', '.clawmini-demo']
  .map((p) => join(homedir(), p))
  .concat(projectDir ? [join(projectDir, '.claude'), join(projectDir, '.mcp.json')] : [])
  .map(realish)
const isProtected = (p) => { const a = realish(p); return !!a && PROTECTED.some((x) => a === x || a.startsWith(x + '/')) }
const ti = input.tool_input || {}
// paths a file tool might touch: Read/Edit/Write use file_path, NotebookEdit notebook_path,
// Grep/Glob use path. Bash is covered by the sandbox; tools with no path yield [] and pass.
const paths = [ti.file_path, ti.notebook_path, ti.path].filter(Boolean)

if (paths.some(isProtected)) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Protected path (${paths.find(isProtected)}) — not accessible to file tools. Use the broker if you need something outside the sandbox.`,
    },
  }))
}
process.exit(0)
