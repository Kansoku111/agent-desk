// Remote access over Tailscale: a second listener on this PC's tailnet
// addresses, so a phone signed in to the same tailnet can use the app. It
// never listens on the LAN or the internet, and it has its own lasting token
// (the app window's token changes with every launch).
import { execFile } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { allowFirewall, firewallState } from './firewall.js'
import { readJson, writeJson } from './json-file.js'

export const DEFAULT_REMOTE_PORT = 47131

/** Tailscale gives each device an IPv4 address in 100.64.0.0/10 (CGNAT space). */
export function isTailnetIPv4(address) {
  const parts = String(address).split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false
  const [a, b] = parts.map(Number)
  return a === 100 && b >= 64 && b <= 127
}

/** IPv4 addresses in the tailnet range on this machine's interfaces, with the interface name. */
export function tailnetCandidates(interfaces = os.networkInterfaces()) {
  const found = []
  for (const [name, entries] of Object.entries(interfaces ?? {})) {
    for (const entry of entries ?? []) {
      if ((entry.family !== 'IPv4' && entry.family !== 4) || entry.internal || !isTailnetIPv4(entry.address)) continue
      if (!found.some((other) => other.address === entry.address)) found.push({ name, address: entry.address })
    }
  }
  return found.sort((a, b) => a.address.localeCompare(b.address))
}

/**
 * The addresses to listen on. When the Tailscale CLI answered, only the
 * addresses it reports (another VPN may use the same range); otherwise only
 * interfaces named after Tailscale (Windows "Tailscale", Linux "tailscale0").
 */
export function pickAddresses(candidates, status) {
  if (status?.ips?.length) return candidates.filter((entry) => status.ips.includes(entry.address)).map((entry) => entry.address)
  return candidates.filter((entry) => /tailscale/i.test(entry.name)).map((entry) => entry.address)
}

export function parseTailscaleStatus(json) {
  const self = json?.Self ?? {}
  const dnsName = String(self.DNSName ?? '').replace(/\.$/, '').toLowerCase() || null
  // The other devices on the tailnet: a phone has to be among them (and online) to connect.
  const peers = Object.values(json?.Peer ?? {})
    .map((peer) => ({ name: String(peer?.HostName ?? '') || '?', os: String(peer?.OS ?? ''), online: peer?.Online === true }))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
  return {
    running: json?.BackendState === 'Running',
    ips: (Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : []).filter(isTailnetIPv4),
    dnsName,
    peers,
    login: json?.User?.[self.UserID]?.LoginName ?? null,
  }
}

function tailscaleCommands() {
  if (process.platform === 'win32') {
    return [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe'), 'tailscale']
  }
  if (process.platform === 'darwin') return ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', 'tailscale']
  return ['tailscale']
}

/** `tailscale status --json`, reduced to what remote access needs; null when there is no CLI. */
export async function tailscaleStatus() {
  for (const command of tailscaleCommands()) {
    const stdout = await new Promise((resolve) => {
      execFile(command, ['status', '--json'], { timeout: 5000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (error, out) => {
        // A stopped or logged-out Tailscale still prints its status, with a non-zero exit.
        resolve(out || (error ? null : ''))
      })
    })
    if (!stdout) continue
    try {
      return parseTailscaleStatus(JSON.parse(stdout))
    } catch {}
  }
  return null
}

/** Constant-time token comparison. */
export function sameToken(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

const LISTEN_ERRORS = {
  EADDRINUSE: (port) => `ポート ${port} を別のアプリが使っています`,
  EACCES: (port) => `ポート ${port} で待ち受ける権限がありません`,
}

export class RemoteAccess extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.file  where the token is kept
   * @param {number} options.port
   * @param {(req, res, ctx) => void} options.onRequest
   * @param {(req, socket, head, ctx) => void} options.onUpgrade
   * @param {() => Promise<string[]>} [options.addresses]  replaces Tailscale discovery (tests)
   * @param {{ check: Function, allow: Function }} [options.firewall]  Windows Firewall (server/firewall.js)
   */
  constructor({
    file, port = DEFAULT_REMOTE_PORT, onRequest, onUpgrade, log = () => {},
    status = tailscaleStatus, interfaces = () => os.networkInterfaces(), addresses = null, pollMs = 15_000,
    firewall = { check: firewallState, allow: allowFirewall },
  }) {
    super()
    this.file = file
    this.port = port
    this.onRequest = onRequest
    this.onUpgrade = onUpgrade
    this.log = log
    this.readStatus = status
    this.readInterfaces = interfaces
    this.findAddresses = addresses ?? (() => this.#discover())
    this.pollMs = pollMs
    this.token = null
    this.enabled = false
    this.listeners = new Map()
    this.status = null
    this.statusKey = null
    this.phase = 'off'
    this.error = null
    this.qrSvg = null
    this.qrFor = null
    this.timer = null
    this.refreshing = null
    this.firewallApi = firewall
    // 'allowed' | 'blocked' | 'denied' | null (unknown or not Windows), for the address in firewallFor.
    this.firewall = null
    this.firewallFor = null
    this.firewallChecking = null
  }

  async load() {
    const saved = await readJson(this.file, {})
    this.token = typeof saved?.token === 'string' && /^[a-f0-9]{48}$/.test(saved.token) ? saved.token : null
    return this
  }

  async start() {
    if (!this.token) await this.rotate()
    this.enabled = true
    clearInterval(this.timer)
    this.timer = setInterval(() => void this.refresh(), this.pollMs)
    this.timer.unref?.()
    await this.refresh()
  }

  async stop() {
    this.enabled = false
    clearInterval(this.timer)
    this.timer = null
    if (this.refreshing) await this.refreshing.catch(() => {})
    for (const address of [...this.listeners.keys()]) this.#close(address)
    this.status = null
    this.statusKey = null
    this.error = null
    this.phase = 'off'
    this.firewall = null
    this.firewallFor = null
    this.emit('state', this.snapshot())
  }

  /** A new token; links and devices that used the old one stop working. */
  async rotate() {
    const token = randomBytes(24).toString('hex')
    // Saved before it replaces the token in use: a failed save must not revoke the old link or leave an unsaved one.
    await writeJson(this.file, { token })
    this.token = token
    this.emit('token')
    await this.#updateQr()
    this.emit('state', this.snapshot())
  }

  /** Asks Tailscale (and the firewall) again: after it was installed or signed in, or a phone joined. */
  async recheck() {
    // A refresh already running may have read Tailscale before the change: let it finish, then read again.
    await this.refreshing
    this.statusKey = null
    this.firewallFor = null
    await this.refresh()
    await this.firewallChecking
  }

  /** Lets phones through the Windows Firewall (Windows asks for an admin's OK). Resolves to an error or null. */
  async allowFirewall() {
    const [address] = this.addresses()
    if (!address) return 'スマホ用の待ち受けが始まっていません'
    const error = await this.firewallApi.allow({ port: this.port, address })
    this.firewallFor = null
    await this.#checkFirewall()
    return error
  }

  #checkFirewall() {
    const [address] = this.addresses()
    if (!address || address === this.firewallFor) return this.firewallChecking ?? Promise.resolve()
    this.firewallFor = address
    const checking = Promise.resolve()
      .then(() => this.firewallApi.check({ port: this.port, address }))
      .catch(() => null)
      .then((state) => {
        if (this.firewallChecking === checking) this.firewallChecking = null
        if (this.firewallFor !== address || !this.enabled || state === this.firewall) return
        this.firewall = state
        this.emit('state', this.snapshot())
      })
    this.firewallChecking = checking
    return checking
  }

  refresh() {
    if (!this.enabled) return Promise.resolve()
    this.refreshing ??= this.#refresh()
      .catch((error) => this.log('remote access:', error.message))
      .finally(() => {
        this.refreshing = null
      })
    return this.refreshing
  }

  async #discover() {
    const candidates = tailnetCandidates(this.readInterfaces())
    // Retry a missing CLI result; otherwise ask again only when interfaces change.
    const key = JSON.stringify(candidates)
    if (key !== this.statusKey) {
      this.status = await this.readStatus()
      if (this.status !== null) this.statusKey = key
    }
    return pickAddresses(candidates, this.status)
  }

  async #refresh() {
    const wanted = await this.findAddresses()
    if (!this.enabled) return
    for (const address of [...this.listeners.keys()]) if (!wanted.includes(address)) this.#close(address)
    let error = null
    for (const address of wanted) {
      if (this.listeners.has(address)) continue
      const opened = await this.#open(address)
      if (!this.enabled) {
        opened.server?.close()
        return
      }
      if (opened.server) {
        this.listeners.set(address, opened.server)
        this.log(`remote access: listening on ${address}:${this.port}`)
      } else {
        error = LISTEN_ERRORS[opened.error.code]?.(this.port) ?? `待ち受けを開始できませんでした（${opened.error.code ?? opened.error.message}）`
      }
    }
    const phase = this.listeners.size > 0 ? 'listening' : error ? 'error' : this.status && !this.status.running ? 'stopped' : 'no-tailscale'
    const changed = phase !== this.phase || error !== this.error
    this.phase = phase
    this.error = this.listeners.size > 0 ? null : error
    if (await this.#updateQr() || changed) this.emit('state', this.snapshot())
    // In the background: PowerShell takes a few seconds.
    void this.#checkFirewall()
  }

  #open(address, attempt = 1) {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        const fail = (error) => {
          try { this.log('remote request failed:', error instanceof Error ? error.message : String(error)) } catch {}
          try {
            if (res.headersSent) res.destroy()
            else {
              res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
              res.end('internal server error')
            }
          } catch {
            try { res.destroy() } catch {}
          }
        }
        try {
          Promise.resolve(this.onRequest(req, res, this.context())).catch(fail)
        } catch (error) {
          fail(error)
        }
      })
      server.on('upgrade', (req, socket, head) => {
        const fail = (error) => {
          try { this.log('remote upgrade failed:', error instanceof Error ? error.message : String(error)) } catch {}
          try { socket.destroy() } catch {}
        }
        try {
          Promise.resolve(this.onUpgrade(req, socket, head, this.context())).catch(fail)
        } catch (error) {
          fail(error)
        }
      })
      server.once('error', (error) => {
        // A restarting instance may still hold the port for a moment.
        if (error.code === 'EADDRINUSE' && attempt < 12) setTimeout(() => resolve(this.#open(address, attempt + 1)), 250)
        else resolve({ error })
      })
      server.listen(this.port, address, () => {
        server.removeAllListeners('error')
        server.on('error', (error) => this.log('remote access:', error.message))
        resolve({ server })
      })
    })
  }

  /**
   * Stops accepting connections at once. Not waiting for the close callback:
   * it only fires once upgraded sockets (phones' WebSockets) end too, which
   * the owner closes itself (and a phone that is asleep may never answer).
   */
  #close(address) {
    const server = this.listeners.get(address)
    this.listeners.delete(address)
    server?.close()
    server?.closeAllConnections?.()
  }

  async #updateQr() {
    const url = this.url()
    if (url === this.qrFor) return false
    this.qrFor = url
    // Loaded when the first link needs a code, not at startup.
    this.qrSvg = url ? await (await import('qrcode')).default.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }) : null
    return true
  }

  /** What a request handler needs to know about a remote connection. */
  context() {
    const hosts = this.hosts()
    return {
      remote: true,
      token: this.token,
      port: this.port,
      hostOk: (host) => hosts.has(String(host ?? '').toLowerCase()),
    }
  }

  /** Host header values a phone may use: the tailnet address or the MagicDNS names. */
  hosts() {
    const names = [...this.listeners.keys()]
    const dnsName = this.status?.dnsName
    if (dnsName) names.push(dnsName, dnsName.split('.')[0])
    return new Set(names.map((name) => `${name}:${this.port}`))
  }

  addresses() {
    return [...this.listeners.keys()].sort()
  }

  url() {
    const [address] = this.addresses()
    return address && this.token ? `http://${address}:${this.port}/?t=${this.token}` : null
  }

  snapshot() {
    return {
      enabled: this.enabled,
      phase: this.phase,
      error: this.error,
      port: this.port,
      addresses: this.addresses(),
      dnsName: this.status?.dnsName ?? null,
      cli: this.status !== null,
      peers: this.status?.peers ?? null,
      login: this.status?.login ?? null,
      firewall: this.firewall,
      url: this.url(),
      qrSvg: this.qrSvg,
    }
  }

  async close() {
    clearInterval(this.timer)
    this.enabled = false
    for (const address of [...this.listeners.keys()]) this.#close(address)
  }
}
