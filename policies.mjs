// Named policy scripts. The executable bytes live ONLY in the broker's private store,
// pinned by sha256 — the agent can rewrite a workspace copy all day; the approved bytes
// are what run. Registration/update goes through a human-reviewed ticket (broker.mjs).
//
// Classes decide auto-approval:
//   readonly / private-write  -> auto-approved, executed inline, logged
//   public-write / destructive -> ticket + human review
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { POLICY_DIR, sha256, audit } from './store.mjs'

export const CLASSES = ['readonly', 'private-write', 'public-write', 'destructive']
export const AUTO_CLASSES = new Set(['readonly', 'private-write'])
export const NAME_RE = /^[a-z0-9][a-z0-9-]{1,40}$/

export function getPolicy(name) {
  if (!NAME_RE.test(String(name))) return null
  try { return JSON.parse(readFileSync(join(POLICY_DIR, `${name}.json`), 'utf8')) } catch { return null }
}
export function listPolicies() {
  return readdirSync(POLICY_DIR).filter((f) => f.endsWith('.json'))
    .map((f) => getPolicy(f.slice(0, -5))).filter(Boolean)
}
export function policyScript(name) {
  if (!NAME_RE.test(String(name))) return null
  try { return readFileSync(join(POLICY_DIR, `${name}.script`), 'utf8') } catch { return null }
}

// Called only from an approved policy-registration ticket (or first-run seeding).
export function installPolicy({ name, description, class: cls, script }) {
  writeFileSync(join(POLICY_DIR, `${name}.script`), script, { mode: 0o755 })
  const manifest = { name, description, class: cls, sha256: sha256(script), installedAt: new Date().toISOString() }
  writeFileSync(join(POLICY_DIR, `${name}.json`), JSON.stringify(manifest, null, 2))
  audit('policy_installed', { name, class: cls, sha256: manifest.sha256 })
  return manifest
}

// execve semantics: the stored script is invoked directly with an args array — never a
// shell, never string-interpolated. Env is scrubbed to a minimal set.
export function runPolicy(name, args = [], { cwd = process.cwd(), timeout = 15000 } = {}) {
  const p = getPolicy(name)
  const script = policyScript(name)
  if (!p || script === null) return Promise.resolve({ exitCode: 127, stdout: '', stderr: `unknown policy: ${name}` })
  if (sha256(script) !== p.sha256) {
    return Promise.resolve({ exitCode: 126, stdout: '', stderr: 'policy store corrupt: script does not match pinned hash — refusing to run' })
  }
  return new Promise((res) => execFile(join(POLICY_DIR, `${name}.script`), args.map(String),
    // USER/LOGNAME are identity, not secrets: tools that talk to the OS keychain
    // (e.g. gws via keyring-rs) derive the keychain account from $USER and fall back
    // to a fictional user without it — generating wrong keys and destroying real
    // credentials. See gws-cli/unknown-user incident, 2026-07-25.
    { cwd, timeout, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin', HOME: process.env.HOME || '',
      USER: process.env.USER || '', LOGNAME: process.env.LOGNAME || '' } },
    (e, out, err) => res({ exitCode: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: String(out), stderr: String(err || (e && !out ? e.message : '')) })))
}

// Two seed policies so the demo shows both classes out of the box.
export function seedPolicies() {
  if (listPolicies().length) return
  installPolicy({
    name: 'host-info', class: 'readonly',
    description: 'Read-only host status: uname, root disk usage, uptime. No args.',
    script: '#!/bin/sh\nuname -a\ndf -h /\nuptime\n',
  })
  installPolicy({
    name: 'fetch-url', class: 'public-write',
    description: 'HTTP GET a URL from the host. Network egress is a potential exfil channel, so every run is human-reviewed. Args: <url>.',
    script: '#!/bin/sh\n[ -n "$1" ] || { echo "usage: fetch-url <url>" >&2; exit 2; }\nexec curl -sS --max-time 10 "$1"\n',
  })
}
