// The WebSocket behind the app window and the phones (see index.js): the origin
// and token checks on the upgrade, and the request table each message is sent to.
import { WebSocketServer } from 'ws'
import { sameToken } from './remote.js'

const DEV_ORIGINS = ['http://127.0.0.1:5173', 'http://localhost:5173']

// Actions that happen on the PC itself (dialogs, windows, the PC's browser) or
// change remote access; a phone gets an explanation instead. Build-and-restart
// is allowed on both listeners; it uses the same authenticated RPC and restarter.
const PC_ONLY = new Set([
  'workspace.pick', 'folder.pick', 'workspace.open', 'file.open', 'system.openUrl', 'chatgpt.login',
  'codex.login', 'codex.cancel', 'codex.logout', 'chatgpt.logout',
  'remote.set', 'remote.rotate', 'remote.recheck', 'remote.allowFirewall', 'updates.installApp',
])

/** The socket server; `clients` and `handlers` are index.js's, `dev` is the dev-mode flag. */
export function createSocketServer({ dev, clients, handlers, fullState, terminals, broadcastRemote, scheduleIdleExit, cancelIdleExit, isShuttingDown, log = () => {} }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 })

  function handleUpgrade(req, socket, head, ctx) {
    try {
      let url
      try {
        url = new URL(req.url ?? '/', `http://127.0.0.1:${ctx.port}`)
      } catch {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      const origin = (req.headers.origin ?? '').toLowerCase()
      const host = (req.headers.host ?? '').toLowerCase()
      let sameSite
      if (ctx.remote) {
        sameSite = ctx.hostOk(host) && origin === `http://${host}`
      } else {
        const origins = [`http://127.0.0.1:${ctx.port}`, `http://localhost:${ctx.port}`, ...(dev ? DEV_ORIGINS : [])]
        sameSite = origins.includes(origin) && (ctx.hostOk(host) || (dev && /^(127\.0\.0\.1|localhost):5173$/.test(host)))
      }
      if (url.pathname !== '/ws' || !sameToken(url.searchParams.get('t'), ctx.token) || !sameSite) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, { remote: ctx.remote }))
    } catch (error) {
      try { log('WebSocket upgrade failed:', error instanceof Error ? error.message : String(error)) } catch {}
      try { socket.destroy() } catch {}
    }
  }

  wss.on('connection', async (ws, client) => {
    // ws closes a peer on protocol/payload errors, but also emits 'error'.
    // Without a listener one bad connection terminates the entire server.
    ws.on('error', () => {})
    client.socket = ws
    clients.set(ws, client)
    cancelIdleExit()
    if (client.remote) broadcastRemote()
    ws.on('close', () => {
      clients.delete(ws)
      terminals.dropClient(client)
      if (client.remote) broadcastRemote()
      scheduleIdleExit()
    })
    ws.on('message', async (raw) => {
      let message
      try {
        message = JSON.parse(String(raw))
      } catch {
        return
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return
      const { id, type, ...params } = message
      if (!Number.isSafeInteger(id) || typeof type !== 'string') return
      // Delivery may finish after the browser disconnects. Its durable receipt,
      // not a successful socket.send, determines whether retrying is safe.
      const reply = (frame) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ id, ...frame }))
      }
      try {
        if (isShuttingDown()) throw new Error('アプリを終了しています')
        const handler = Object.hasOwn(handlers, type) ? handlers[type] : null
        if (!handler) throw new Error(`unknown request: ${type}`)
        if (client.remote && PC_ONLY.has(type)) throw new Error('この操作は PC の Agent Desk で行ってください')
        const result = await handler(params, client)
        reply({ ok: true, result: result ?? null })
      } catch (error) {
        reply({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    })
    try {
      const state = await fullState(client)
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ event: 'hello', state }))
    } catch (error) {
      log('initial state failed:', error.message)
      ws.close(1011, 'initial state unavailable')
    }
  })

  return { handleUpgrade }
}
