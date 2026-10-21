import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SiwcModelCatalog } from '../server/siwc-models.js'
import { SIWC_RECORD } from '../server/credentials.js'
const payload = subject => ({
  client_id: `client-${subject}`,
  subject,
  access_token: `access-${subject}`,
  expires_at: new Date(Date.now() + 3600000).toISOString(),
  scopes: ['chatgpt.tokens.use.direct']
})
const models = size => [{
  slug: 'gpt-6.1-sol',
  visibility: 'list',
  display_name: 'GPT-6.1 Sol',
  context_window: size,
  supported_reasoning_levels: [{
    effort: 'low'
  }, {
    effort: 'high'
  }]
}]
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-public-models-'))
  t.after(() => fs.rm(dir, {
    recursive: true,
    force: true
  }))
  return path.join(dir, 'siwc-models.json')
}
test('public catalog uses issued SIWC grant and caches capability definitions across network failures', async t => {
  const file = await setup(t),
    cached = await new SiwcModelCatalog(file).load()
  const store = {
    read: async () => ({
      records: {
        [SIWC_RECORD]: {
          payload: payload('one')
        }
      }
    })
  }
  let ok = true
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/models')
    assert.equal(options.headers.authorization, 'Bearer access-one')
    assert.equal(options.headers['chatgpt-account-id'], undefined)
    return {
      ok,
      status: 503,
      json: async () => ({
        models: models(500000)
      })
    }
  })
  assert.equal(await cached.refresh(store), true)
  assert.equal(cached.limits['gpt-6.1-sol'].contextWindow, 500000)
  assert.equal(await cached.refresh(store), false)
  ok = false
  assert.equal(await cached.refresh(store), false)
  assert.equal(cached.status, 'error')
  const reloaded = await new SiwcModelCatalog(file).load()
  assert.deepEqual(reloaded.definitions, cached.definitions)
})
test('overlapping public refreshes discard old-account results and persist only selected identity', async t => {
  const file = await setup(t),
    cached = await new SiwcModelCatalog(file).load()
  let current = payload('old')
  const store = {
    read: async () => ({
      records: {
        [SIWC_RECORD]: {
          payload: {
            ...current
          }
        }
      }
    })
  }
  const started = Promise.withResolvers(),
    release = Promise.withResolvers(),
    calls = []
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const auth = options.headers.authorization
    calls.push(auth)
    if (auth === 'Bearer access-old') {
      started.resolve()
      await release.promise
    }
    
    return {
      ok: true,
      json: async () => ({
        models: models(auth.includes('old') ? 272000 : 500000)
      })
    }
  })
  const first = cached.refresh(store)
  await started.promise
  current = payload('new')
  const second = cached.refresh(store)
  release.resolve()
  assert.equal(await first, false)
  assert.equal(await second, true)
  assert.equal(calls.length, 2)
  assert.equal(cached.limits['gpt-6.1-sol'].contextWindow, 500000)
})
test('legacy-only or signed-out catalog cannot fetch public models or retain another account catalog', async t => {
  const file = await setup(t)
  await fs.writeFile(file, JSON.stringify({
    identity: 'other',
    definitions: [{
      id: 'other',
      contextWindow: 1
    }]
  }))
  const cached = await new SiwcModelCatalog(file).load()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
  })
  assert.equal(await cached.refresh({
    read: async () => ({
      records: {
        'llm-pi-ai/openai-codex': {
          payload: {
            access: 'legacy'
          }
        }
      }
    })
  }), false)
  assert.equal(cached.status, 'signed-out')
  assert.equal(calls, 0)
  assert.equal(cached.definitions.length, 0)
})
