import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import YAML from 'yaml'
import { CODEX_RECORD, CredentialStore, describeChatGpt, maskSecret } from '../server/credentials.js'

async function tempStore(initial) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-cred-'))
  const file = path.join(dir, '.credentials.yaml')
  if (initial !== undefined) await fs.writeFile(file, initial)
  return { store: new CredentialStore(file), file, cleanup: () => fs.rm(dir, { recursive: true, force: true }) }
}

function fakeJwt(claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode(claims)}.sig`
}

test('reading a missing file yields empty sections', async () => {
  const { store, cleanup } = await tempStore()
  assert.deepEqual(await store.read(), { refs: {}, records: {} })
  await cleanup()
})

test('setRef writes a versioned document dsh can parse', async () => {
  const { store, file, cleanup } = await tempStore()
  await store.setRef('ANTHROPIC_API_KEY', '  sk-ant-test  ')
  const doc = YAML.parse(await fs.readFile(file, 'utf8'))
  assert.equal(doc.version, 1)
  assert.deepEqual(doc.refs, { ANTHROPIC_API_KEY: 'sk-ant-test' })
  assert.equal(doc.records, undefined)
  const text = await fs.readFile(file, 'utf8')
  assert.ok(text.startsWith('version: 1'), 'version comes first')
  await cleanup()
})

test('edits keep comments and unrelated entries', async () => {
  const initial = 'version: 1\n# my deepseek key\nrefs:\n  DEEPSEEK_API_KEY: sk-ds\n'
  const { store, file, cleanup } = await tempStore(initial)
  await store.setRef('ANTHROPIC_API_KEY', 'sk-ant')
  await store.setGrant(CODEX_RECORD, { type: 'oauth', access: 'a', refresh: 'r', expires: 5, accountId: 'acc' })
  const text = await fs.readFile(file, 'utf8')
  assert.match(text, /# my deepseek key/)
  const doc = YAML.parse(text)
  assert.equal(doc.refs.DEEPSEEK_API_KEY, 'sk-ds')
  assert.equal(doc.refs.ANTHROPIC_API_KEY, 'sk-ant')
  assert.deepEqual(doc.records[CODEX_RECORD], { kind: 'grant', payload: { type: 'oauth', access: 'a', refresh: 'r', expires: 5, accountId: 'acc' } })
  await cleanup()
})

test('removing the last entry drops the empty section', async () => {
  const { store, file, cleanup } = await tempStore()
  await store.setRef('ANTHROPIC_API_KEY', 'sk-ant')
  await store.setGrant(CODEX_RECORD, { type: 'oauth', access: 'a', refresh: 'r', expires: 1 })
  await store.unsetRef('ANTHROPIC_API_KEY')
  await store.deleteRecord(CODEX_RECORD)
  const doc = YAML.parse(await fs.readFile(file, 'utf8'))
  assert.deepEqual(doc, { version: 1 })
  await cleanup()
})

test('a malformed file is never overwritten', async () => {
  const broken = 'version: 1\nrefs: [unclosed\n'
  const { store, file, cleanup } = await tempStore(broken)
  await assert.rejects(store.setRef('ANTHROPIC_API_KEY', 'x'), /not valid YAML/)
  assert.equal(await fs.readFile(file, 'utf8'), broken)
  await cleanup()
})

test('empty keys and invalid names are refused', async () => {
  const { store, cleanup } = await tempStore()
  await assert.rejects(store.setRef('ANTHROPIC_API_KEY', '   '), /empty/)
  await assert.rejects(store.setRef('bad-name', 'x'), /invalid/)
  await cleanup()
})

test('describeChatGpt reads display claims without exposing tokens', () => {
  const access = fakeJwt({
    'https://api.openai.com/profile': { email: 'me@example.com' },
    'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
  })
  const status = describeChatGpt({ [CODEX_RECORD]: { kind: 'grant', payload: { access, refresh: 'r', expires: 9 } } })
  assert.equal(status.signedIn, false)
  assert.equal(status.needsOfficialLogin, true)
  assert.doesNotMatch(JSON.stringify(status), /me@example.com|refresh|access/)
  assert.equal(describeChatGpt({}).signedIn, false)
})

test('maskSecret hides the middle of a key', () => {
  assert.equal(maskSecret('sk-ant-api03-abcdefghijklmnop'), 'sk-ant-…mnop')
  assert.equal(maskSecret('short'), '••••')
  assert.equal(maskSecret(undefined), null)
})
