import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ptcDataBindings, ptcDataParameters } from '../server/ptc-data.js'

const runtime = { language: 'typescript' }
const get = args => ptcDataBindings(args, runtime)[0].functions.get

test('PTC data is an opt-in JSON binding and leaves code and omitted-data calls unchanged', async () => {
  assert.deepEqual(ptcDataBindings({ code: 'const input = 42; return input;' }, runtime), [])
  assert.deepEqual(ptcDataParameters({ language: 'python' }), {})
  assert.ok(ptcDataParameters(runtime).data)
  assert.throws(() => ptcDataBindings({ data: 'literal' }, { language: 'python' }), /TypeScript/)
  for (const value of [null, false, 0, 'quotes " backticks ` ${notExecuted}', [1, { two: '日本語' }]]) {
    assert.deepEqual(await get({ data: value })({}), value)
  }
})

test('PTC input snapshots lossless JSON, rejects invalid data, and does not share mutations', async () => {
  const data = JSON.parse('{"__proto__":{"literal":true},"files":[{"content":"source"}]}')
  const read = get({ data })
  data.files[0].content = 'mutated caller'
  const first = await read({})
  assert.equal(first.files[0].content, 'source')
  assert.ok(Object.hasOwn(first, '__proto__'))
  first.files[0].content = 'mutated result'
  assert.equal((await read({})).files[0].content, 'source')
  const cycle = {}; cycle.self = cycle
  for (const data of [undefined, NaN, Infinity, 1n, () => 0, { x: undefined }, cycle]) {
    assert.throws(() => get({ data }), /lossless JSON/)
  }
  for (const args of [undefined, {}, []]) assert.equal((await read(args)).files[0].content, 'source')
  for (const args of [null, [1], 'literal', { unexpected: true }]) {
    await assert.rejects(read(args), /input.get\(\)/)
  }
})
