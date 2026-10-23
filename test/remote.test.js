import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  RemoteAccess, isTailnetIPv4, parseTailscaleStatus, pickAddresses, sameToken, tailnetCandidates,
} from '../server/remote.js'

test('isTailnetIPv4 accepts only 100.64.0.0/10', () => {
  assert.equal(isTailnetIPv4('100.64.0.1'), true)
  assert.equal(isTailnetIPv4('100.101.7.12'), true)
  assert.equal(isTailnetIPv4('100.127.255.254'), true)
  assert.equal(isTailnetIPv4('100.63.0.1'), false)
  assert.equal(isTailnetIPv4('100.128.0.1'), false)
  assert.equal(isTailnetIPv4('192.168.1.10'), false)
  assert.equal(isTailnetIPv4('127.0.0.1'), false)
  assert.equal(isTailnetIPv4('fd7a:115c:a1e0::1'), false)
  assert.equal(isTailnetIPv4('100.64.0'), false)
})

const interfaces = {
  'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.20', internal: false }],
  Tailscale: [
    { family: 'IPv6', address: 'fd7a:115c:a1e0::1', internal: false },
    { family: 'IPv4', address: '100.101.7.12', internal: false },
  ],
  // Another VPN in the same CGNAT range.
  'Other VPN': [{ family: 'IPv4', address: '100.70.0.5', internal: false }],
}

test('tailnetCandidates lists IPv4 addresses in the tailnet range with their interface', () => {
  assert.deepEqual(tailnetCandidates(interfaces), [
    { name: 'Tailscale', address: '100.101.7.12' },
    { name: 'Other VPN', address: '100.70.0.5' },
  ])
})

test('pickAddresses trusts the CLI, else only interfaces named after Tailscale', () => {
  const candidates = tailnetCandidates(interfaces)
  assert.deepEqual(pickAddresses(candidates, null), ['100.101.7.12'])
  assert.deepEqual(pickAddresses(candidates, { running: true, ips: ['100.70.0.5'], dnsName: null }), ['100.70.0.5'])
  // macOS names the interface utunN; without the CLI nothing is trusted.
  assert.deepEqual(pickAddresses([{ name: 'utun4', address: '100.101.7.12' }], null), [])
})

test('parseTailscaleStatus keeps the state, addresses, MagicDNS name, account and other devices', () => {
  const status = parseTailscaleStatus({
    BackendState: 'Running',
    Self: { DNSName: 'desk-pc.tail1234.ts.net.', TailscaleIPs: ['100.101.7.12', 'fd7a:115c:a1e0::1'], UserID: 42 },
    User: { 42: { LoginName: 'me@example.com' } },
    Peer: {
      'nodekey:a': { HostName: 'old-tablet', OS: 'android', Online: false },
      'nodekey:b': { HostName: 'iPhone', OS: 'iOS', Online: true },
    },
  })
  assert.deepEqual(status, {
    running: true,
    ips: ['100.101.7.12'],
    dnsName: 'desk-pc.tail1234.ts.net',
    peers: [{ name: 'iPhone', os: 'iOS', online: true }, { name: 'old-tablet', os: 'android', online: false }],
    login: 'me@example.com',
  })
  // `tailscale status --json` says "Peer": null when this PC is alone on the tailnet.
  assert.deepEqual(parseTailscaleStatus({ BackendState: 'NeedsLogin', Self: {}, Peer: null }), {
    running: false, ips: [], dnsName: null, peers: [], login: null,
  })
})

test('sameToken compares exactly', () => {
  assert.equal(sameToken('abc', 'abc'), true)
  assert.equal(sameToken('abd', 'abc'), false)
  assert.equal(sameToken('ab', 'abc'), false)
  assert.equal(sameToken(null, 'abc'), false)
  assert.equal(sameToken('', ''), false)
})

// Never runs PowerShell in tests.
const firewall = { check: async () => null, allow: async () => null }

async function freePort() {
  const http = await import('node:http')
  const server = http.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

test('RemoteAccess listens with its own lasting token, and stops', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-remote-'))
  const file = path.join(dir, 'remote.json')
  const port = await freePort()
  const seen = []
  const make = () => new RemoteAccess({
    file,
    port,
    addresses: async () => ['127.0.0.1'],
    firewall,
    onRequest: (req, res, ctx) => {
      seen.push(ctx)
      res.end(ctx.hostOk(req.headers.host) ? 'host-ok' : 'host-bad')
    },
    onUpgrade: (_req, socket) => socket.destroy(),
  })
  const remote = await make().load()
  try {
    assert.equal(remote.snapshot().phase, 'off')
    await remote.start()
    const state = remote.snapshot()
    assert.equal(state.phase, 'listening')
    assert.deepEqual(state.addresses, ['127.0.0.1'])
    assert.match(state.url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/\\?t=[a-f0-9]{48}$`))
    assert.match(state.qrSvg, /^<svg/)
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'host-ok')
    assert.equal(seen.at(-1).remote, true)
    assert.equal(seen.at(-1).token, remote.token)

    // The token survives a restart, so a phone's saved link keeps working.
    const first = remote.token
    await remote.stop()
    assert.equal(remote.snapshot().phase, 'off')
    await assert.rejects(fetch(`http://127.0.0.1:${port}/`))
    const again = await make().load()
    assert.equal(again.token, first)

    // A new link replaces the token and says so.
    let revoked = false
    again.on('token', () => {
      revoked = true
    })
    await again.rotate()
    assert.equal(revoked, true)
    assert.notEqual(again.token, first)
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).token, again.token)
  } finally {
    await remote.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('RemoteAccess reports a missing Tailscale and a busy port', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-remote-'))
  const http = await import('node:http')
  const blocker = http.createServer()
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  const port = blocker.address().port
  const noop = () => {}
  try {
    const missing = await new RemoteAccess({
      file: path.join(dir, 'a.json'), port, onRequest: noop, onUpgrade: noop, firewall,
      interfaces: () => ({ 'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.20', internal: false }] }),
      status: async () => null,
    }).load()
    await missing.start()
    assert.equal(missing.snapshot().phase, 'no-tailscale')
    assert.equal(missing.snapshot().url, null)
    await missing.close()

    const stopped = await new RemoteAccess({
      file: path.join(dir, 'b.json'), port, onRequest: noop, onUpgrade: noop, firewall,
      interfaces: () => ({}),
      status: async () => ({ running: false, ips: [], dnsName: null }),
    }).load()
    await stopped.start()
    assert.equal(stopped.snapshot().phase, 'stopped')
    await stopped.close()

    const busy = await new RemoteAccess({
      file: path.join(dir, 'c.json'), port, onRequest: noop, onUpgrade: noop, firewall,
      addresses: async () => ['127.0.0.1'],
    }).load()
    await busy.start()
    assert.equal(busy.snapshot().phase, 'error')
    assert.match(busy.snapshot().error, new RegExp(String(port)))
    await busy.close()
  } finally {
    await new Promise((resolve) => blocker.close(resolve))
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('RemoteAccess reports the Windows Firewall and can allow phones through it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-remote-'))
  const port = await freePort()
  let rule = false
  const asked = []
  const remote = await new RemoteAccess({
    file: path.join(dir, 'remote.json'), port, onRequest: () => {}, onUpgrade: () => {},
    addresses: async () => ['127.0.0.1'],
    firewall: {
      check: async (options) => {
        asked.push(options)
        return rule ? 'allowed' : 'blocked'
      },
      allow: async () => {
        rule = true
        return null
      },
    },
  }).load()
  try {
    await remote.start()
    // The check runs in the background; recheck waits for it.
    await remote.recheck()
    assert.equal(remote.snapshot().firewall, 'blocked')
    assert.deepEqual(asked.at(-1), { port, address: '127.0.0.1' })
    assert.equal(await remote.allowFirewall(), null)
    assert.equal(remote.snapshot().firewall, 'allowed')
    await remote.stop()
    assert.equal(remote.snapshot().firewall, null)
  } finally {
    await remote.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('RemoteAccess retries Tailscale status after a null response', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-remote-'))
  let calls = 0
  const remote = await new RemoteAccess({
    file: path.join(dir, 'remote.json'), onRequest: () => {}, onUpgrade: () => {}, firewall,
    interfaces: () => ({ utun4: [{ family: 'IPv4', address: '100.101.7.12', internal: false }] }),
    status: async () => {
      calls += 1
      return calls === 1 ? null : { running: true, ips: ['100.101.7.12'], dnsName: null }
    },
  }).load()
  try {
    assert.deepEqual(await remote.findAddresses(), [])
    assert.deepEqual(await remote.findAddresses(), ['100.101.7.12'])
    assert.equal(calls, 2)
  } finally {
    await remote.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('RemoteAccess keeps the token in use when the new one cannot be saved', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-remote-'))
  const noop = () => {}
  const remote = await new RemoteAccess({
    file: path.join(dir, 'remote.json'), onRequest: noop, onUpgrade: noop, firewall,
    interfaces: () => ({}), status: async () => null,
  }).load()
  try {
    await remote.rotate()
    const before = remote.token
    let revoked = 0
    remote.on('token', () => {
      revoked += 1
    })
    // A file where the token's folder should be: the save fails.
    await fs.writeFile(path.join(dir, 'blocker'), 'x')
    remote.file = path.join(dir, 'blocker', 'remote.json')
    await assert.rejects(remote.rotate())
    assert.equal(remote.token, before)
    assert.equal(revoked, 0)
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'remote.json'), 'utf8')).token, before)
  } finally {
    await remote.close()
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

test('RemoteAccess recheck asks Tailscale again while a refresh is still waiting for it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-remote-'))
  const noop = () => {}
  let installed = false
  const remote = await new RemoteAccess({
    file: path.join(dir, 'remote.json'), onRequest: noop, onUpgrade: noop, firewall,
    interfaces: () => ({}),
    status: async () => {
      const before = installed
      await new Promise((resolve) => setTimeout(resolve, 300))
      return before ? { running: false, ips: [], dnsName: null } : null
    },
  }).load()
  try {
    const starting = remote.start()
    // The start's refresh is waiting for the Tailscale CLI, which is installed meanwhile.
    await new Promise((resolve) => setTimeout(resolve, 50))
    installed = true
    await remote.recheck()
    assert.equal(remote.snapshot().phase, 'stopped')
    await starting
  } finally {
    await remote.close()
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

test('RemoteAccess contains rejected HTTP and upgrade callbacks', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-remote-'))
  const port = await freePort()
  const errors = []
  const remote = await new RemoteAccess({
    file: path.join(dir, 'remote.json'), port, addresses: async () => ['127.0.0.1'], firewall,
    onRequest: async () => { throw new Error('request callback failed') },
    onUpgrade: () => { throw new Error('upgrade callback failed') },
    log: (...args) => errors.push(args),
  }).load()
  try {
    await remote.start()
    const response = await fetch(`http://127.0.0.1:${port}/`, { headers: { connection: 'close' } })
    assert.equal(response.status, 500)
    assert.equal(await response.text(), 'internal server error')

    const socket = net.connect(port, '127.0.0.1')
    const closed = new Promise((resolve, reject) => {
      socket.once('close', resolve)
      socket.once('error', reject)
    })
    socket.once('connect', () => socket.write(
      `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
    ))
    await closed
    const failures = errors.filter(([message]) => /remote (request|upgrade) failed/.test(message))
    assert.equal(failures.length, 2)
    assert.match(failures[0][0], /remote request failed/)
    assert.match(failures[1][0], /remote upgrade failed/)
  } finally {
    await remote.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})
