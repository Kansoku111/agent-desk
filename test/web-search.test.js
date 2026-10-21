import assert from 'node:assert/strict'
import { test } from 'node:test'
import YAML from 'yaml'
import { WEB_SEARCH_PLUGIN, homePatch } from '../server/dsh-config.js'
import { PROVIDER_ID, apply } from '../server/web-search-plugin.js'
import { cleanUrl, searchFromEvents, searchRequest } from '../server/web-search.js'

const done = (item) => ({ type: 'response.output_item.done', item })

test('searchRequest asks GPT to search with the hosted tool and return the sources', () => {
  const body = searchRequest('JUCE latest version')
  assert.deepEqual(body.tools, [{ type: 'web_search' }])
  assert.deepEqual(body.include, ['web_search_call.action.sources'])
  assert.deepEqual(body.input[0].content, [{ type: 'input_text', text: 'JUCE latest version' }])
  assert.equal(body.store, false)
})

test('searchFromEvents returns the digest and cited sources before the other pages read', () => {
  const result = searchFromEvents([
    done({ type: 'web_search_call', action: { sources: [{ url: 'https://a.example/' }, { url: 'https://b.example/' }] } }),
    done({
      type: 'message',
      content: [{
        type: 'output_text',
        text: 'Version 9 ([B](https://b.example/?utm_source=openai)).',
        annotations: [{ type: 'url_citation', url: 'https://b.example/?utm_source=openai', title: 'B docs' }],
      }],
    }),
  ])
  assert.deepEqual(result, {
    content: 'Version 9 ([B](https://b.example/)).',
    sources: [{ url: 'https://b.example/', title: 'B docs' }, { url: 'https://a.example/' }],
    truncated: false,
  })
})

test('searchFromEvents fails when the model did not search or the response failed', () => {
  assert.throws(() => searchFromEvents([done({ type: 'message', content: [{ text: 'I know this.' }] })]), /did not search.*I know this/)
  assert.throws(() => searchFromEvents([{ type: 'response.failed', response: { error: { message: 'overloaded' } } }]), /overloaded/)
})

test('cleanUrl drops only the OpenAI tracking parameter', () => {
  assert.equal(cleanUrl('https://x.example/p?utm_source=openai'), 'https://x.example/p')
  assert.equal(cleanUrl('https://x.example/p?a=1&utm_source=openai'), 'https://x.example/p?a=1')
  assert.equal(cleanUrl('https://x.example/p?utm_source=news'), 'https://x.example/p?utm_source=news')
})

test('the plugin registers the provider the home patch selects', () => {
  const registered = []
  apply({ web: { registerSearchProvider: (provider) => registered.push(provider) } }, { credentials: 'missing.yaml' })
  assert.equal(registered[0].id, PROVIDER_ID)

  const rows = YAML.parse(homePatch({ webSearch: { plugin: WEB_SEARCH_PLUGIN, credentials: 'C:/dsh/.credentials.yaml' } }))
  assert.deepEqual(rows.find((row) => row.id === 'web').config, { searchProvider: PROVIDER_ID, fetchProvider: 'http' })
  assert.deepEqual(rows.at(-1).insert, [{ id: 'agent-desk-web-search', name: WEB_SEARCH_PLUGIN, config: { credentials: 'C:/dsh/.credentials.yaml' } }])
  assert.ok(WEB_SEARCH_PLUGIN.startsWith('file:') && WEB_SEARCH_PLUGIN.endsWith('/server/web-search-plugin.js'))
})

test('a search without a ChatGPT sign-in says how to fix it', async () => {
  const registered = []
  apply({ web: { registerSearchProvider: (provider) => registered.push(provider) } }, { credentials: 'missing.yaml' })
  await assert.rejects(registered[0].search({ query: 'x' }), /sign in again \(official\)/)
})
