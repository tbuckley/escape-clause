// Deny-all sandbox egress proxies (HTTP + SOCKS5).
//
// `.claude/settings.json` points the sandbox at these ports (sandbox.network.httpProxyPort
// and .socksProxyPort), which replaces BOTH of Claude Code's built-in proxies — and with
// them the interactive SandboxNetworkAccess prompt. HTTP(S) clients arrive on the HTTP
// port; non-HTTP protocols (git-ssh via ProxyCommand, ftp, grpc, rsync) arrive on the
// SOCKS port. Here the per-host decision is ours: deny everything, instantly and silently
// (audit-logged). Sandboxed egress fails closed with no terminal dialog; the agent's only
// way out remains the broker.
//
// Fail-closed holds even when these listeners are down (second session, crash): the
// sandbox still routes to the configured ports, and a dead port refuses connections. The
// proxies never execute anything — they only refuse — so unlike the ticket path there is
// no approval surface to protect.
import { createServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'

export function startProxy({ port, socksPort, log, audit }) {
  const deny = (what) => {
    audit('proxy_denied', { target: what })
    log(`PROXY DENY ${what}`)
  }

  const proxy = createServer((req, res) => {
    // plain-HTTP requests (proxy form: GET http://host/path)
    deny(`${req.method} ${req.url}`)
    res.writeHead(403, { 'content-type': 'text/plain' })
    res.end('denied: sandbox egress is deny-all; use the broker for network access\n')
  })

  // HTTPS arrives as CONNECT host:port — refuse the tunnel before any bytes flow.
  proxy.on('connect', (req, socket) => {
    deny(`CONNECT ${req.url}`)
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
  })

  // Same posture as the web UI: if another broker holds the port, its proxy (also
  // deny-all) serves the sandbox; keep this process's MCP side alive.
  proxy.on('error', (e) => log(`deny-all proxy failed to start: ${e.message} (MCP tools still up)`))
  proxy.listen(port, '127.0.0.1', () =>
    log(`deny-all egress proxy on 127.0.0.1:${port} (sandbox.network.httpProxyPort)`))

  // SOCKS5, just enough of RFC 1928 to learn the target for the audit log, then refuse:
  // accept the no-auth greeting (05 00), read the CONNECT request, always answer
  // "connection not allowed by ruleset" (05 02) and close. No tunnel ever opens.
  const socks = createTcpServer((sock) => {
    let stage = 0
    sock.on('error', () => {})
    sock.on('data', (buf) => {
      if (stage === 0 && buf[0] === 0x05) { stage = 1; sock.write(Buffer.from([0x05, 0x00])); return }
      if (stage === 1) {
        deny(`SOCKS ${parseSocksTarget(buf)}`)
        sock.end(Buffer.from([0x05, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        return
      }
      sock.destroy() // not SOCKS5 — drop it
    })
  })
  socks.on('error', (e) => log(`deny-all SOCKS proxy failed to start: ${e.message} (MCP tools still up)`))
  socks.listen(socksPort, '127.0.0.1', () =>
    log(`deny-all SOCKS egress proxy on 127.0.0.1:${socksPort} (sandbox.network.socksProxyPort)`))
  return { proxy, socks }
}

// Best-effort target extraction from a SOCKS5 request (VER CMD RSV ATYP DST.ADDR DST.PORT).
function parseSocksTarget(buf) {
  try {
    const atyp = buf[3]
    if (atyp === 0x01) return `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}:${buf.readUInt16BE(8)}`
    if (atyp === 0x03) { const n = buf[4]; return `${buf.subarray(5, 5 + n)}:${buf.readUInt16BE(5 + n)}` }
    if (atyp === 0x04) return `[ipv6]:${buf.readUInt16BE(20)}`
  } catch {}
  return '(unparsed target)'
}
