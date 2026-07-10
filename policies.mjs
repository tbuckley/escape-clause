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
import { DIR, POLICY_DIR, sha256, audit } from './store.mjs'

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
    // ESCAPE_CLAUSE_DIR is the broker's own resolved store path (not agent input) — lets
    // scripts find broker-published facts like viewer-ports without hardcoding $HOME.
    { cwd, timeout, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin', HOME: process.env.HOME || '', ESCAPE_CLAUSE_DIR: DIR } },
    (e, out, err) => res({ exitCode: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: String(out), stderr: String(err || (e && !out ? e.message : '')) })))
}

// Seed policies. Each missing name is (re)seeded at broker start, so upgrades deliver
// new seeds to existing stores; an already-installed name is never touched (updates to
// an existing policy always go through a reviewed registration ticket).
const SEEDS = [
  {
    name: 'host-info', class: 'readonly',
    description: 'Read-only host status: uname, root disk usage, uptime. No args.',
    script: '#!/bin/sh\nuname -a\ndf -h /\nuptime\n',
  },
  {
    name: 'fetch-url', class: 'public-write',
    description: 'HTTP GET a URL from the host. Network egress is a potential exfil channel, so every run is human-reviewed. Args: <url>.',
    script: '#!/bin/sh\n[ -n "$1" ] || { echo "usage: fetch-url <url>" >&2; exit 2; }\nexec curl -sS --max-time 10 "$1"\n',
  },
  {
    // Why this is safe to auto-run (private-write) when a raw `tailscale serve` would
    // not be: the script refuses every port except the broker's own VIEWER listeners
    // (read from the protected store, never from arguments), so what goes on the
    // tailnet is always a page stamped with the viewer's Connection-Allowlist/CSP set.
    // Serving any other port would bypass those headers (raw app port) or let the
    // agent shadow the approval UI's :443 mapping with its own page; both stay
    // impossible by construction. The audience is only ever the user's own tailnet —
    // this script never touches `tailscale funnel` (public internet), and args go
    // through execve, never a shell.
    name: 'tailscale-serve', class: 'private-write',
    description: 'Expose a hardened VIEWER port on the tailnet (or stop exposing it). ' +
      'Args: `on <viewer-port>` serves https://<machine>.<tailnet>.ts.net:<viewer-port>; `off <viewer-port>` stops it; `status` lists current serves. ' +
      'Only broker-published viewer ports (~/.escape-clause/viewer-ports) are accepted — never app ports, the approval UI, or funnel.',
    script: `#!/bin/sh
# Serve/stop a hardened viewer port on the tailnet — never any other port.
cmd="$1"; port="$2"
[ "$cmd" = status ] && exec tailscale serve status
case "$cmd" in on|off) ;; *) echo "usage: on <viewer-port> | off <viewer-port> | status" >&2; exit 2 ;; esac
allowed="\${ESCAPE_CLAUSE_DIR:-$HOME/.escape-clause}/viewer-ports"
grep -qx "$port" "$allowed" 2>/dev/null || {
  echo "refused: '$port' is not a broker viewer port (allowed: $(tr '\\n' ' ' < "$allowed" 2>/dev/null || echo 'none — is the broker running?'))" >&2
  exit 3
}
if [ "$cmd" = on ]; then
  exec tailscale serve --bg --https="$port" "localhost:$port"   # prints the tailnet URL
else
  exec tailscale serve --https="$port" off
fi
`,
  },
]
export function seedPolicies() {
  for (const p of SEEDS) if (!getPolicy(p.name)) installPolicy(p)
}
