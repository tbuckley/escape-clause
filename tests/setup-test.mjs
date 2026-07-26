#!/usr/bin/env node
// Unit tests for setup.mjs — the config-file side of init/verify/launch (issue #16).
//
// Everything runs against a throwaway store (ESCAPE_CLAUSE_DIR) and throwaway
// workspaces; the real ~/.escape-clause is never touched. io flows go through real
// subprocesses (exactly how escape-clause.sh invokes setup.mjs, headless); the pure
// config->stamp function is imported directly.
//
// Run: node tests/setup-test.mjs
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SETUP = join(ROOT, 'setup.mjs')
const STORE = mkdtempSync(join(tmpdir(), 'setup-test-store-'))

const run = (args, env = {}) => spawnSync('node', [SETUP, ...args],
  { encoding: 'utf8', env: { ...process.env, ESCAPE_CLAUSE_DIR: STORE, ...env } })

let failed = 0
function t(name, ok, detail = '') {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${detail})`}`)
}

const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'))

// ---- init writes config + registry + stamp; verify passes ----
{
  const ws = mkdtempSync(join(tmpdir(), 'setup-test-ws-'))
  const r = run(['init', ws, '--defaults'])
  t('init --defaults succeeds', r.status === 0, r.stderr)
  const reg = readJson(join(STORE, 'workspaces.json'))
  t('registry maps workspace to a config name', typeof reg[ws] === 'string', JSON.stringify(reg))
  const cfg = readJson(join(STORE, 'configs', `${reg[ws]}.json`))
  t('config records the workspace and default profile', cfg.workspace === ws && cfg.profile === 'default')
  for (const f of ['.claude/settings.json', '.claude/settings.local.json', '.claude/escape-clause-policy.json', '.mcp.json', 'CLAUDE.md'])
    t(`init stamped ${f}`, existsSync(join(ws, f)))
  t('init pre-created .claude/skills (agent-writable carve-out)', existsSync(join(ws, '.claude/skills')))
  t('skills carve-out stamped into sandbox allowWrite',
    readFileSync(join(ws, '.claude/settings.json'), 'utf8').includes('"allowWrite": ["./.claude/skills"]'))
  t('broker env is fully stamped (no launch-time env needed)',
    readFileSync(join(ws, '.mcp.json'), 'utf8').includes('"ESCAPE_CLAUSE_UI_PORT": "8790"'))
  const v = run(['verify', ws])
  t('verify passes right after init', v.status === 0, v.stderr)

  // ---- tampered stamp: refused, and the diff is NAMED ----
  const settings = join(ws, '.claude/settings.json')
  const orig = readFileSync(settings, 'utf8')
  writeFileSync(settings, orig.replace('"allowUnsandboxedCommands": false', '"allowUnsandboxedCommands": true'))
  const v2 = run(['verify', ws])
  t('tampered stamp fails verify', v2.status === 1)
  t('tamper diff names the drifted setting', v2.stderr.includes('sandbox.allowUnsandboxedCommands'), v2.stderr)
  t('verify never rewrites (tamper still on disk)', readFileSync(settings, 'utf8').includes('"allowUnsandboxedCommands": true'))

  // ---- edited config: refused with the setting named; re-init converges ----
  writeFileSync(settings, orig)
  const cfgPath = join(STORE, 'configs', `${reg[ws]}.json`)
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, profile: 'paranoid' }, null, 2))
  const v3 = run(['verify', ws])
  t('config edit without re-stamp fails verify', v3.status === 1)
  t('config-edit diff mentions the profile', v3.stderr.includes('"paranoid"'), v3.stderr)
  const r2 = run(['init', ws])
  t('re-init re-stamps from the edited config', r2.status === 0, r2.stderr)
  t('re-init then verify passes', run(['verify', ws]).status === 0)
  t('policy file carries the new profile', readFileSync(join(ws, '.claude/escape-clause-policy.json'), 'utf8').includes('"paranoid"'))

  // ---- launch-info: exact command on stdout ----
  const r3 = run(['init', ws, '--channels', 'plugin:fakechat@claude-plugins-official', '--channel-tools', 'mcp__plugin_fakechat_fakechat'])
  t('init with channel flags succeeds', r3.status === 0, r3.stderr)
  t('channel tool lands in the stamped allow-list', readFileSync(settings, 'utf8').includes('"mcp__plugin_fakechat_fakechat"'))
  const li = run(['launch-info', ws])
  t('launch-info succeeds', li.status === 0, li.stderr)
  t('launch-info prints the exact claude command',
    li.stdout.trim() === 'claude --channels plugin:fakechat@claude-plugins-official --dangerously-load-development-channels server:broker', li.stdout)
  rmSync(ws, { recursive: true, force: true })
}

// ---- env shims: honored (with a notice) for a NEW config, ignored after ----
{
  const ws = mkdtempSync(join(tmpdir(), 'setup-test-ws-'))
  const r = run(['init', ws], { ESCAPE_CLAUSE_PROFILE: 'strict' })
  t('env shim seeds a fresh config', r.status === 0 && r.stderr.includes('deprecated'), r.stderr)
  const reg = readJson(join(STORE, 'workspaces.json'))
  t('shimmed profile saved to the config', readJson(join(STORE, 'configs', `${reg[ws]}.json`)).profile === 'strict')
  const r2 = run(['init', ws], { ESCAPE_CLAUSE_PROFILE: 'paranoid' })
  t('env ignored once a config exists', r2.status === 0 && r2.stderr.includes('ignored'), r2.stderr)
  t('config remains authoritative', readJson(join(STORE, 'configs', `${reg[ws]}.json`)).profile === 'strict')
  t('launch stays consistent from any shell (verify passes without env)', run(['verify', ws]).status === 0)
  rmSync(ws, { recursive: true, force: true })
}

// ---- refusals ----
{
  const ws = mkdtempSync(join(tmpdir(), 'setup-test-ws-'))
  t('allowRead cannot re-expose a jewel', run(['init', ws, '--allow-read', '~/.ssh']).status === 1)
  t('bad profile refused', run(['init', ws, '--profile', 'yolo']).status === 1)
  t('bad expose refused', run(['init', ws, '--expose', 'magic']).status === 1)
  t('quote in a path refused', run(['init', ws, '--deny-read', '/tmp/a"b']).status === 1)
  t('relative path refused', run(['init', ws, '--deny-read', 'relative/path']).status === 1)
  // a stamped-but-unregistered workspace (pre-config era) must point at migration
  run(['init', ws, '--defaults'])
  const reg = readJson(join(STORE, 'workspaces.json'))
  delete reg[ws]; writeFileSync(join(STORE, 'workspaces.json'), JSON.stringify(reg))
  const li = run(['launch-info', ws])
  t('pre-config workspace told to migrate via init', li.status === 1 && li.stderr.includes('escape-clause init'), li.stderr)
  rmSync(ws, { recursive: true, force: true })
}

// ---- buildStamp is pure and deterministic ----
{
  const { buildStamp, defaultConfig } = await import(SETUP)
  const a = buildStamp(defaultConfig('/w'), { app: '/app' })
  const b = buildStamp(defaultConfig('/w'), { app: '/app' })
  t('same config -> identical bytes', JSON.stringify(a) === JSON.stringify(b))
  const strict = { ...defaultConfig('/w'), profile: 'strict' }
  const s = buildStamp(strict, { app: '/app' })
  t('strict profile hides ~ and carves the workspace back in',
    s['.claude/settings.json'].includes('"~/"') && s['.claude/settings.json'].includes('"allowRead": ["."]'))
  t('every stamped file is valid JSON', ['.claude/settings.json', '.claude/settings.local.json', '.claude/escape-clause-policy.json', '.mcp.json']
    .every((f) => { try { JSON.parse(a[f]); return true } catch { return false } }))
  t('escape hatch stays closed in the stamp', a['.claude/settings.json'].includes('"allowUnsandboxedCommands": false'))
  t('exposure provider lands in broker env', buildStamp({ ...defaultConfig('/w'), ui: { port: 8790, url: '', expose: 'tailscale' } }, { app: '/app' })['.mcp.json'].includes('"ESCAPE_CLAUSE_EXPOSE": "tailscale"'))
}

rmSync(STORE, { recursive: true, force: true })
if (failed) { console.error(`\n${failed} setup test(s) FAILED`); process.exit(1) }
console.log('\nall setup tests passed')
