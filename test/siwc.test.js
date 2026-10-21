import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { generateKeyPair, SignJWT } from 'jose'
import { CredentialStore, SIWC_RECORD, CODEX_RECORD, describeChatGpt } from '../server/credentials.js'
import { SiwcClient, verifySiwcIdToken, SIWC_ISSUER, SIWC_RESOURCE } from '../server/siwc-client.js'
import { siwcPayload, siwcEffort, SIWC_UNSUPPORTED_FIELDS, withSiwc, requireCompleted } from '../server/siwc-request.js'
import { ChatGptLogin } from '../server/chatgpt-login.js'
import { migrateSettings, planSettingsUpdate } from '../server/settings.js'
import { siwcModelDefinitions } from '../server/siwc-models.js'
const model = {
  id: 'gpt-6.1-sol',
  provider: 'openai-codex',
  api: 'openai-responses',
  baseUrl: SIWC_RESOURCE,
  reasoning: true,
  thinkingLevelMap: {
    off: null,
    minimal: null,
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max'
  }
}
const grant = (extra = {}) => ({
  subject: 'user',
  issuer: SIWC_ISSUER,
  client_id: 'oaiapp_test',
  ext_agent_host_id: 'urn:uuid:test',
  access_token: 'mock-access',
  refresh_token: 'mock-refresh',
  id_token: 'mock-id',
  token_type: 'Bearer',
  scopes: ['openid', 'chatgpt.tokens.use.direct'],
  expires_at: new Date(Date.now() + 3600000).toISOString(),
  ...extra
})
async function storeFor(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-siwc-'))
  t.after(() => fs.rm(dir, {
    recursive: true,
    force: true
  }))
  return new CredentialStore(path.join(dir, '.credentials.yaml'))
}
test('SIWC strips every preview unsupported field, priority, uses namespace and developer input', () => {
  const payload = {
    input: [{
      role: 'system',
      content: 'hi'
    }],
    tools: [{
      type: 'function',
      name: 'add',
      parameters: {}
    }],
    service_tier: 'priority',
    reasoning: {
      effort: 'none'
    },
    ...Object.fromEntries(SIWC_UNSUPPORTED_FIELDS.map(key => [key, 1]))
  }
  const changed = siwcPayload(payload, model)
  for (const key of [...SIWC_UNSUPPORTED_FIELDS, 'service_tier']) assert.equal(changed[key], undefined)
  assert.equal(payload.temperature, 1)
  assert.equal(changed.store, false)
  assert.equal(changed.stream, true)
  assert.equal(changed.input[0].role, 'developer')
  assert.equal(changed.tools[0].type, 'namespace')
  assert.equal(changed.reasoning.effort, 'low')
  assert.deepEqual(siwcPayload(changed, model), changed)
})
test('effort mapping never sends unsupported none/off/minimal/max and catalog only consumes capability metadata', () => {
  for (const effort of ['none', 'off', 'minimal', undefined, 'invalid']) assert.equal(siwcEffort(effort, model), 'low')
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) assert.equal(siwcEffort(effort, model), effort)
  assert.equal(siwcEffort('max', {
    thinkingLevelMap: {
      high: 'high'
    }
  }), 'high')
  const [definition] = siwcModelDefinitions([{
    slug: 'gpt-new',
    visibility: 'list',
    supported_reasoning_levels: [{
      effort: 'high'
    }],
    model_messages: {
      instructions: 'do not copy me'
    }
  }])
  assert.equal(definition.reasoningEfforts.off, undefined)
  assert.equal(definition.reasoningEfforts.high, 'high')
  assert.doesNotMatch(JSON.stringify(definition), /do not copy/)
})
test('SIWC per-request fetch injects latest token only at fixed public endpoint', async () => {
  let current = 'access-first'
  const sent = []
  const opts = withSiwc(model, {}, {
    client: {
      auth: async () => ({
        access_token: current
      })
    },
    fetch: async (url, init) => {
      sent.push({
        url,
        auth: init.headers.get('authorization'),
        body: JSON.parse(init.body),
        originator: init.headers.get('originator')
      })
      return new Response('data: {"type":"response.completed"}\n\n')
    }
  })
  for (const value of ['access-first', 'access-second']) {
    current = value
    await (await opts.fetch(`${SIWC_RESOURCE}/responses`, {
      method: 'POST',
      body: JSON.stringify({
        input: [],
        temperature: 0
      }),
      headers: {
        originator: 'old'
      }
    })).text()
  }
  assert.deepEqual(sent.map(item => item.auth), ['Bearer access-first', 'Bearer access-second'])
  assert.ok(sent.every(item => item.url === `${SIWC_RESOURCE}/responses` && item.originator === null && item.body.temperature === undefined))
  await assert.rejects(opts.fetch('https://example.com/responses', {
    method: 'POST',
    body: '{}'
  }), /Refusing/)
})
test('SIWC rejects incomplete and interrupted streams instead of treating SDK length as success', async () => {
  await assert.rejects(requireCompleted(new Response('data: {"type":"response.incomplete"}\n\n')).text(), /did not complete/)
  await assert.rejects(requireCompleted(new Response('data: {"type":"response.created"}\n\n')).text(), /interrupted/)
})
test('refresh uses issued client/resource, no scope, locks rotating tokens across clients and preserves legacy grant', async t => {
  const store = await storeFor(t)
  await store.setGrant(CODEX_RECORD, {
    access: 'legacy-only',
    refresh: 'legacy-refresh'
  })
  await store.setGrant(SIWC_RECORD, grant({
    expires_at: new Date(0).toISOString()
  }))
  let exchanges = 0
  const fetcher = async (url, init) => {
    exchanges++
    assert.equal(url, `${SIWC_ISSUER}/api/accounts/oauth/token`)
    assert.equal(init.body.get('client_id'), 'oaiapp_test')
    assert.equal(init.body.get('resource'), SIWC_RESOURCE)
    assert.equal(init.body.has('scope'), false)
    return Response.json({
      access_token: 'new-access',
      refresh_token: 'rotated-refresh',
      token_type: 'Bearer',
      expires_in: 3600
    })
  }
  const results = await Promise.all(Array.from({
    length: 5
  }, () => new SiwcClient(new CredentialStore(store.file), {
    fetch: fetcher
  }).auth()))
  assert.equal(exchanges, 1)
  assert.ok(results.every(result => result.access_token === 'new-access'))
  const records = (await store.read()).records
  assert.equal(records[SIWC_RECORD].payload.refresh_token, 'rotated-refresh')
  assert.equal(records[CODEX_RECORD].payload.access, 'legacy-only')
})
test('old Codex grant never authenticates official chat/search and migration disables fake GPT fast', async t => {
  const store = await storeFor(t)
  await store.setGrant(CODEX_RECORD, {
    access: 'legacy-only'
  })
  let network = 0
  await assert.rejects(new SiwcClient(store, {
    fetch: () => {
      network++
    }
  }).auth(), /sign in again \(official\)/)
  const status = describeChatGpt((await store.read()).records)
  assert.equal(status.signedIn, false)
  assert.equal(status.needsOfficialLogin, true)
  assert.equal(network, 0)
  const migrated = migrateSettings({
    imageTool: false,
    fastMode: {
      anthropic: true,
      'openai-codex': true
    },
    defaultModel: 'old opaque selection'
  })
  assert.deepEqual(migrated.fastMode, {
    anthropic: true,
    'openai-codex': false
  })
  assert.equal(migrated.imageTool, false)
  assert.deepEqual(migrateSettings(migrated), migrated)
  assert.throws(() => planSettingsUpdate(migrated, {
    fastMode: {
      'openai-codex': true
    }
  }, Date.now()), /unavailable/)
})
test('terminal refresh failures clear only SIWC tokens; temporary failures retain them', async t => {
  const store = await storeFor(t)
  await store.setGrant(SIWC_RECORD, grant({
    expires_at: new Date(0).toISOString()
  }))
  await assert.rejects(new SiwcClient(store, {
    fetch: async () => Response.json({
      error: 'temporarily_unavailable'
    }, {
      status: 503
    })
  }).auth(), /503/)
  assert.equal((await store.read()).records[SIWC_RECORD].payload.refresh_token, 'mock-refresh')
  await assert.rejects(new SiwcClient(store, {
    fetch: async () => Response.json({
      error: 'invalid_grant'
    }, {
      status: 400
    })
  }).auth(), /invalid_grant/)
  assert.equal((await store.read()).records[SIWC_RECORD].payload.refresh_token, null)
})
test('ID token validation verifies signature/audience/issuer/expiry/nonce/account', async () => {
  const {
    privateKey,
    publicKey
  } = await generateKeyPair('RS256')
  const jwt = await new SignJWT({
    nonce: 'expected'
  }).setProtectedHeader({
    alg: 'RS256'
  }).setIssuer(SIWC_ISSUER).setAudience('oaiapp_test').setSubject('user').setIssuedAt().setExpirationTime('5m').sign(privateKey)
  assert.equal((await verifySiwcIdToken(jwt, 'oaiapp_test', {
    nonce: 'expected',
    keySet: publicKey
  })).sub, 'user')
  await assert.rejects(verifySiwcIdToken(jwt, 'other-client', {
    keySet: publicKey
  }))
  await assert.rejects(verifySiwcIdToken(jwt, 'oaiapp_test', {
    nonce: 'wrong',
    keySet: publicKey
  }), /nonce/)
  await assert.rejects(verifySiwcIdToken(jwt, 'oaiapp_test', {
    keySet: publicKey,
    previous: grant({
      subject: 'another'
    })
  }), /identity changed/)
})
test('official login exchanges issued dynamic client and PKCE after validated loopback state, does not expose URL/token', async t => {
  const store = await storeFor(t)
  const states = []
  let authorize
  const login = new ChatGptLogin({
    store,
    onState: state => states.push(state),
    openUrl: async url => {
      authorize = new URL(url)
      const callback = new URL(authorize.searchParams.get('redirect_uri'))
      callback.search = new URLSearchParams({
        state: authorize.searchParams.get('state'),
        code: 'mock-code',
        client_id: 'oaiapp_issued'
      })
      const response = await fetch(callback)
      assert.equal(response.status, 200)
    },
    fetch: async (url, init) => {
      assert.equal(init.body.get('client_id'), 'oaiapp_issued')
      assert.equal(init.body.get('code'), 'mock-code')
      assert.ok(init.body.get('code_verifier'))
      return Response.json({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        id_token: 'new-id',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'openid chatgpt.tokens.use.direct'
      })
    },
    verify: async (_token, clientId, {
      nonce
    }) => {
      assert.equal(clientId, 'oaiapp_issued')
      assert.equal(nonce, authorize.searchParams.get('nonce'))
      return {
        iss: SIWC_ISSUER,
        sub: 'user'
      }
    }
  })
  await login.start()
  assert.equal(login.state.phase, 'done')
  assert.equal(authorize.searchParams.get('client_id'), 'dynamic_agent_client')
  assert.equal(authorize.searchParams.get('agent_name_hint'), 'Agent Desk')
  assert.match(authorize.searchParams.get('ext_agent_host_id'), /^urn:uuid:/)
  assert.equal((await store.read()).records[SIWC_RECORD].payload.client_id, 'oaiapp_issued')
  assert.ok(states.every(state => !Object.hasOwn(state, 'url')))
  assert.doesNotMatch(JSON.stringify(states), /new-access|new-refresh|new-id/)
})
