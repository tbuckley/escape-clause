// Exposure providers — how a URL that reaches the loopback-only approval UI comes to
// exist (docs/setup-simplification.md §3). The UI itself NEVER binds beyond 127.0.0.1;
// a provider only arranges transport and reports the public URL for ticket links.
//
// One narrow contract covers tailscale-alikes, tunnel daemons, and whatever comes next:
//   - the broker starts the provider with the UI port (argv[1] + ESCAPE_CLAUSE_UI_PORT)
//   - the provider prints the public URL as its FIRST line of stdout
//   - then it either exits 0 (tunnel managed elsewhere — `tailscale serve --bg` style)
//     or stays resident for the life of the tunnel (`cloudflared`, `ssh -R` style);
//     resident providers are supervised: restarted on crash, killed on broker exit.
//
// Providers run on the HOST, so they live in the protected store (~/.escape-clause/
// expose/<name>) — the same trust domain as the broker code itself. The agent can
// neither write a provider script nor the config line that names one.
import { execFile, spawn } from 'node:child_process'
import { join } from 'node:path'
import { DIR } from './store.mjs'

const NAME_RE = /^[A-Za-z0-9._-]+$/
const URL_TIMEOUT_MS = 15_000
const RESTART_DELAY_MS = 5_000

// mode: 'tailscale' | 'script:<name>'. onUrl fires when (and each time) a provider
// reports the public URL; the caller swaps ticket links over to it.
export function startExpose({ mode, port, log, onUrl }) {
  if (mode === 'tailscale') return tailscale({ port, log, onUrl })
  const m = /^script:(.+)$/.exec(mode)
  if (m && NAME_RE.test(m[1])) return script({ name: m[1], port, log, onUrl })
  log(`expose: unknown provider '${mode}' — links stay on 127.0.0.1`)
}

function tailscale({ port, log, onUrl }) {
  execFile('tailscale', ['serve', '--bg', String(port)], (err) => {
    if (err) return log(`expose: tailscale serve failed (${err.message}) — links stay on 127.0.0.1`)
    execFile('tailscale', ['status', '--json'], (err2, out) => {
      let dns = ''
      try { dns = (JSON.parse(out).Self?.DNSName || '').replace(/\.$/, '') } catch {}
      if (err2 || !dns) return log(`expose: tailscale serve is up but the tailnet name is unknown — links stay on 127.0.0.1`)
      onUrl(`https://${dns}`)
    })
  })
}

function script({ name, port, log, onUrl }) {
  const path = join(DIR, 'expose', name)
  let stopping = false
  const run = () => {
    const child = spawn(path, [String(port)], {
      env: { ...process.env, ESCAPE_CLAUSE_UI_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buf = '', got = false
    const timer = setTimeout(() => {
      if (!got) log(`expose: ${name} printed no URL within ${URL_TIMEOUT_MS / 1000}s — links stay on 127.0.0.1`)
    }, URL_TIMEOUT_MS)
    child.stdout.on('data', (d) => {
      if (got) return
      buf += d
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      got = true; clearTimeout(timer)
      const url = buf.slice(0, nl).trim()
      if (/^https?:\/\//.test(url)) onUrl(url)
      else log(`expose: ${name} printed '${url}' — not a URL, links stay on 127.0.0.1`)
    })
    child.stderr.on('data', (d) => log(`expose[${name}]: ${String(d).trimEnd()}`))
    child.on('error', (err) => { clearTimeout(timer); log(`expose: cannot run ${path} (${err.message})`) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (stopping) return
      // exit 0 after reporting = tunnel managed elsewhere; anything else = resident
      // provider died — supervise it back up.
      if (code === 0 && got) return
      log(`expose: ${name} exited (code ${code}) — restarting in ${RESTART_DELAY_MS / 1000}s`)
      setTimeout(run, RESTART_DELAY_MS).unref()
    })
    process.on('exit', () => { stopping = true; child.kill() })
  }
  run()
}
