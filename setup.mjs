#!/usr/bin/env node
// Escape Clause setup — the config-file side of init/launch (issue #16).
//
// Invoked by escape-clause.sh:
//   node setup.mjs init <dir> [flags]     write/refresh the workspace's config + stamp it
//   node setup.mjs verify <dir>           explain-or-pass: stamp must match the config
//   node setup.mjs launch-info <dir>      verify, print launch info (stderr) + the exact
//                                         claude command (stdout) for the launcher to exec
//
// The source of truth is a per-workspace config file in the PROTECTED store:
//   ~/.escape-clause/configs/<name>.json   plain JSON, human-edited or wizard-written
//   ~/.escape-clause/workspaces.json       registry: absolute workspace path -> name
// The agent can neither read nor write the store (sandbox denyRead + guard floor), so
// the file that defines the fence lives outside the fence. `init` stamps the workspace
// from the config; `launch` verifies the stamp against it byte-for-byte and refuses
// drift with a NAMED diff — never a silent rewrite.
//
// ESCAPE_CLAUSE_* env vars (except ESCAPE_CLAUSE_DIR, which locates the store itself)
// are deprecation shims: init takes them as defaults for a NEW config and says so;
// launch ignores them and says so. Config identity no longer lives in your shell.
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, chmodSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'

const HOME = homedir()
export const BASE = process.env.ESCAPE_CLAUSE_DIR || join(HOME, '.escape-clause')
const APP = join(BASE, 'app')
const CONFIGS = join(BASE, 'configs')
const REGISTRY = join(BASE, 'workspaces.json')
const SELF_DIR = dirname(fileURLToPath(import.meta.url))

const PROFILES = ['default', 'strict', 'paranoid']
const RELAYS = ['deny', 'forward', 'off']
const die = (msg) => { process.stderr.write(`error: ${msg}\n`); process.exit(1) }
const note = (msg) => process.stderr.write(`${msg}\n`)

// ---------------------------------------------------------------- config shape

export function defaultConfig(workspace) {
  return {
    workspace,
    profile: 'default',
    relay: 'deny',
    ui: { port: 8790, url: '', expose: '' },
    proxyPort: 8791,
    channels: { specs: [], tools: [] },
    paths: { denyRead: [], denyWrite: [], allowRead: [] },
  }
}

// Env shims: the old interface, honored as DEFAULTS for a new config (with a notice).
const SHIM_VARS = ['ESCAPE_CLAUSE_PROFILE', 'ESCAPE_CLAUSE_RELAY', 'ESCAPE_CLAUSE_UI_PORT',
  'ESCAPE_CLAUSE_UI_URL', 'ESCAPE_CLAUSE_PROXY_PORT', 'ESCAPE_CLAUSE_CHANNELS',
  'ESCAPE_CLAUSE_CHANNEL_TOOLS', 'ESCAPE_CLAUSE_DENY_READ', 'ESCAPE_CLAUSE_DENY_WRITE',
  'ESCAPE_CLAUSE_ALLOW_READ']
const setShims = () => SHIM_VARS.filter((v) => (process.env[v] || '') !== '')
const splitList = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean)

function applyEnvShims(cfg) {
  const e = process.env
  if (e.ESCAPE_CLAUSE_PROFILE) cfg.profile = e.ESCAPE_CLAUSE_PROFILE
  if (e.ESCAPE_CLAUSE_RELAY) cfg.relay = e.ESCAPE_CLAUSE_RELAY
  if (e.ESCAPE_CLAUSE_UI_PORT) cfg.ui.port = Number(e.ESCAPE_CLAUSE_UI_PORT)
  if (e.ESCAPE_CLAUSE_UI_URL) cfg.ui.url = e.ESCAPE_CLAUSE_UI_URL
  if (e.ESCAPE_CLAUSE_PROXY_PORT) cfg.proxyPort = Number(e.ESCAPE_CLAUSE_PROXY_PORT)
  if (e.ESCAPE_CLAUSE_CHANNELS) cfg.channels.specs = String(e.ESCAPE_CLAUSE_CHANNELS).split(/\s+/).filter(Boolean)
  if (e.ESCAPE_CLAUSE_CHANNEL_TOOLS) cfg.channels.tools = splitList(e.ESCAPE_CLAUSE_CHANNEL_TOOLS)
  if (e.ESCAPE_CLAUSE_DENY_READ) cfg.paths.denyRead = splitList(e.ESCAPE_CLAUSE_DENY_READ)
  if (e.ESCAPE_CLAUSE_DENY_WRITE) cfg.paths.denyWrite = splitList(e.ESCAPE_CLAUSE_DENY_WRITE)
  if (e.ESCAPE_CLAUSE_ALLOW_READ) cfg.paths.allowRead = splitList(e.ESCAPE_CLAUSE_ALLOW_READ)
  return cfg
}

// ---------------------------------------------------------------- validation
// Ports of check_paths / check_allow_read from the shell version — same refusals,
// same reasons: entries land in stamped JSON verbatim (no magic), and allowRead
// carves exceptions out of the read fence, so it must never re-open a jewel.

const PROTECTED = () => [join(HOME, '.ssh'), join(HOME, '.aws'), join(HOME, '.gnupg'),
  join(HOME, '.config/gcloud'), BASE, join(HOME, '.claude.json'), join(HOME, '.claude')]

const expand = (p) => p === '~' ? HOME : p.startsWith('~/') ? join(HOME, p.slice(2)) : p

function checkPathList(list, name) {
  for (const p of list) {
    if (/["\\]/.test(p)) die(`${name} entry '${p}' contains a quote or backslash`)
    if (!(p.startsWith('/') || p === '~' || p.startsWith('~/')))
      die(`${name} entry '${p}' must be an absolute or ~-prefixed path`)
  }
}

function checkAllowRead(list) {
  for (const p of list) {
    let exp = expand(p).replace(/\/+$/, '') || '/'
    if (exp === '/') die(`allowRead entry '${p}' would re-expose the whole filesystem — refusing`)
    for (const j of PROTECTED()) {
      if (exp === j || exp.startsWith(j + '/'))
        die(`allowRead entry '${p}' is inside protected '${j}' — refusing`)
      if (j === exp || j.startsWith(exp + '/'))
        die(`allowRead entry '${p}' would re-expose protected '${j}' — refusing`)
    }
  }
}

export function validateConfig(cfg) {
  if (!PROFILES.includes(cfg.profile)) die(`profile must be one of ${PROFILES.join('|')} (got '${cfg.profile}')`)
  if (!RELAYS.includes(cfg.relay)) die(`relay must be one of ${RELAYS.join('|')} (got '${cfg.relay}')`)
  for (const [k, v] of [['ui.port', cfg.ui.port], ['proxyPort', cfg.proxyPort]])
    if (!Number.isInteger(v) || v < 1 || v > 65535) die(`${k} must be a port number (got '${v}')`)
  if (cfg.ui.url && cfg.ui.expose) die(`ui.url and ui.expose are mutually exclusive — a static URL means you run the tunnel; a provider means the broker does`)
  if (cfg.ui.expose && cfg.ui.expose !== 'tailscale' && !/^script:[A-Za-z0-9._-]+$/.test(cfg.ui.expose))
    die(`ui.expose must be 'tailscale' or 'script:<name>' (a file in ${join(BASE, 'expose')}) — got '${cfg.ui.expose}'`)
  checkPathList(cfg.paths.denyRead, 'denyRead')
  checkPathList(cfg.paths.denyWrite, 'denyWrite')
  checkPathList(cfg.paths.allowRead, 'allowRead')
  checkAllowRead(cfg.paths.allowRead)
}

// Both init and launch refuse the two directories that would defeat the design.
function checkWs(ws) {
  if (existsSync(join(ws, 'broker.mjs')) || existsSync(join(ws, 'server.mjs')))
    die(`${ws} contains the broker source — the agent must not run there.\nPick an empty/project directory, e.g.: escape-clause init ~/escape-clause-workspace`)
  if ((ws + '/').startsWith(BASE + '/')) die(`refusing to use the protected store (${BASE}) as a workspace`)
}

// ---------------------------------------------------------------- registry + config io

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null } }
export const loadRegistry = () => readJson(REGISTRY) || {}
function saveRegistry(reg) {
  mkdirSync(BASE, { recursive: true, mode: 0o700 })
  writeFileSync(REGISTRY, JSON.stringify(reg, null, 2) + '\n', { mode: 0o600 })
}

export const configPath = (name) => join(CONFIGS, `${name}.json`)

export function loadConfigFor(ws) {
  const name = loadRegistry()[ws]
  if (!name) return { name: null, cfg: null }
  const raw = readJson(configPath(name))
  if (!raw) return { name, cfg: null }
  // Merge over defaults so a hand-edited file may omit whole sections.
  const cfg = defaultConfig(ws)
  Object.assign(cfg, raw)
  cfg.ui = { ...defaultConfig(ws).ui, ...(raw.ui || {}) }
  cfg.channels = { specs: [], tools: [], ...(raw.channels || {}) }
  cfg.paths = { denyRead: [], denyWrite: [], allowRead: [], ...(raw.paths || {}) }
  cfg.workspace = ws
  return { name, cfg }
}

function allocateName(ws, wanted) {
  const reg = loadRegistry()
  const base = (wanted || basename(ws)).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '') || 'workspace'
  const taken = new Set(Object.values(reg))
  let name = base
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`
  return name
}

function saveConfig(name, cfg) {
  mkdirSync(CONFIGS, { recursive: true, mode: 0o700 })
  writeFileSync(configPath(name), JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
  const reg = loadRegistry()
  reg[cfg.workspace] = name
  saveRegistry(reg)
}

// ---------------------------------------------------------------- the stamp
// Pure: config -> the exact bytes of the four workspace files. `init` writes them,
// `verify` regenerates and compares. Formats mirror the original shell heredocs.

export function buildStamp(cfg, { app = APP } = {}) {
  const arr = (items) => items.map((x) => JSON.stringify(x)).join(', ')
  const allow = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'mcp__broker', ...cfg.channels.tools]

  // Profile -> the BASH read fence (sandbox.filesystem; the guard hook mirrors it for
  // file tools via the policy file below). strict/paranoid hide the whole home dir
  // with denyRead "~/" and carve the workspace back in with allowRead "." — the
  // sandbox re-allows inside denied regions, so a workspace under ~ keeps working.
  // The crown-jewel entries stay listed even when "~/" subsumes them: explicit is
  // auditable, and they're what protects the default profile.
  const jewels = ['~/.ssh', '~/.aws', '~/.gnupg', '~/.config/gcloud', '~/.escape-clause',
    '~/.claude.json', '~/.claude/.credentials.json']
  let denyRead = [...jewels], allowRead = [], readScope = 'none'
  if (cfg.profile === 'strict') { denyRead = ['~/', ...jewels]; allowRead = ['.']; readScope = 'home' }
  if (cfg.profile === 'paranoid') { denyRead = ['~/', ...jewels, '/Volumes', '/media', '/mnt']; allowRead = ['.']; readScope = 'workspace' }
  denyRead = [...denyRead, ...cfg.paths.denyRead]
  allowRead = [...allowRead, ...cfg.paths.allowRead]
  const denyWrite = ['./.claude', './.mcp.json', '~/.escape-clause', ...cfg.paths.denyWrite]
  // .claude stays denyWrite as a whole; skills are carved back in (the more specific path
  // wins, same as allowRead inside denyRead). Mirrors the guard's file-tool carve-out:
  // skills execute through sandboxed bash under the same rules, so writing them grants
  // nothing the writable workspace doesn't already. settings/policy files stay denied.
  const allowWrite = ['./.claude/skills']

  // Sandbox on, egress routed to the deny-all proxy, escape hatch closed, crown jewels +
  // the broker's dir unreadable, and this launch config itself unwritable to sandboxed
  // bash (denyWrite — the guard hook only covers file tools). The guard hook is loaded
  // from the PROTECTED install and fails CLOSED: if it errors or is missing, `|| exit 2`
  // blocks the tool call.
  const settings = `{
  "enableAllProjectMcpServers": true,
  "permissions": {
    "defaultMode": "default",
    "allow": [${arr(allow)}],
    "deny": [
      "WebFetch", "WebSearch",
      "mcp__claude_ai_Gmail", "mcp__claude_ai_Google_Calendar", "mcp__claude_ai_Google_Drive"
    ]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "node \\"${app}/guard.mjs\\" || exit 2" }]
      }
    ]
  },
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "autoAllowBashIfSandboxed": true,
    "allowUnsandboxedCommands": false,
    "excludedCommands": [],
    "network": { "allowedDomains": [], "httpProxyPort": ${cfg.proxyPort}, "socksProxyPort": ${cfg.proxyPort + 1} },
    "filesystem": {
      "denyRead": [${arr(denyRead)}],
      "allowRead": [${arr(allowRead)}],
      "denyWrite": [${arr(denyWrite)}],
      "allowWrite": [${arr(allowWrite)}]
    }
  }
}
`

  // File-tool side of the same policy, read by guard.mjs (the sandbox lists above only
  // bind BASH). Holds the profile's read fence + the user's extra deny/allow paths; the
  // workspace carve-out itself is derived by the guard from CLAUDE_PROJECT_DIR at call
  // time, keeping this file identical across workspaces sharing a config shape.
  const policy = `{
  "profile": ${JSON.stringify(cfg.profile)},
  "readScope": ${JSON.stringify(readScope)},
  "denyRead": [${arr(cfg.paths.denyRead)}],
  "denyWrite": [${arr(cfg.paths.denyWrite)}],
  "allowRead": [${arr(cfg.paths.allowRead)}]
}
`

  const local = `{
  "enabledMcpjsonServers": ["broker"]
}
`

  // Everything the broker needs is stamped here — nothing depends on launch-time env,
  // so the broker's ports/relay/exposure can never drift from the sandbox settings.
  const mcp = `{
  "mcpServers": {
    "broker": {
      "command": "node",
      "args": [${JSON.stringify(join(app, 'broker.mjs'))}],
      "env": {
        "ESCAPE_CLAUSE_RELAY": ${JSON.stringify(cfg.relay)},
        "ESCAPE_CLAUSE_UI_PORT": ${JSON.stringify(String(cfg.ui.port))},
        "ESCAPE_CLAUSE_UI_URL": ${JSON.stringify(cfg.ui.url)},
        "ESCAPE_CLAUSE_EXPOSE": ${JSON.stringify(cfg.ui.expose)},
        "ESCAPE_CLAUSE_PROXY_PORT": ${JSON.stringify(String(cfg.proxyPort))}
      }
    }
  }
}
`

  return {
    '.claude/settings.json': settings,
    '.claude/settings.local.json': local,
    '.claude/escape-clause-policy.json': policy,
    '.mcp.json': mcp,
  }
}

export function stampWorkspace(ws, cfg) {
  const files = buildStamp(cfg)
  // skills is pre-created so the agent can drop files straight in — it's the one
  // subdirectory of .claude open to the agent (guard carve-out + sandbox allowWrite)
  mkdirSync(join(ws, '.claude', 'skills'), { recursive: true })
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(ws, rel), content)
  if (!existsSync(join(ws, 'CLAUDE.md'))) {
    for (const src of [join(APP, 'CLAUDE.md'), join(SELF_DIR, 'templates', 'CLAUDE.md')])
      if (existsSync(src)) { copyFileSync(src, join(ws, 'CLAUDE.md')); break }
  }
  return Object.keys(files)
}

// ---------------------------------------------------------------- verify
// Regenerate from the config; compare bytes; on mismatch, NAME the differing setting.
// Hard refusal stays with the caller — this never rewrites anything.

function* diffPaths(want, got, prefix = '') {
  if (JSON.stringify(want) === JSON.stringify(got)) return
  const bothObj = want && got && typeof want === 'object' && typeof got === 'object' &&
    Array.isArray(want) === Array.isArray(got) && !Array.isArray(want)
  if (!bothObj) { yield { path: prefix || '(root)', want, got }; return }
  for (const k of new Set([...Object.keys(want), ...Object.keys(got)]))
    yield* diffPaths(want[k], got[k], prefix ? `${prefix}.${k}` : k)
}

export function verifyWorkspace(ws, cfg) {
  const problems = []
  for (const [rel, want] of Object.entries(buildStamp(cfg))) {
    const onDisk = (() => { try { return readFileSync(join(ws, rel), 'utf8') } catch { return null } })()
    if (onDisk === want) continue
    if (onDisk === null) { problems.push(`  ${rel} is missing`); continue }
    const a = (() => { try { return JSON.parse(want) } catch { return null } })()
    const b = (() => { try { return JSON.parse(onDisk) } catch { return null } })()
    if (a && b) {
      const diffs = [...diffPaths(a, b)].slice(0, 3)
      for (const d of diffs)
        problems.push(`  ${rel} drifted at ${d.path}:\n    config would write: ${JSON.stringify(d.want)}\n    the stamp has:      ${JSON.stringify(d.got)}`)
      if (diffs.length === 0) problems.push(`  ${rel} differs only in formatting — re-stamp to normalize`)
    } else {
      problems.push(`  ${rel} is not valid JSON — likely tampering`)
    }
  }
  return problems
}

// ---------------------------------------------------------------- wizard

async function wizard(cfg, { fresh }) {
  try { return await wizardQuestions(cfg, { fresh }) }
  catch { die('setup interrupted — nothing was saved') }
}

async function wizardQuestions(cfg, { fresh }) {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  const ask = async (q, def) => (await rl.question(q)).trim() || def
  process.stderr.write(`\nWorkspace: ${cfg.workspace}  (${fresh ? 'new' : 'reconfiguring'})\n\n`)

  const profDef = fresh ? '2' : String(PROFILES.indexOf(cfg.profile) + 1)
  process.stderr.write(`1. How much of your machine should the agent see?
     1) default   - credentials (~/.ssh, ~/.aws, ...) hidden; rest of ~ visible
     2) strict    - everything under ~ hidden except this workspace   (recommended)
     3) paranoid  - workspace + system toolchain only
`)
  const p = await ask(`   choice [${profDef}]: `, profDef)
  cfg.profile = PROFILES[Number(p) - 1] || cfg.profile

  const expDef = !fresh && cfg.ui.url ? '2' : !fresh && cfg.ui.expose === 'tailscale' ? '3'
    : !fresh && cfg.ui.expose ? '4' : '1'
  process.stderr.write(`
2. How will you open approval links?
     1) this machine only - links point at http://127.0.0.1:${cfg.ui.port}
     2) I have my own URL - you run the tunnel/reverse proxy; paste its address
     3) tailscale         - built-in provider: tailscale serve --bg ${cfg.ui.port}
     4) custom script     - your own provider in ${join(BASE, 'expose')}/
`)
  const x = await ask(`   choice [${expDef}]: `, expDef)
  cfg.ui.url = ''; cfg.ui.expose = ''
  if (x === '2') cfg.ui.url = await ask('   URL: ', '')
  if (x === '3') {
    cfg.ui.expose = 'tailscale'
    const st = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8' })
    const dns = st.status === 0 ? (readJsonStr(st.stdout)?.Self?.DNSName || '').replace(/\.$/, '') : ''
    process.stderr.write(dns ? `   checked: tailscale is up, this machine is ${dns}\n   approval links will use https://${dns}\n`
      : `   note: could not confirm tailscale is up — the broker will run the provider at launch\n`)
  }
  if (x === '4') cfg.ui.expose = 'script:' + await ask(`   script name (a file in ${join(BASE, 'expose')}): `, '')

  const chanDef = cfg.channels.specs.length ? 'y' : 'n'
  const c = (await ask(`\n3. Connect a chat channel (Telegram, Discord, fakechat, ...)? [${chanDef === 'y' ? 'Y/n' : 'y/N'}] `, chanDef)).toLowerCase()
  if (c.startsWith('y')) {
    const specs = await ask(`   channel spec(s), space-separated [${cfg.channels.specs.join(' ') || 'plugin:fakechat@claude-plugins-official'}]: `,
      cfg.channels.specs.join(' ') || 'plugin:fakechat@claude-plugins-official')
    const tools = await ask(`   reply tool permission(s), comma-separated [${cfg.channels.tools.join(',') || 'mcp__plugin_fakechat_fakechat'}]: `,
      cfg.channels.tools.join(',') || 'mcp__plugin_fakechat_fakechat')
    cfg.channels.specs = specs.split(/\s+/).filter(Boolean)
    cfg.channels.tools = splitList(tools)
  } else { cfg.channels.specs = []; cfg.channels.tools = [] }

  const r = await ask(`\n4. Permission relay for unlisted tools:  deny (recommended) / forward / off  [${cfg.relay}]: `, cfg.relay)
  cfg.relay = r
  rl.close()
  return cfg
}

const readJsonStr = (s) => { try { return JSON.parse(s) } catch { return null } }

// ---------------------------------------------------------------- pre-flight (init)

function preflight() {
  const major = Number(process.version.slice(1).split('.')[0])
  if (major < 20) note(`warning: node ${process.version} — Escape Clause needs node 20+`)
  const claude = spawnSync('claude', ['--version'], { encoding: 'utf8' })
  if (claude.error) note(`warning: 'claude' not found on PATH — install Claude Code before launching`)
  if (!existsSync(join(APP, 'broker.mjs')))
    note(`warning: broker not installed at ${APP} — run: ./escape-clause.sh install`)
}

// ---------------------------------------------------------------- CLI

const CONFIG_FLAGS = ['--profile', '--relay', '--url', '--expose', '--ui-port', '--proxy-port',
  '--channels', '--channel-tools', '--deny-read', '--deny-write', '--allow-read']

function parseFlags(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--defaults' || a === '--reconfigure') { flags[a] = true; continue }
    if (a === '--name' || CONFIG_FLAGS.includes(a)) {
      if (i + 1 >= argv.length) die(`${a} needs a value`)
      flags[a] = argv[++i]; continue
    }
    die(`unknown flag: ${a}`)
  }
  return flags
}

function applyFlags(cfg, f) {
  if (f['--profile']) cfg.profile = f['--profile']
  if (f['--relay']) cfg.relay = f['--relay']
  if (f['--url']) { cfg.ui.url = f['--url']; cfg.ui.expose = '' }
  if (f['--expose']) { cfg.ui.expose = f['--expose']; cfg.ui.url = '' }
  if (f['--ui-port']) cfg.ui.port = Number(f['--ui-port'])
  if (f['--proxy-port']) cfg.proxyPort = Number(f['--proxy-port'])
  if (f['--channels']) cfg.channels.specs = f['--channels'].split(/[\s,]+/).filter(Boolean)
  if (f['--channel-tools']) cfg.channels.tools = splitList(f['--channel-tools'])
  if (f['--deny-read']) cfg.paths.denyRead = splitList(f['--deny-read'])
  if (f['--deny-write']) cfg.paths.denyWrite = splitList(f['--deny-write'])
  if (f['--allow-read']) cfg.paths.allowRead = splitList(f['--allow-read'])
  return cfg
}

function resolveWs(dir, { mustExist }) {
  const abs = resolve(dir)
  if (mustExist && !existsSync(abs)) die(`no such directory: ${abs}`)
  mkdirSync(abs, { recursive: true })
  const ws = realpathSync(abs)
  checkWs(ws)
  return ws
}

async function cmdInit(argv) {
  const dir = argv[0]
  if (!dir || dir.startsWith('--')) die('usage: escape-clause init <dir> [--profile default|strict|paranoid] [--url U | --expose tailscale|script:NAME] [--channels SPECS --channel-tools LIST] [--relay deny|forward|off] [--defaults] [--reconfigure] [--name N]')
  const flags = parseFlags(argv.slice(1))
  const ws = resolveWs(dir, { mustExist: false })
  preflight()

  const shims = setShims()
  let { name, cfg } = loadConfigFor(ws)
  const fresh = !cfg
  if (fresh) {
    cfg = defaultConfig(ws)
    if (shims.length) {
      applyEnvShims(cfg)
      note(`note: ${shims.join(', ')} — env configuration is deprecated; the values are being saved to the config file, which is authoritative from now on.`)
    }
  } else if (shims.length) {
    note(`note: ${shims.join(', ')} ignored — this workspace's config file is authoritative (re-run with --reconfigure or edit it to change settings).`)
  }
  applyFlags(cfg, flags)

  const flagged = CONFIG_FLAGS.some((k) => flags[k]) || flags['--defaults']
  const interactive = process.stdin.isTTY && process.stderr.isTTY && !flagged && shims.length === 0
  if (interactive && (fresh || flags['--reconfigure'])) cfg = await wizard(cfg, { fresh })

  validateConfig(cfg)
  name = name || allocateName(ws, flags['--name'])
  saveConfig(name, cfg)
  const written = stampWorkspace(ws, cfg)

  note(`
Saved ${configPath(name)} — plain JSON, edit any time, then re-run 'escape-clause init ${ws}' to re-stamp.

initialized ${ws} — wrote (plain JSON, read them):
${written.map((f) => `  ${f}`).join('\n')}
  CLAUDE.md   (only if it was missing)

directory profile: ${cfg.profile}   relay: ${cfg.relay}   ui: ${cfg.ui.url || cfg.ui.expose || `http://127.0.0.1:${cfg.ui.port}`}

Launch with: escape-clause launch ${ws}`)
}

function requireVerified(dir) {
  const ws = resolveWs(dir, { mustExist: true })
  const { name, cfg } = loadConfigFor(ws)
  if (!name) {
    if (existsSync(join(ws, '.claude/settings.json')))
      die(`${ws} is stamped but has no config file (pre-config-era workspace).\nMigrate it: escape-clause init ${ws}   (your ESCAPE_CLAUSE_* env, if set, seeds the config)`)
    die(`${ws} is not an initialized workspace — run: escape-clause init ${ws}`)
  }
  if (!cfg) die(`${ws} is registered but its config file is missing or unreadable (${configPath(name)}).\nRecreate it: escape-clause init ${ws} --reconfigure`)
  validateConfig(cfg)
  const problems = verifyWorkspace(ws, cfg)
  if (problems.length) {
    process.stderr.write(`error: workspace stamp doesn't match its config (${configPath(name)})\n\n${problems.join('\n')}\n\n  Likely an edit to the config that was never re-stamped — or tampering. Inspect, then:\n  fix: escape-clause init ${ws}   (re-stamps from the config)\n`)
    process.exit(1)
  }
  return { ws, name, cfg }
}

function cmdVerify(argv) {
  const { ws, name } = requireVerified(argv[0] || process.cwd())
  note(`${ws}: stamp verified against ${configPath(name)}`)
}

function cmdLaunchInfo(argv) {
  const shims = setShims()
  if (shims.length)
    note(`note: ${shims.join(', ')} ignored — the workspace's config file is authoritative.`)
  const { ws, name, cfg } = requireVerified(argv[0] || process.cwd())
  const specs = cfg.channels.specs
  const cmd = `claude${specs.length ? ` --channels ${specs.join(' ')}` : ''} --dangerously-load-development-channels server:broker`
  const uiDesc = cfg.ui.url ? cfg.ui.url
    : cfg.ui.expose ? `http://127.0.0.1:${cfg.ui.port} (links switch to the '${cfg.ui.expose}' provider's URL once it's up)`
    : `http://127.0.0.1:${cfg.ui.port}`
  note(`workspace:   ${ws}  (stamp verified against ${configPath(name)})
profile:     ${cfg.profile}  (directory access — docs/directory-access.md)
relay:       ${cfg.relay}${specs.length ? `\nchannels:    ${specs.join(' ')}` : ''}
approval UI: ${uiDesc}  — password in ${join(BASE, 'secrets', 'password')}

Talk to the agent right here in this terminal, from claude.ai or the Claude app
(run /remote-control inside the session), or over a chat channel (edit the config's
"channels" or re-run init --reconfigure). Chatting remotely? The UI binds to
localhost only — set ui.url or ui.expose in the config so links reach your device.

Launching claude — this is the entire command, run it yourself any time:

  cd ${ws}
  ${cmd}
`)
  process.stdout.write(cmd + '\n')
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd === 'init') await cmdInit(rest)
  else if (cmd === 'verify') cmdVerify(rest)
  else if (cmd === 'launch-info') cmdLaunchInfo(rest)
  else die(`usage: setup.mjs init|verify|launch-info <dir> [flags]`)
}
