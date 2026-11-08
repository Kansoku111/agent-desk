import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import { ptcDataExamples, ptcGuidance, withPtcGuidance, PTC_GUIDANCE_SECTION } from '../server/ptc-guidance.js'

test('complete data examples are valid calls, follow available tools, and match the usage guide', async () => {
  const parse = text => [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map(x => JSON.parse(x[1]))
  const examples = parse(ptcDataExamples(['edit', 'write', 'todo_write'].map(name => ({ name }))))
  assert.equal(examples.length, 2)
  assert.equal(ptcDataExamples([{ name: 'edit' }], 'script'), '')
  for (const call of examples) {
    assert.deepEqual(Object.keys(call), ['code', 'description', 'data'])
    assert.ok(call.code && call.description)
    assert.ok(call.code.includes('await input.get()'))
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    assert.doesNotThrow(() => new AsyncFunction('tools', 'input', call.code))
  }
  assert.ok(examples[0].code.includes('tools.edit'))
  assert.ok(examples[1].code.includes('tools.write') && examples[1].code.includes('tools.todo_write'))
  assert.ok(examples[1].data.todos.every(todo => todo.status !== 'completed'))
  assert.equal(ptcDataExamples([{ name: 'read' }, { name: 'glob' }]), '')
  assert.equal(ptcDataExamples([{ name: 'write' }]), '')
  assert.equal(parse(ptcDataExamples([{ name: 'edit' }])).length, 1)
  const doc = await fs.readFile(new URL('../docs/ptc.md', import.meta.url), 'utf8')
  assert.deepEqual(parse(doc), examples)
})

test('guidance follows the runtime language and currently exposed capabilities', () => {
  const tools = ['edit', 'write', 'todo_write'].map(name => ({ name }))
  const runtime = { language: 'typescript', programFormat: 'function-body' }
  const text = ptcGuidance(tools, runtime)
  assert.equal(text.split('Every `run_code` call costs a model round trip.').length, 2)
  assert.match(text, /Complete run_code argument objects/)
  assert.equal(ptcGuidance(tools, { language: 'python', programFormat: 'script' }), '')
  assert.doesNotMatch(ptcGuidance(tools, { ...runtime, programFormat: 'script' }), /Complete run_code argument objects/)
  assert.doesNotMatch(ptcGuidance([{ name: 'read' }], runtime), /"code":/)
})

test('the public executor adapter adds a literal section without changing dispatch or schemas', async () => {
  const sections = [{ name: 'upstream', order: 5000, text: 'unchanged' }]
  const model = { schemas: [{ name: 'run_code' }], knownNames: ['run_code'] }
  const input = { calls: [] }, outcome = { results: [], concluded: false }
  const executor = { sections,
    describe(tools) { assert.equal(this, executor); assert.deepEqual(tools, [{ name: 'read' }]); return model },
    execute(value) { assert.equal(this, executor); assert.equal(value, input); return Promise.resolve(outcome) },
  }
  const ctx = { get(name) { assert.equal(name, 'ptcRuntime'); return this.ptcRuntime }, systemPrompt: { getSectionOrder(name) { assert.equal(name, 'TOOLS_SDK'); return 5000 } }, ptcRuntime: { language: 'typescript', programFormat: 'function-body' } }
  const wrapped = withPtcGuidance(executor, ctx)
  assert.equal(executor.sections, sections)
  assert.equal(executor.sections.length, 1)
  assert.equal(wrapped.sections[0], sections[0])
  assert.equal(wrapped.describe([{ name: 'read' }]), model)
  assert.equal(await wrapped.execute(input), outcome)
  const guide = wrapped.sections[1]
  assert.equal(guide.name, PTC_GUIDANCE_SECTION)
  assert.equal(guide.order, 5001)
  assert.equal(guide.interpolate, false)
  assert.doesNotMatch(guide.text([{ name: 'read' }]), /"code":/)
  assert.match(guide.text([{ name: 'edit' }]), /tools.edit/)
  ctx.ptcRuntime = { language: 'python', programFormat: 'script' }
  assert.equal(guide.text([{ name: 'edit' }]), '')
})
