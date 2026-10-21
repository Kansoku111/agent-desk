import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { createRequestHandler } from '../server/http-routes.js'
import { createSocketServer } from '../server/websocket.js'

function makeRequestHandler({ busy = () => false, log = () => {} } = {}) {
  return createRequestHandler({
    appVersion: 'test', codeStamp: 'test', busy, updater: { locked: false }, countClients: () => 0,
    paths: { attachmentsDir: '' }, terminals: { hook: () => false }, teams: { call: async () => '' },
    shutdown: async () => {}, log,
  })
}

function mockResponse() {
  return {
    headersSent: false,
    status: null,
    body: null,
    destroyed: false,
    writeHead(status) {
      this.status = status
      this.headersSent = true
      return this
    },
    end(body = '') {
      this.body = body
      return this
    },
    destroy() {
      this.destroyed = true
    },
  }
}

test('malformed URL parsing returns 400 after the existing Host rejection', async () => {
  const handleRequest = makeRequestHandler()
  const ctx = { remote: false, port: 47130, token: 'secret', hostOk: (host) => host === '127.0.0.1:47130' }
  const req = { url: 'http://[', method: 'GET', headers: { host: 'wrong.example' } }
  const rejected = mockResponse()
  await handleRequest(req, rejected, ctx)
  assert.equal(rejected.status, 421)

  req.headers.host = '127.0.0.1:47130'
  const malformed = mockResponse()
  await handleRequest(req, malformed, ctx)
  assert.equal(malformed.status, 400)
})

test('bad percent-encoding returns 400 and unexpected request errors return logged 500', async (t) => {
  const errors = []
  const handleRequest = makeRequestHandler({
    busy: () => { throw new Error('test failure') },
    log: (...args) => errors.push(args),
  })
  let port
  const server = http.createServer((req, res) => {
    void handleRequest(req, res, {
      remote: false, port, token: 'secret',
      hostOk: (host) => host === `127.0.0.1:${port}`,
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  port = server.address().port
  t.after(() => new Promise((resolve) => server.close(resolve)))

  const request = (path) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: { connection: 'close' } }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.once('error', reject)
    req.end()
  })

  assert.equal(await request('/%'), 400)
  assert.equal(await request('/api/ping'), 500)
  assert.equal(errors.length, 1)
  assert.match(errors[0][0], /HTTP request failed/)
})

test('handleRequest closes a response if an unexpected error follows headers', async () => {
  const handleRequest = makeRequestHandler({ log: () => {} })
  const res = mockResponse()
  res.writeHead = function () {
    this.headersSent = true
    throw new Error('write failed')
  }
  await handleRequest(
    { url: '/api/auth', method: 'GET', headers: { host: '127.0.0.1:47130' } },
    res,
    { remote: false, port: 47130, token: 'secret', hostOk: () => true },
  )
  assert.equal(res.destroyed, true)
})

test('handleUpgrade returns 400 for malformed URLs without throwing', () => {
  const { handleUpgrade } = createSocketServer({
    dev: false, clients: new Map(), handlers: {}, fullState: async () => ({}), terminals: { dropClient: () => {} },
    broadcastRemote: () => {}, scheduleIdleExit: () => {}, cancelIdleExit: () => {},
    isShuttingDown: () => false, log: () => {},
  })
  const socket = {
    writes: [],
    destroyed: false,
    write(value) { this.writes.push(value) },
    destroy() { this.destroyed = true },
  }
  assert.doesNotThrow(() => handleUpgrade(
    { url: 'http://[', headers: {} }, socket, Buffer.alloc(0),
    { remote: false, port: 47130, token: 'secret', hostOk: () => false },
  ))
  assert.match(socket.writes[0], /^HTTP\/1\.1 400 Bad Request/)
  assert.equal(socket.destroyed, true)
})
