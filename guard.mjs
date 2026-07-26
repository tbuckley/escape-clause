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
// The guard enforces three layers, checked in order:
//   1. FLOOR — hardcoded here, applies always, even with no policy file: crown-jewel
//      credentials (full deny) and host persistence vectors (write deny — LaunchAgents,
//      shell rc files, autostart, systemd user units, ~/.local/bin, git config, ~/.claude).
//      File tools run UNSANDBOXED, so without this a prompt-injected agent could Write a
//      launchd plist or append to ~/.bashrc and have code run OUTSIDE the sandbox at the
//      user's next login. (Sandboxed bash can't: its writes are workspace-only.)
//   2. POLICY — extra denyRead/denyWrite paths stamped by `init` into
//      .claude/escape-clause-policy.json (from ESCAPE_CLAUSE_DENY_READ/_DENY_WRITE).
//   3. SCOPE — the profile's read fence (readScope in the policy file):
//        "home":      nothing under ~ is touchable except the workspace + allowRead.
//        "workspace": only the workspace, allowRead, tmp, and system toolchain paths
//                     (/usr, /opt, /bin, ...) are touchable at all.
//      allowRead carve-outs never override layers 1–2.
//
// Path checks resolve symlinks and `..` first (realpath): the raw string a tool is handed
// can disguise a protected target — `./link` -> ~/.ssh, or workspace/../../.ssh — so a
// literal startsWith() is bypassable. We compare REAL paths on both sides.
//
// Wired in settings.json under hooks.PreToolUse with `|| exit 2` so it fails CLOSED: a
// missing/crashed guard (including a corrupt policy file — JSON.parse throws uncaught on
// purpose) blocks the tool call instead of letting it through. Denies win over allow
// rules and are not bypassable by permission mode.
import { readFileSync, realpathSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'

const HOME = homedir()
const expand = (p) => (p && p.startsWith('~') ? join(HOME, p.slice(1)) : p)

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
const under = (p, roots) => roots.some((x) => p === x || p.startsWith(x + '/'))

let input = {}
try { input = JSON.parse(readFileSync(0, 'utf8')) } catch {}

// ~/.escape-clause covers the broker's state AND its installed code (~/.escape-clause/app)
// — the agent must not be able to modify the server that executes approvals. The
// workspace's own launch config (.claude/, .mcp.json) is protected too: editing it is how
// an agent would swap in its own broker or drop the sandbox on the NEXT launch. (Sandboxed
// bash is covered separately by sandbox.filesystem.denyWrite on the same paths, and
// `launch` refuses to run a config that no longer matches what `init` writes.)
// ~/.claude.json and ~/.claude/.credentials.json hold the user's Claude Code credentials,
// account config, and history — same class as ~/.ssh, so same full deny.
const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || ''
const FLOOR_FULL = ['.ssh', '.aws', '.gnupg', '.config/gcloud', '.escape-clause',
  '.claude.json', '.claude.json.backup', '.claude/.credentials.json']
  .map((p) => join(HOME, p))
  .concat(projectDir ? [join(projectDir, '.mcp.json')] : [])
  .map(realish)

// The workspace's .claude/ keeps the same full deny as the floor, with ONE exception:
// .claude/skills. A skill is prompt content plus scripts that still execute through
// sandboxed bash under this guard, so writing one grants nothing the writable workspace
// doesn't already grant — unlike settings.json (drops the sandbox/hook on next launch)
// or escape-clause-policy.json (this guard's own deny list), which stay denied.
// The exception is the LEXICAL skills path under the RESOLVED .claude root, and it only
// ever narrows the .claude deny — it is not an allow rule: the crown-jewel floor is
// checked first, and every later rule (policy denyRead/denyWrite, profile fences) still
// applies. denyReason realish()es each candidate path, so a `.claude/skills` symlink
// cannot launder the exception elsewhere: the path resolves to its target and is judged
// as the target, never as skills.
const PROJECT_CLAUDE = projectDir ? realish(join(projectDir, '.claude')) : ''
const PROJECT_SKILLS = PROJECT_CLAUDE ? join(PROJECT_CLAUDE, 'skills') : ''

// Host persistence vectors — a write here means the user's own account runs
// attacker-chosen code OUTSIDE the sandbox later: next boot/login (launchd, autostart,
// systemd), next shell (rc files), next command (PATH shadowing), next `git` call
// (core.pager, hooks), next `claude` session (user-level hooks run unsandboxed).
// Write-denied on every profile; both OSes' lists are enforced everywhere since a
// missing path costs nothing on the other OS.
const FLOOR_WRITE = [
  'Library/LaunchAgents', 'Library/LaunchDaemons',                          // macOS launchd
  '.config/autostart', '.config/systemd/user', '.local/share/systemd/user', // Linux login/systemd
  '.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.profile',    // sh/bash rc
  '.zshrc', '.zshenv', '.zprofile', '.zlogin', '.zlogout', '.config/fish',  // zsh/fish rc
  '.local/bin', 'bin',                                                      // PATH hijack
  '.gitconfig', '.config/git',                                              // git hooks/aliases/pager
  '.claude',                                                                // user-level Claude Code hooks
].map((p) => join(HOME, p))
  // package-manager bin dirs are commonly USER-writable on macOS (Homebrew) — shadowing
  // a binary there is the same PATH hijack as ~/.local/bin
  .concat(['/usr/local/bin', '/usr/local/sbin', '/opt/homebrew/bin', '/opt/homebrew/sbin'])
  .map(realish)

// Optional stamped policy (extra deny paths + the profile's read fence). Missing file ->
// floor-only (bare and pre-profile workspaces keep working); corrupt file -> JSON.parse
// throws -> non-zero exit -> the `|| exit 2` wiring blocks the call (fail closed).
let policy = { readScope: 'none', denyRead: [], denyWrite: [], allowRead: [] }
const policyPath = projectDir && join(projectDir, '.claude', 'escape-clause-policy.json')
if (policyPath && existsSync(policyPath)) policy = { ...policy, ...JSON.parse(readFileSync(policyPath, 'utf8')) }
const DENY_READ = (policy.denyRead || []).map(realish)
const DENY_WRITE = (policy.denyWrite || []).map(realish)
const ALLOW_READ = (policy.allowRead || []).map(realish)
const WORKSPACE = projectDir ? realish(projectDir) : ''

// Read fence for the "workspace" scope: toolchain + scratch stays visible so builds and
// installed deps keep working; everything else (other repos, /etc, /var, other users'
// homes) does not exist as far as file tools are concerned.
const SCRATCH = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders', '/dev/null'].map(realish)
const SYSTEM_READ = ['/usr', '/opt', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32',
  '/System', '/Library', '/Applications', '/nix', '/snap'].map(realish).concat(SCRATCH)

// Read/Grep/Glob only observe; everything else path-bearing is classified as a write —
// including tools this guard has never heard of. Over-classifying an unknown tool as a
// write only ever denies MORE (write rules are a superset of read rules), so a future
// file-mutating tool fails closed instead of slipping into the laxer read bucket.
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob'])
const ti = input.tool_input || {}
// paths a file tool might touch: Read/Edit/Write use file_path, NotebookEdit notebook_path,
// Grep/Glob use path. Bash is covered by the sandbox; tools with no path yield [] and pass.
const paths = [ti.file_path, ti.notebook_path, ti.path].filter(Boolean)
const isWrite = !READ_TOOLS.has(input.tool_name)

function denyReason(raw) {
  const p = realish(raw)
  if (!p) return null
  if (under(p, FLOOR_FULL)) return `Protected path (${raw}) — not accessible to file tools.`
  if (PROJECT_CLAUDE && under(p, [PROJECT_CLAUDE]) && !under(p, [PROJECT_SKILLS]))
    return `Workspace launch config (${raw}) — .claude is not accessible to file tools, except .claude/skills.`
  if (isWrite && under(p, FLOOR_WRITE)) return `Host persistence vector (${raw}) — file tools may not write to login/startup/PATH/git/Claude config.`
  if (under(p, DENY_READ)) return `Deny-read path (${raw}) — blocked by this workspace's policy.`
  if (isWrite && under(p, DENY_WRITE)) return `Deny-write path (${raw}) — blocked by this workspace's policy.`
  const carvedOut = (WORKSPACE && under(p, [WORKSPACE])) || under(p, ALLOW_READ)
  if (policy.readScope === 'home' && !carvedOut && under(p, [realish(HOME)]))
    return `Home directory (${raw}) — this workspace's profile hides everything under ~ except the workspace.`
  if (policy.readScope === 'workspace') {
    // writes are tighter than reads: allowRead and SYSTEM_READ are read-only fences —
    // never write targets (a write to a user-writable /opt/homebrew/bin is persistence)
    if (isWrite && !(WORKSPACE && under(p, [WORKSPACE])) && !under(p, SCRATCH))
      return `Outside the workspace (${raw}) — this workspace's profile limits file-tool writes to the workspace and tmp.`
    if (!carvedOut && !under(p, SYSTEM_READ))
      return `Outside the workspace (${raw}) — this workspace's profile limits file tools to the workspace, tmp, and system toolchain paths.`
  }
  return null
}

const reason = paths.map(denyReason).find(Boolean)
if (reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `${reason} Use the broker if you need something outside the sandbox.`,
    },
  }))
}
process.exit(0)
