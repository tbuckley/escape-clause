#!/usr/bin/env node
// PreToolUse guard — one global choke point for protected-path access.
//
// Per-tool deny rules (Read()/Edit()/Write()...) are verbose AND leaky: you'd also need
// Grep, Glob, NotebookEdit, and any future file tool. This hook runs before EVERY tool
// call, pulls whatever path the tool touches, and denies if it's protected — covering all
// tools uniformly (the settings-based equivalent of the driver's canUseTool).
//
// Wired in settings.json under hooks.PreToolUse. Denies win over allow rules and are not
// bypassable by permission mode.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PROTECTED = ['.ssh', '.aws', '.gnupg', '.config/gcloud', '.clawmini-demo'].map((p) => join(homedir(), p))
const expand = (p) => (p && p.startsWith('~') ? join(homedir(), p.slice(1)) : p)
const isProtected = (p) => { const a = expand(p); return !!a && PROTECTED.some((x) => a === x || a.startsWith(x + '/')) }

let input = {}
try { input = JSON.parse(readFileSync(0, 'utf8')) } catch {}
const ti = input.tool_input || {}
// paths a file tool might touch: Read/Edit/Write use file_path, NotebookEdit notebook_path,
// Grep/Glob use path (+ Grep's glob). Bash is covered by the sandbox, not this hook.
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
