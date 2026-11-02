import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createRequestHandler } from '../server/http-routes.js'

function response() {
  return { status: null, body: '', writeHead(status) { this.status = status }, end(body = '') { this.body = body } }
}
function req(body, method = 'POST') {
  return Object.assign(Readable.from([body]), { url: '/api/team-observer', method, headers: { host: 'localhost' } })
}
const context = { remote: false, port: 1234, token: 'web-token', hostOk: () => true }
test('observer endpoint forwards capability to the observer dispatcher only', async () => {
  const calls = []
  const handler = createRequestHandler({ paths: {}, teams: { async observerCall(...args) { calls.push(args); return 'result' } }, log() {} })
  const res = response()
  await handler(req(JSON.stringify({ teamId: 'team', secret: 'cap', tool: 'status', args: {} })), res, context)
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.body), { ok: true, text: 'result' })
  assert.deepEqual(calls, [['team', 'cap', 'status', {}]])
  const rejected = response()
  await handler(req('', 'GET'), rejected, context)
  assert.equal(rejected.status, 405)
})
test('observer endpoint does not expose capability errors', async () => {
  const handler = createRequestHandler({ paths: {}, teams: { async observerCall() { const e = new Error('private'); e.status = 403; throw e } }, log() {} })
  const res = response()
  await handler(req('{}'), res, context)
  assert.equal(res.status, 403)
  assert.equal(res.body, 'forbidden')
})
