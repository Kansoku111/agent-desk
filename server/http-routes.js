// HTTP requests on both listeners (the app window's and the phones', see
// remote.js): health and quit, the Claude Code hook and team endpoints,
// attachments, and the built UI. index.js wires the handler up.
import fsp from 'node:fs/promises'
import path from 'node:path'
import { webDist } from './paths.js'
import { IMAGE_TYPES as LOCAL_IMAGE_TYPES } from './file-refs.js'
import { sameToken } from './remote.js'

/** A request's body as text; null when it is larger than `limit`. */
async function readBody(req, limit) {
  let body = ''
  req.setEncoding('utf8')
  for await (const chunk of req) {
    body += chunk
    if (body.length > limit) return null
  }
  return body
}

const parseJson = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
}
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
}

function send(res, status, body, type = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'content-type': type, ...SECURITY_HEADERS, ...headers })
  res.end(body)
}

async function serveStatic(res, pathname) {
  let relative
  try {
    relative = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html'
  } catch (error) {
    if (error instanceof URIError) return send(res, 400, 'bad request')
    throw error
  }
  const file = path.resolve(webDist, relative)
  if (!file.startsWith(webDist + path.sep) && file !== webDist) return send(res, 403, 'forbidden')
  try {
    const stat = await fsp.stat(file)
    if (stat.isFile()) {
      const type = CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream'
      const cache = relative.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
      return send(res, 200, await fsp.readFile(file), type, { 'cache-control': cache })
    }
  } catch {}
  try {
    // Single-page app: unknown paths get index.html.
    return send(res, 200, await fsp.readFile(path.join(webDist, 'index.html')), CONTENT_TYPES['.html'], { 'cache-control': 'no-cache' })
  } catch {
    return send(res, 500, 'UI がビルドされていません。`npm run build` を実行してください。')
  }
}

/** Builds the request handler; the managers and state come from index.js. */
export function createRequestHandler({ appVersion, codeStamp, busy, updater, countClients, paths, terminals, teams, shutdown, log = (...args) => console.error(...args) }) {
  /** Serves one request on either listener; `ctx` says which (see localContext and RemoteAccess.context). */
  async function handleRequest(req, res, ctx) {
    try {
      if (!ctx.hostOk(req.headers.host)) return send(res, 421, 'misdirected request')
      let url
      try {
        url = new URL(req.url ?? '/', `http://127.0.0.1:${ctx.port}`)
      } catch {
        return send(res, 400, 'bad request')
      }
      const authorized = sameToken(url.searchParams.get('t'), ctx.token)
      if (url.pathname === '/api/ping' && !ctx.remote) {
        // While dsh is being replaced, a launcher must not swap this server out.
        const status = {
          app: 'agent-desk', version: appVersion, codeStamp, busy: busy() || updater.locked,
          clients: countClients(false), remoteClients: countClients(true),
        }
        return send(res, 200, JSON.stringify(status), 'application/json')
      }
      if (url.pathname === '/api/quit' && !ctx.remote) {
        // A newer launcher asks this instance to make way; never while agents work.
        if (req.method !== 'POST' || !authorized) return send(res, 403, 'forbidden')
        if (busy() || updater.locked) return send(res, 409, 'busy')
        send(res, 200, 'bye')
        setImmediate(() => void shutdown(0))
        return
      }
      // A Claude Code task's hooks (claude-hook.js), authenticated by the secret only that process knows.
      if (url.pathname === '/api/terminal-hook' && !ctx.remote) {
        if (req.method !== 'POST') return send(res, 405, 'method not allowed')
        let body = ''
        req.setEncoding('utf8')
        for await (const chunk of req) {
          body += chunk
          if (body.length > 256 * 1024) return send(res, 413, 'too large')
        }
        let report = null
        try {
          report = JSON.parse(body)
        } catch {}
        const accepted = typeof report?.id === 'string' && terminals.hook(report.id, report.secret, report.event)
        return send(res, accepted ? 204 : 403, '')
      }
      // A team leader's tools (team-mcp.js), authenticated by the team's secret.
      if (url.pathname === '/api/team' && !ctx.remote) {
        if (req.method !== 'POST') return send(res, 405, 'method not allowed')
        const body = await readBody(req, 1024 * 1024)
        if (body === null) return send(res, 413, 'too large')
        const call = parseJson(body)
        try {
          const text = await teams.call(call?.teamId, call?.secret, call?.tool, call?.args)
          return send(res, 200, JSON.stringify({ ok: true, text }), 'application/json')
        } catch (error) {
          if (error.status === 403) return send(res, 403, 'forbidden')
          return send(res, 200, JSON.stringify({ ok: false, error: error.message }), 'application/json')
        }
      }
      // Lets a page tell a token that no longer works (a new link was made) from a server that is down.
      if (url.pathname === '/api/auth') {
        return send(res, authorized ? 200 : 403, authorized ? 'ok' : 'forbidden', 'text/plain; charset=utf-8', { 'cache-control': 'no-store' })
      }
      if (url.pathname.startsWith('/attachments/')) {
        if (!authorized) return send(res, 403, 'forbidden')
        const name = path.basename(url.pathname)
        if (!/^[a-f0-9-]+\.(png|jpg|gif|webp)$/.test(name)) return send(res, 404, 'not found')
        try {
          const ext = path.extname(name).slice(1)
          const type = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
          return send(res, 200, await fsp.readFile(path.join(paths.attachmentsDir, name)), type, { 'cache-control': 'private, max-age=86400' })
        } catch {
          return send(res, 404, 'not found')
        }
      }
      // Images an answer shows (`![](generated-images/cat.png)`), by absolute path.
      if (url.pathname === '/local-image') {
        if (!authorized) return send(res, 403, 'forbidden')
        const file = url.searchParams.get('path') ?? ''
        const type = LOCAL_IMAGE_TYPES[path.extname(file).toLowerCase()]
        if (!type || !path.isAbsolute(file)) return send(res, 404, 'not found')
        try {
          const headers = { 'cache-control': 'private, no-cache' }
          // An SVG may carry script; as an <img> it never runs, opened directly it must not either.
          if (type === 'image/svg+xml') headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
          return send(res, 200, await fsp.readFile(file), type, headers)
        } catch {
          return send(res, 404, 'not found')
        }
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed')
      return await serveStatic(res, url.pathname)
    } catch (error) {
      try {
        log('HTTP request failed:', error instanceof Error ? error.message : String(error))
      } catch {}
      try {
        if (res.headersSent) res.destroy()
        else send(res, 500, 'internal server error')
      } catch {
        try { res.destroy() } catch {}
      }
    }
  }

  return handleRequest
}

/** Listens on the loopback address; when the preferred port stays busy, takes any free port. */
function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(server.address().port)
    })
  })
}

export async function listenWithRetry(server, preferred, attempts) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await listen(server, preferred)
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error
      if (attempt >= attempts) return listen(server, 0)
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}
