import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import zlib from 'node:zlib'
import { applyCatalogAdditions } from '../server/model-catalog.js'
import { downloadTarball, ModelCatalogUpdater, newerModels, newerPricing, readFetchedCatalog, readTarFiles } from '../server/model-updates.js'

/** A gzipped ustar archive; `pax` entries name their file through a pax header. */
function tgz(entries) {
  const blocks = []
  const header = (name, size, type) => {
    const block = Buffer.alloc(512)
    block.write(name.slice(0, 100), 0)
    block.write('0000644\0', 100)
    block.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
    block.write(type, 156)
    block.write('ustar\0', 257)
    block.write('00', 263)
    block.fill(' ', 148, 156)
    const sum = block.reduce((total, byte) => total + byte, 0)
    block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
    return block
  }
  const pad = (body) => Buffer.concat([body, Buffer.alloc((512 - (body.length % 512)) % 512)])
  for (const { name, body, pax } of entries) {
    const data = Buffer.from(body)
    if (pax) {
      // A pax record starts with its own length, digits included.
      const record = ` path=${name}\n`
      let length = record.length + 1
      while (String(length).length + record.length !== length) length = String(length).length + record.length
      const line = `${length}${record}`
      blocks.push(header('PaxHeader', Buffer.byteLength(line), 'x'), pad(Buffer.from(line)))
      blocks.push(header('ignored-short-name', data.length, '0'), pad(data))
    } else {
      blocks.push(header(name, data.length, '0'), pad(data))
    }
  }
  blocks.push(Buffer.alloc(1024))
  return zlib.gzipSync(Buffer.concat(blocks))
}

const sri = (buffer) => `sha512-${createHash('sha512').update(buffer).digest('base64')}`

const shippedAnthropic = {
  'anthropic-messages': {
    'claude-sonnet-5': {
      id: 'claude-sonnet-5', name: 'Claude Sonnet 5', api: 'anthropic-messages', provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com', reasoning: true, input: ['text'], cost: { input: 3, output: 15 },
      contextWindow: 1_000_000, maxTokens: 128_000,
    },
  },
}
const keys = new Set(Object.keys(shippedAnthropic['anthropic-messages']['claude-sonnet-5']))
const model = (id, extra = {}) => ({ ...shippedAnthropic['anthropic-messages']['claude-sonnet-5'], id, name: id, ...extra })

test('readTarFiles finds files under the package folder, pax names included', () => {
  const archive = tgz([
    { name: 'package/README.md', body: 'hi' },
    { name: 'package/dist/providers/data/anthropic.json', body: '{"a":1}' },
    { name: 'package/dist/providers/data/openai-codex.json', body: '{"b":2}', pax: true },
  ])
  const files = readTarFiles(archive, new Set(['dist/providers/data/anthropic.json', 'dist/providers/data/openai-codex.json']))
  assert.equal(files.get('dist/providers/data/anthropic.json').toString(), '{"a":1}')
  assert.equal(files.get('dist/providers/data/openai-codex.json').toString(), '{"b":2}')
  assert.equal(files.size, 2)
})

test('newerModels reads pi-ai 1.x keys and keeps only what the installed pi-ai can use', () => {
  const data = {
    'anthropic-messages': {
      'chat:claude-sonnet-5': { ...model('claude-sonnet-5'), type: 'chat' },
      'chat:claude-sonnet-6': { ...model('claude-sonnet-6', { name: 'Claude Sonnet 6' }), type: 'chat', speedTiers: ['x'] },
      'image:claude-paint-1': { ...model('claude-paint-1'), type: 'image' },
      'chat:claude-evil-1': { ...model('claude-evil-1'), type: 'chat', baseUrl: 'https://evil.example' },
      'chat:claude-broken': { ...model('claude-broken'), type: 'chat', contextWindow: 'big' },
    },
    'anthropic-batches': { 'chat:claude-batch-1': { ...model('claude-batch-1', { api: 'anthropic-batches' }), type: 'chat' } },
  }
  const { groups, models } = newerModels({ provider: 'anthropic', data, shipped: shippedAnthropic, keys })
  assert.deepEqual(Object.keys(groups), ['anthropic-messages'])
  assert.deepEqual(Object.keys(groups['anthropic-messages']), ['claude-sonnet-6'])
  const added = groups['anthropic-messages']['claude-sonnet-6']
  assert.equal(added.name, 'Claude Sonnet 6')
  // Fields the installed pi-ai does not know are dropped.
  assert.equal(added.type, undefined)
  assert.equal(added.speedTiers, undefined)
  assert.deepEqual(models, [{ id: 'claude-sonnet-6', name: 'Claude Sonnet 6' }])
})

test('newerModels also reads the bare-id layout', () => {
  const data = { 'anthropic-messages': { 'claude-sonnet-6': model('claude-sonnet-6') } }
  assert.deepEqual(Object.keys(newerModels({ provider: 'anthropic', data, shipped: shippedAnthropic, keys }).groups['anthropic-messages']), ['claude-sonnet-6'])
})

test('a fetched definition wins over the bundled one and carries its own marker', () => {
  const base = structuredClone(shippedAnthropic)
  const fetched = { providers: { anthropic: { 'anthropic-messages': {
    'claude-sonnet-5-5': model('claude-sonnet-5-5', { name: 'Newer definition' }),
    'claude-sonnet-6': model('claude-sonnet-6'),
  } } } }
  const result = applyCatalogAdditions(base, 'anthropic', [], fetched)
  assert.equal(result.data['anthropic-messages']['claude-sonnet-5-5'].name, 'Newer definition')
  assert.equal(result.data['anthropic-messages']['claude-sonnet-5-5'].agentDeskAdded, 'fetched')
  assert.equal(result.data['anthropic-messages']['claude-haiku-5-5'].agentDeskAdded, 'bundled')
  assert.ok(result.models.some((entry) => entry.id === 'claude-sonnet-6' && entry.source === 'fetched'))
  // Turned off: the fetched models go away again.
  const off = applyCatalogAdditions(result.data, 'anthropic', [], null)
  assert.equal(off.data['anthropic-messages']['claude-sonnet-6'], undefined)
  assert.equal(off.data['anthropic-messages']['claude-sonnet-5-5'].agentDeskAdded, 'bundled')
})

test('price updates include known ids without changing their execution definitions', () => {
  const original = shippedAnthropic['anthropic-messages']['claude-sonnet-5']
  const data = { 'anthropic-messages': {
    'chat:claude-sonnet-5': { ...original, type: 'chat', cost: { input: 1, output: 5, cacheRead: 0.1 } },
    'chat:bad': { ...model('bad'), type: 'chat', cost: { input: -1, output: 2 } },
    'chat:unsafe': { ...model('unsafe'), type: 'chat', baseUrl: 'https://evil.example' },
  }, 'new-wire': { 'chat:future': { id: 'future', provider: 'anthropic', type: 'chat',
    baseUrl: original.baseUrl, cost: { input: 4, output: 8 } } } }
  assert.deepEqual(newerPricing({ provider: 'anthropic', data, shipped: shippedAnthropic }),
    { 'anthropic/claude-sonnet-5': { input: 1, output: 5, cacheRead: 0.1 },
      'anthropic/future': { input: 4, output: 8 } })
  assert.equal(newerModels({ provider: 'anthropic', data, shipped: shippedAnthropic, keys }).groups['anthropic-messages']?.['claude-sonnet-5'], undefined)
  assert.deepEqual(shippedAnthropic['anthropic-messages']['claude-sonnet-5'].cost, { input: 3, output: 15 })
})

test('downloadTarball refuses a file that does not match the registry hash', async () => {
  const body = Buffer.from('package bytes')
  const fetchImpl = async () => new Response(body)
  assert.deepEqual(await downloadTarball({ tarball: 'https://x', integrity: sri(body) }, fetchImpl), body)
  await assert.rejects(downloadTarball({ tarball: 'https://x', integrity: sri(Buffer.from('other')) }, fetchImpl), /一致しません/)
  await assert.rejects(downloadTarball({ tarball: 'https://x', integrity: 'sha1-abc' }, fetchImpl), /sha512/)
})

test('the updater reads a newer release once, keeps its models and reports the new ones', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'model-updates-'))
  try {
    const codex = { 'openai-codex-responses': {} }
    const anthropic = { 'anthropic-messages': {
      'chat:claude-sonnet-6': { ...model('claude-sonnet-6', { name: 'Claude Sonnet 6' }), type: 'chat' },
    } }
    const archive = tgz([
      { name: 'package/dist/providers/data/anthropic.json', body: JSON.stringify(anthropic) },
      { name: 'package/dist/providers/data/openai-codex.json', body: JSON.stringify(codex) },
    ])
    let version = '99.0.0'
    let downloads = 0
    let applied = 0
    let enabled = true
    const updater = await new ModelCatalogUpdater({
      root: home,
      home,
      enabled: () => enabled,
      onCatalog: async () => { applied += 1 },
      lookup: async () => ({ version, tarball: 'https://x', integrity: 'unused' }),
      download: async () => { downloads += 1; return archive },
      shipped: async () => ({ providers: { anthropic: shippedAnthropic, 'openai-codex': codex }, keys }),
    }).load()

    const first = await updater.check()
    assert.equal(first.error, null)
    assert.equal(first.source, '99.0.0')
    assert.deepEqual(first.lastAdded.models, [{ provider: 'anthropic', id: 'claude-sonnet-6', name: 'Claude Sonnet 6' }])
    assert.equal(applied, 1)
    assert.ok(updater.fetched.providers.anthropic['anthropic-messages']['claude-sonnet-6'])

    // The same release is not downloaded again.
    await updater.check()
    assert.equal(downloads, 1)

    // A later release with the same models announces nothing new and changes nothing.
    version = '99.0.1'
    const later = await updater.check()
    assert.equal(downloads, 2)
    assert.equal(applied, 1)
    assert.equal(later.lastAdded.at, first.lastAdded.at)

    // Kept across restarts, and offered to other processes.
    const reloaded = await new ModelCatalogUpdater({ root: home, home, enabled: () => true, onCatalog: async () => {} }).load()
    assert.equal(reloaded.snapshot().source, '99.0.1')
    assert.equal((await readFetchedCatalog(home)).source, '99.0.1')

    enabled = false
    assert.equal(updater.fetched, null)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('a price-only revision is persisted, applied and survives restart', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'model-prices-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  let version = '99.0.0', input = 4, applied = 0
  const updater = await new ModelCatalogUpdater({
    root: home, home, enabled: () => true, onCatalog: async () => { applied++ },
    lookup: async () => ({ version, tarball: 'https://example.test/models.tgz' }),
    download: async () => tgz([{ name: 'package/dist/providers/data/anthropic.json', body: JSON.stringify({
      'anthropic-messages': { 'chat:claude-sonnet-5': { ...model('claude-sonnet-5'), type: 'chat', cost: { input, output: 10 } } },
    }) }]),
    shipped: async () => ({ providers: { anthropic: shippedAnthropic }, keys }),
  }).load()
  await updater.check()
  assert.equal(updater.fetched.pricing['anthropic/claude-sonnet-5'].input, 4)
  assert.equal(applied, 1)
  input = 6
  version = '99.0.1'
  await updater.check()
  assert.equal(updater.fetched.pricing['anthropic/claude-sonnet-5'].input, 6)
  assert.equal(applied, 2, 'price changes apply even when no model was added')
  const reload = await new ModelCatalogUpdater({ home, root: home, enabled: () => true, onCatalog: async () => {} }).load()
  assert.equal(reload.fetched.pricing['anthropic/claude-sonnet-5'].input, 6)
  assert.equal((await readFetchedCatalog(home)).pricing['anthropic/claude-sonnet-5'].input, 6)
})

test('a fetched catalog older than the installed engine cannot override its prices', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'model-prices-older-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  await fs.writeFile(path.join(home, 'model-updates.json'), JSON.stringify({ catalog: {
    format: 3, source: '1.4.0', providers: {}, pricing: { 'anthropic/claude-sonnet-5': { input: 1, output: 2 } },
  } }))
  const updater = await new ModelCatalogUpdater({ home, root: home, enabled: () => true, onCatalog: async () => {},
    catalogVersion: async () => '1.5.0' }).load()
  assert.deepEqual(updater.fetched.pricing, {})
  assert.equal(updater.catalog.pricing['anthropic/claude-sonnet-5'].input, 1, 'retain the cache for possible later use')
})

test('OpenCode definitions are fetched, persisted and migrated even at the same pi-ai version', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'model-updates-go-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const base = model('glm-5.3', {
    name: 'GLM-5.3', provider: 'opencode-go', api: 'openai-completions', baseUrl: 'https://opencode.ai/inference/go/v1',
  })
  const shipped = { 'openai-completions': { 'glm-5.3': base } }
  const go = { 'openai-completions': { 'chat:beam-free': { ...base, type: 'chat', id: 'beam-free', name: 'Beam Free' } } }
  const archive = tgz([{ name: 'package/dist/providers/data/opencode-go.json', body: JSON.stringify(go) }])
  // Existing installs already cached the current release without the Go file.
  await fs.writeFile(path.join(home, 'model-updates.json'), JSON.stringify({ catalog: { source: '99.0.0', providers: {} } }))
  let downloads = 0
  const updater = await new ModelCatalogUpdater({
    root: home, home, enabled: () => true, onCatalog: async () => {},
    lookup: async () => ({ version: '99.0.0', tarball: 'https://example.test/models.tgz' }),
    download: async () => { downloads++; return archive },
    shipped: async () => ({ providers: { 'opencode-go': shipped }, keys }),
  }).load()
  const state = await updater.check()
  assert.equal(state.error, null)
  assert.equal(downloads, 1)
  assert.equal(updater.fetched.providers['opencode-go']['openai-completions']['beam-free'].api, 'openai-completions')
  assert.deepEqual(state.lastAdded.models, [{ provider: 'opencode-go', id: 'beam-free', name: 'Beam Free' }])
  assert.ok((await readFetchedCatalog(home)).providers['opencode-go'])
  await updater.check()
  assert.equal(downloads, 1)
})

test('old MiniMax Free definitions and update announcements migrate without a package download', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'model-updates-minimax-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const legacy = model('minimax-m3.1-flash-free', {
    name: 'MiniMax M3.1 Flash Free', provider: 'opencode-go', api: 'openai-completions', baseUrl: 'https://opencode.ai/inference/go/v1',
  })
  await fs.writeFile(path.join(home, 'model-updates.json'), JSON.stringify({
    catalog: { format: 2, source: '1.4.0', providers: { 'opencode-go': { 'openai-completions': { [legacy.id]: legacy } } } },
    lastAdded: { at: Date.now(), source: '1.4.0', models: [{ provider: 'opencode-go', id: legacy.id, name: legacy.name }] },
  }))
  const updater = await new ModelCatalogUpdater({ home, root: home, enabled: () => true, onCatalog: async () => {} }).load()
  const defs = updater.fetched.providers['opencode-go']['openai-completions']
  assert.equal(defs['minimax-m3.1-flash-free'], undefined)
  assert.equal(defs['minimax-m3.1-flash'].name, 'MiniMax M3.1 Flash')
  assert.deepEqual(updater.snapshot().lastAdded.models, [{ provider: 'opencode-go', id: 'minimax-m3.1-flash', name: 'MiniMax M3.1 Flash' }])
  assert.equal((await readFetchedCatalog(home)).providers['opencode-go']['openai-completions']['minimax-m3.1-flash'].id, 'minimax-m3.1-flash')
  const latest = newerModels({
    provider: 'opencode-go', data: { 'openai-completions': { [`chat:${legacy.id}`]: legacy } },
    shipped: { 'openai-completions': { 'glm-5.3': { ...legacy, id: 'glm-5.3' } } }, keys,
  })
  assert.deepEqual(latest.models, [{ id: 'minimax-m3.1-flash', name: 'MiniMax M3.1 Flash' }])
})

test('a failed lookup is reported and keeps what was fetched before', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'model-updates-'))
  try {
    const updater = await new ModelCatalogUpdater({
      root: home,
      home,
      enabled: () => true,
      onCatalog: async () => {},
      lookup: async () => { throw new Error('npm view failed\nmore') },
    }).load()
    const state = await updater.check()
    assert.match(state.error, /npm view failed$/)
    assert.equal(state.phase, 'idle')
    assert.equal(updater.catalog, null)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})
