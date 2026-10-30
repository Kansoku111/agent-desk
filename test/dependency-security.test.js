import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { z } from 'zod'
import { compareVersions } from '../server/update-checks.js'

const root = fileURLToPath(new URL('../', import.meta.url))

// Guard nested copies too: dsh and LibreOffice pin vulnerable versions exactly.
test('the lockfile and installed tree contain only patched dependency versions', async () => {
  const lock = JSON.parse(await fs.readFile(new URL('../package-lock.json', import.meta.url), 'utf8'))
  for (const [name, minimum] of Object.entries({
    '@modelcontextprotocol/client': '2.3.0',
    fflate: '0.8.3',
    undici: '8.12.2',
    zod: '4.6.6',
  })) {
    const copies = Object.entries(lock.packages).filter(([location]) => location.endsWith('node_modules/' + name))
    assert.ok(copies.length, name + ' is covered by the lockfile')
    for (const [location, record] of copies) {
      assert.ok(compareVersions(record.version, minimum) >= 0, location + ' must be at least ' + minimum)
      const installed = JSON.parse(await fs.readFile(new URL('../' + location + '/package.json', import.meta.url), 'utf8'))
      assert.equal(installed.version, record.version, location + ' matches the audited lockfile')
    }
  }
})

test('oversized constrained Zod arrays reject before validating their elements', () => {
  let visits = 0
  const schema = z.array(z.preprocess((value) => { visits += 1; return value }, z.string())).max(2)
  const result = schema.safeParse(Array(10_000).fill(123))
  assert.equal(result.success, false)
  assert.equal(result.error.issues.length, 1)
  assert.equal(result.error.issues[0].code, 'too_big')
  assert.equal(visits, 0, 'GHSA-mrhx-c7xc-m3w5: do not allocate per-element issues for an oversized collection')
  assert.deepEqual(schema.parse(['valid']), ['valid'])
})

test('fflate rejects a ZIP64 sentinel without its extra field instead of hanging', () => {
  // A synchronous parser regression could hang the test runner, so bound it in a child.
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict'
    import { zipSync, unzipSync, strToU8 } from 'fflate'
    const zip = zipSync({ 'fixture.txt': strToU8('fixture') }, { level: 0 })
    assert.equal(new TextDecoder().decode(unzipSync(zip)['fixture.txt']), 'fixture')
    const buffer = Buffer.from(zip)
    const central = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    assert.ok(central >= 0)
    buffer.writeUInt32LE(0xffffffff, central + 20)
    // ZIP64 end records activate ZIP64 parsing; the entry deliberately has no extra field.
    const end = buffer.length - 22
    const zip64 = Buffer.alloc(56)
    zip64.writeUInt32LE(0x06064b50, 0)
    zip64.writeBigUInt64LE(44n, 4)
    zip64.writeBigUInt64LE(1n, 24)
    zip64.writeBigUInt64LE(1n, 32)
    zip64.writeBigUInt64LE(BigInt(end - central), 40)
    zip64.writeBigUInt64LE(BigInt(central), 48)
    const locator = Buffer.alloc(20)
    locator.writeUInt32LE(0x07064b50, 0)
    locator.writeBigUInt64LE(BigInt(end), 8)
    locator.writeUInt32LE(1, 16)
    const malformed = Buffer.concat([buffer.subarray(0, end), zip64, locator, buffer.subarray(end)])
    assert.throws(() => unzipSync(malformed), (error) => error.code === 13)
  `], { cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true })
  assert.ifError(child.error)
  assert.equal(child.status, 0, child.stderr)
})

async function listen(t, handler) {
  const server = http.createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }))
  return new URL('http://127.0.0.1:' + server.address().port)
}

for (const status of [307, 308]) {
  test('MCP HTTP blocks cross-origin ' + status + ' redirects without forwarding session, headers or body', async (t) => {
    let received = 0
    const target = await listen(t, (req, res) => { received += 1; req.resume(); res.writeHead(202).end() })
    const sent = []
    const origin = await listen(t, (req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        sent.push({ headers: req.headers, body })
        if (req.url === '/accepted') res.writeHead(202).end()
        else res.writeHead(status, { location: req.url === '/same' ? '/accepted' : target.href }).end()
      })
    })
    const message = { jsonrpc: '2.0', method: 'notifications/initialized', params: { fixture: true } }
    const transport = (url) => {
      const value = new StreamableHTTPClientTransport(url, {
        sessionId: 'fixture-session',
        requestInit: { headers: { 'X-API-Key': 'fixture-only' } },
      })
      t.after(() => value.close())
      return value
    }
    const blocked = transport(origin)
    await blocked.start()
    await assert.rejects(blocked.send(message, { requestSignal: AbortSignal.timeout(10_000) }), /redirect|307|308/i)
    assert.equal(received, 0, 'GHSA-6prh-2h8m-c8cw: the other origin receives no request')
    assert.equal(sent[0].headers['x-api-key'], 'fixture-only')
    assert.equal(sent[0].headers['mcp-session-id'], 'fixture-session')
    assert.deepEqual(JSON.parse(sent[0].body), message)
    // The security default must not break intentional same-origin redirects.
    const allowed = transport(new URL('/same', origin))
    await allowed.start()
    await allowed.send(message, { requestSignal: AbortSignal.timeout(10_000) })
    assert.equal(sent.length, 3)
    assert.deepEqual(JSON.parse(sent[2].body), message)
  })
}
