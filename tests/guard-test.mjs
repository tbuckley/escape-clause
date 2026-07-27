#!/usr/bin/env node
// Unit tests for guard.mjs — the PreToolUse choke point for file-tool directory access.
//
// Each case pipes a fabricated hook payload into the guard exactly as Claude Code would
// (JSON on stdin, CLAUDE_PROJECT_DIR in env) against a REAL workspace stamped by
// `escape-clause.sh init`, and asserts on the decision: deny JSON on stdout, empty stdout
// for pass-through, non-zero exit for fail-closed. No SDK, no network, no install needed.
//
// Run: node tests/guard-test.mjs
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GUARD = join(ROOT, 'guard.mjs')
const HOME = homedir()

// init now records a config in the store (ESCAPE_CLAUSE_DIR) — point it at a throwaway
// one so test runs never touch the real ~/.escape-clause.
const STORE = mkdtempSync(join(tmpdir(), 'guard-test-store-'))

function stamp(env = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'guard-test-ws-'))
  const r = spawnSync('sh', [join(ROOT, 'escape-clause.sh'), 'init', ws],
    { encoding: 'utf8', env: { ...process.env, ESCAPE_CLAUSE_DIR: STORE, ...env } })
  if (r.status !== 0) throw new Error(`init failed: ${r.stderr || r.stdout}`)
  return ws
}

// -> 'deny' | 'allow' | 'crash'
function guard(ws, tool_name, tool_input) {
  const r = spawnSync('node', [GUARD], {
    encoding: 'utf8',
    input: JSON.stringify({ tool_name, tool_input, cwd: ws }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: ws },
  })
  if (r.status !== 0) return 'crash'
  return /"permissionDecision":\s*"deny"/.test(r.stdout) ? 'deny' : 'allow'
}

let failed = 0
function t(name, got, want) {
  const ok = got === want
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${got}, want ${want})`}`)
}

// A decoy "forbidden" dir we control, for policy extras + the symlink probe — the
// hardcoded floor points at real paths like ~/.ssh which the test must not create.
const forbidden = mkdtempSync(join(tmpdir(), 'guard-test-forbidden-'))
writeFileSync(join(forbidden, 'secret.txt'), 'x')

// ---- default profile: floor only ----
{
  const ws = stamp({ ESCAPE_CLAUSE_PROFILE: 'default', ESCAPE_CLAUSE_DENY_READ: forbidden, ESCAPE_CLAUSE_DENY_WRITE: '/tmp/guard-test-noscribble' })
  t('default: Read ~/.ssh denied (floor)', guard(ws, 'Read', { file_path: join(HOME, '.ssh/id_rsa') }), 'deny')
  t('default: Read ~/.claude.json denied (floor)', guard(ws, 'Read', { file_path: join(HOME, '.claude.json') }), 'deny')
  t('default: Grep ~/.aws denied (floor covers search tools)', guard(ws, 'Grep', { path: join(HOME, '.aws') }), 'deny')
  t('default: Write LaunchAgents plist denied (persistence floor)', guard(ws, 'Write', { file_path: join(HOME, 'Library/LaunchAgents/evil.plist') }), 'deny')
  t('default: Edit ~/.bashrc denied (persistence floor)', guard(ws, 'Edit', { file_path: join(HOME, '.bashrc') }), 'deny')
  t('default: Write ~/.config/autostart denied (persistence floor)', guard(ws, 'Write', { file_path: join(HOME, '.config/autostart/evil.desktop') }), 'deny')
  t('default: Write ~/.config/systemd/user denied (persistence floor)', guard(ws, 'Write', { file_path: join(HOME, '.config/systemd/user/evil.service') }), 'deny')
  t('default: Write ~/.local/bin denied (PATH hijack floor)', guard(ws, 'Write', { file_path: join(HOME, '.local/bin/git') }), 'deny')
  t('default: Write /usr/local/bin denied (PATH hijack floor)', guard(ws, 'Write', { file_path: '/usr/local/bin/git' }), 'deny')
  t('default: Write ~/.claude denied (unsandboxed-hook floor)', guard(ws, 'Write', { file_path: join(HOME, '.claude/settings.json') }), 'deny')
  t('default: Write workspace .claude denied (launch config floor)', guard(ws, 'Write', { file_path: join(ws, '.claude/settings.json') }), 'deny')
  t('default: Write workspace guard policy denied (launch config floor)', guard(ws, 'Write', { file_path: join(ws, '.claude/escape-clause-policy.json') }), 'deny')
  t('default: Read workspace .claude denied (launch config floor)', guard(ws, 'Read', { file_path: join(ws, '.claude/settings.json') }), 'deny')
  t('default: Write .claude/skills allowed (skills carve-out)', guard(ws, 'Write', { file_path: join(ws, '.claude/skills/my-skill/SKILL.md') }), 'allow')
  t('default: Read .claude/skills allowed (skills carve-out)', guard(ws, 'Read', { file_path: join(ws, '.claude/skills/my-skill/SKILL.md') }), 'allow')
  t('default: ../ out of skills back into .claude denied', guard(ws, 'Edit', { file_path: join(ws, '.claude/skills/../settings.json') }), 'deny')
  t('default: Read ~/.bashrc allowed (persistence list is write-only)', guard(ws, 'Read', { file_path: join(HOME, '.bashrc') }), 'allow')
  t('default: Read ~/Documents allowed (no read fence)', guard(ws, 'Read', { file_path: join(HOME, 'Documents/x.txt') }), 'allow')
  t('default: Write inside workspace allowed', guard(ws, 'Write', { file_path: join(ws, 'src/a.js') }), 'allow')
  t('default: Bash passes through (no path in input)', guard(ws, 'Bash', { command: `cat ${join(HOME, '.ssh/id_rsa')}` }), 'allow')
  t('default: unknown path-bearing tool treated as write (fails closed)', guard(ws, 'FutureFileTool', { file_path: join(HOME, '.bashrc') }), 'deny')
  t('default: DENY_READ extra denied', guard(ws, 'Read', { file_path: join(forbidden, 'secret.txt') }), 'deny')
  t('default: DENY_READ extra blocks writes too', guard(ws, 'Write', { file_path: join(forbidden, 'new.txt') }), 'deny')
  t('default: DENY_WRITE extra blocks writes', guard(ws, 'Write', { file_path: '/tmp/guard-test-noscribble/x' }), 'deny')
  t('default: DENY_WRITE extra still readable', guard(ws, 'Read', { file_path: '/tmp/guard-test-noscribble/x' }), 'allow')

  // symlink laundering: a link inside the workspace pointing at a denied dir
  symlinkSync(forbidden, join(ws, 'link'))
  t('default: symlinked deny path denied (realpath both sides)', guard(ws, 'Read', { file_path: join(ws, 'link/secret.txt') }), 'deny')
  t('default: ../ traversal into deny path denied', guard(ws, 'Read', { file_path: `${ws}/sub/../../${forbidden.split('/').pop()}/secret.txt` }), 'deny')

  // a symlinked skills dir must not launder the carve-out onto its target: the path
  // resolves to the target (here a denied decoy) and is judged as the target
  rmSync(join(ws, '.claude/skills'), { recursive: true, force: true })
  symlinkSync(forbidden, join(ws, '.claude/skills'))
  t('default: symlinked .claude/skills judged as its target (no laundering)', guard(ws, 'Write', { file_path: join(ws, '.claude/skills/new.txt') }), 'deny')

  // fail closed: corrupt policy must crash the guard (the `|| exit 2` wiring blocks the call)
  writeFileSync(join(ws, '.claude/escape-clause-policy.json'), '{nope')
  t('default: corrupt policy file crashes (fail closed)', guard(ws, 'Read', { file_path: '/etc/hosts' }), 'crash')
  rmSync(ws, { recursive: true, force: true })
}

// ---- strict profile: home hidden except workspace + allowRead ----
// The workspace deliberately lives UNDER ~ — the exact case the carve-out exists for.
{
  const shared = mkdtempSync(join(HOME, '.guard-test-shared-'))   // a real dir under ~ to carve back in
  const under = mkdtempSync(join(HOME, '.guard-test-under-home-'))
  const wsDir = join(under, 'ws')
  const r = spawnSync('sh', [join(ROOT, 'escape-clause.sh'), 'init', wsDir],
    { encoding: 'utf8', env: { ...process.env, ESCAPE_CLAUSE_DIR: STORE, ESCAPE_CLAUSE_PROFILE: 'strict', ESCAPE_CLAUSE_ALLOW_READ: shared } })
  if (r.status !== 0) throw new Error(`init failed: ${r.stderr || r.stdout}`)
  const ws = wsDir
  t('strict: Read anywhere under ~ denied', guard(ws, 'Read', { file_path: join(HOME, 'notes.txt') }), 'deny')
  t('strict: Glob under ~ denied', guard(ws, 'Glob', { pattern: '**', path: join(HOME, 'Documents') }), 'deny')
  t('strict: Write under ~ denied', guard(ws, 'Write', { file_path: join(HOME, 'notes.txt') }), 'deny')
  t('strict: workspace under ~ stays fully usable', guard(ws, 'Read', { file_path: join(ws, 'a.js') }), 'allow')
  t('strict: workspace under ~ stays writable', guard(ws, 'Write', { file_path: join(ws, 'a.js') }), 'allow')
  t('strict: sibling of workspace under ~ still denied', guard(ws, 'Read', { file_path: join(under, 'other.txt') }), 'deny')
  t('strict: .claude/skills writable (carve-out inside workspace)', guard(ws, 'Write', { file_path: join(ws, '.claude/skills/s/SKILL.md') }), 'allow')
  t('strict: workspace .claude config still denied', guard(ws, 'Write', { file_path: join(ws, '.claude/settings.json') }), 'deny')
  t('strict: allowRead carve-out works', guard(ws, 'Read', { file_path: join(shared, 'x.md') }), 'allow')
  t('strict: allowRead never overrides the floor', guard(ws, 'Read', { file_path: join(HOME, '.ssh/id_rsa') }), 'deny')
  t('strict: outside ~ unaffected (/etc readable)', guard(ws, 'Read', { file_path: '/etc/hosts' }), 'allow')
  t('strict: /tmp writable', guard(ws, 'Write', { file_path: '/tmp/guard-test-scratch.txt' }), 'allow')
  rmSync(under, { recursive: true, force: true }); rmSync(shared, { recursive: true, force: true })
}

// ---- paranoid profile: workspace + tmp + system toolchain only ----
{
  const ws = stamp({ ESCAPE_CLAUSE_PROFILE: 'paranoid' })
  t('paranoid: Read /etc denied', guard(ws, 'Read', { file_path: '/etc/hosts' }), 'deny')
  t('paranoid: Read under ~ denied', guard(ws, 'Read', { file_path: join(HOME, 'notes.txt') }), 'deny')
  t('paranoid: Read other home denied', guard(ws, 'Read', { file_path: '/home/other/repo/a.js' }), 'deny')
  t('paranoid: Read toolchain path allowed (/usr)', guard(ws, 'Read', { file_path: '/usr/lib/node_modules/x.js' }), 'allow')
  t('paranoid: Read workspace allowed', guard(ws, 'Read', { file_path: join(ws, 'a.js') }), 'allow')
  t('paranoid: Write /tmp allowed', guard(ws, 'Write', { file_path: '/tmp/guard-test-scratch.txt' }), 'allow')
  t('paranoid: Write toolchain path denied (read fence is read-only)', guard(ws, 'Write', { file_path: '/opt/tool/bin/x' }), 'deny')
  t('paranoid: Write workspace allowed', guard(ws, 'Write', { file_path: join(ws, 'a.js') }), 'allow')
  t('paranoid: .claude/skills writable (carve-out inside workspace)', guard(ws, 'Write', { file_path: join(ws, '.claude/skills/s/SKILL.md') }), 'allow')
  t('paranoid: workspace .claude config still denied', guard(ws, 'Read', { file_path: join(ws, '.claude/settings.json') }), 'deny')
  rmSync(ws, { recursive: true, force: true })
}

rmSync(forbidden, { recursive: true, force: true })
rmSync(STORE, { recursive: true, force: true })
if (failed) { console.error(`\n${failed} guard test(s) FAILED`); process.exit(1) }
console.log('\nall guard tests passed')
