import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ChatGptLogin } from '../server/chatgpt-login.js'
import { CredentialStore, SIWC_RECORD } from '../server/credentials.js'
import { SIWC_ISSUER } from '../server/siwc-client.js'

async function storeFor(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-login-state-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return new CredentialStore(path.join(dir, '.credentials.yaml'))
}

// Token endpoint stub: the test never reaches the network.
const tokenFetch = async () => Response.json({
  access_token: 'new-access',
  refresh_token: 'new-refresh',
  id_token: 'new-id',
  expires_in: 3600,
  token_type: 'Bearer'
})

// The browser step receives the authorize URL and the loopback callback URL.
function loginWith(store, browser) {
  return new ChatGptLogin({
    store,
    onState() {},
    async openUrl(href) {
      const authorize = new URL(href)
      await browser(authorize, new URL(authorize.searchParams.get('redirect_uri')))
    },
    fetch: tokenFetch,
    verify: async (_token, _clientId, { nonce }) => {
      assert.ok(nonce)
      return { iss: SIWC_ISSUER, sub: 'user' }
    }
  })
}

function hit(callback, params, method = 'GET') {
  const url = new URL(callback)
  url.search = new URLSearchParams(params).toString()
  return fetch(url, { method })
}

test('wrong-state and non-GET callbacks neither consume nor reject the sign-in; the correct callback completes it once', { timeout: 20000 }, async t => {
  const store = await storeFor(t)
  const seen = []
  const login = loginWith(store, async (authorize, callback) => {
    const state = authorize.searchParams.get('state')
    const ok = { code: 'mock-code', client_id: 'issued-client' }
    seen.push((await hit(callback, { state: 'not-this-attempt', ...ok })).status)
    seen.push((await hit(callback, { state, ...ok }, 'POST')).status)
    seen.push((await hit(callback, { state, ...ok })).status)
    seen.push((await hit(callback, { state, ...ok })).status)
  })
  await login.start()
  assert.deepEqual(seen, [400, 400, 200, 409])
  assert.equal(login.state.phase, 'done')
  assert.equal((await store.read()).records[SIWC_RECORD].payload.refresh_token, 'new-refresh')
})

test('a correct-state denial fails the sign-in and the attempt stays consumed', { timeout: 20000 }, async t => {
  const store = await storeFor(t)
  const seen = []
  const login = loginWith(store, async (authorize, callback) => {
    const state = authorize.searchParams.get('state')
    seen.push((await hit(callback, { state, error: 'access_denied' })).status)
    seen.push((await hit(callback, { state, code: 'mock-code', client_id: 'issued-client' })).status)
  })
  await login.start()
  assert.deepEqual(seen, [400, 409])
  assert.equal(login.state.phase, 'error')
  assert.equal((await store.read()).records[SIWC_RECORD], undefined)
})

test('a correct-state callback without an authorization code fails the sign-in', { timeout: 20000 }, async t => {
  const store = await storeFor(t)
  const seen = []
  const login = loginWith(store, async (authorize, callback) => {
    const state = authorize.searchParams.get('state')
    seen.push((await hit(callback, { state, client_id: 'issued-client' })).status)
  })
  await login.start()
  assert.deepEqual(seen, [400])
  assert.equal(login.state.phase, 'error')
  assert.equal((await store.read()).records[SIWC_RECORD], undefined)
})
