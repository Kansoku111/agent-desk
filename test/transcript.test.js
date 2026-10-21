import assert from 'node:assert/strict'
import test from 'node:test'
import { applyUpdate, clip, newTurn, parseConfigOptions, settleTurn, titleFrom } from '../server/transcript.js'

const turn = () => newTurn({ id: 't1', text: 'hello', now: 1 })

test('agent and thought chunks group by message id', () => {
  const t = turn()
  applyUpdate(t, { sessionUpdate: 'agent_thought_chunk', messageId: 'm0', content: { type: 'text', text: 'think' } })
  applyUpdate(t, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'Hel' } })
  applyUpdate(t, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'lo' } })
  applyUpdate(t, { sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'Bye' } })
  assert.deepEqual(t.items.map((item) => [item.type, item.text]), [['thought', 'think'], ['agent', 'Hello'], ['agent', 'Bye']])
})

test('chunks without ids continue the previous item of the same type', () => {
  const t = turn()
  applyUpdate(t, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } })
  applyUpdate(t, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'b' } })
  assert.equal(t.items.length, 1)
  assert.equal(t.items[0].text, 'ab')
})

test('tool call lifecycle merges updates into one item', () => {
  const t = turn()
  applyUpdate(t, { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'pwsh', kind: 'other', status: 'in_progress', rawInput: { command: 'ls' } })
  applyUpdate(t, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'c1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'file.txt' } }],
  })
  assert.equal(t.items.length, 1)
  const [item] = t.items
  assert.equal(item.name, 'pwsh')
  assert.equal(item.status, 'completed')
  assert.deepEqual(item.input, { command: 'ls' })
  assert.equal(item.output, 'file.txt')
  assert.ok(item.endedAt)
})

test('an update for an unknown tool call creates the item', () => {
  const t = turn()
  applyUpdate(t, { sessionUpdate: 'tool_call_update', toolCallId: 'c9', status: 'failed', title: 'edit' })
  assert.equal(t.items[0].name, 'edit')
  assert.equal(t.items[0].status, 'failed')
})

test('usage and config updates are returned as side data', () => {
  const t = turn()
  assert.deepEqual(applyUpdate(t, { sessionUpdate: 'usage_update', used: 10, size: 100 }), { usage: { used: 10, size: 100 } })
  const configOptions = [{ id: 'model' }]
  assert.deepEqual(applyUpdate(t, { sessionUpdate: 'config_option_update', configOptions }), { configOptions })
  assert.equal(t.items.length, 0)
})

test('settling a turn closes open tool calls and pending approvals', () => {
  const t = turn()
  applyUpdate(t, { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'bash', status: 'in_progress' })
  t.items[0].permission = { requestId: 'r', options: [] }
  settleTurn(t, { status: 'cancelled', stopReason: 'cancelled', now: 5 })
  assert.equal(t.status, 'cancelled')
  assert.equal(t.endedAt, 5)
  assert.equal(t.items[0].status, 'failed')
  assert.equal(t.items[0].permission, undefined)
})

test('clip keeps head and tail of long output', () => {
  const text = 'a'.repeat(100) + 'b'.repeat(100)
  const clipped = clip(text, 50)
  assert.ok(clipped.startsWith('a'.repeat(25)))
  assert.ok(clipped.endsWith('b'.repeat(25)))
  assert.match(clipped, /150 文字省略/)
  assert.equal(clip('short', 50), 'short')
})

test('titleFrom uses the first non-empty line', () => {
  assert.equal(titleFrom('\n  Fix the login bug\nmore'), 'Fix the login bug')
  assert.equal(titleFrom(''), '新しいタスク')
  assert.equal(titleFrom('x'.repeat(100), 10).length, 10)
})

test('parseConfigOptions flattens grouped models and hides dated snapshots', () => {
  const parsed = parseConfigOptions([
    {
      id: 'model',
      currentValue: '["anthropic","claude-sonnet-4-5"]',
      options: [
        {
          group: 'anthropic',
          name: 'anthropic',
          options: [
            { value: '["anthropic","claude-sonnet-4-5"]', name: 'Claude Sonnet 4.5 (latest)' },
            { value: '["anthropic","claude-sonnet-4-5-20250929"]', name: 'Claude Sonnet 4.5' },
          ],
        },
        { group: 'openai-codex', name: 'openai-codex', options: [{ value: '["openai-codex","gpt-5.5"]', name: 'GPT-5.5' }] },
      ],
    },
    { id: 'reasoning_effort', currentValue: '', options: [{ value: '', name: 'Provider default' }, { value: 'high', name: 'High' }] },
  ])
  assert.deepEqual(parsed.models.map((model) => `${model.provider}/${model.id}`), ['anthropic/claude-sonnet-4-5', 'openai-codex/gpt-5.5'])
  assert.equal(parsed.currentModel, '["anthropic","claude-sonnet-4-5"]')
  assert.deepEqual(parsed.efforts.map((effort) => effort.value), ['', 'high'])
})

test('carryoverText condenses earlier turns, newest kept within budget', async () => {
  const { carryoverText } = await import('../server/threads.js')
  const mk = (text, answer, tools = 0) => ({
    status: 'done',
    user: { text },
    items: [
      ...Array.from({ length: tools }, (_, i) => ({ type: 'tool', id: `c${i}` })),
      { type: 'agent', id: 'a', text: 'draft' },
      { type: 'agent', id: 'b', text: answer },
    ],
  })
  const text = carryoverText([mk('first question', 'first answer', 2), mk('second question', 'second answer')])
  assert.match(text, /<previous_conversation>/)
  assert.ok(text.indexOf('first question') < text.indexOf('second question'), 'oldest first')
  assert.match(text, /Assistant: first answer/)
  assert.doesNotMatch(text, /draft/)
  assert.match(text, /used 2 tool calls/)
  const small = carryoverText([mk('old', 'x'.repeat(500)), mk('new', 'y')], 100)
  assert.match(small, /new/)
  assert.doesNotMatch(small, /User: old/)
  assert.equal(carryoverText([]), '')
})

test('nearestEffort keeps offered levels and moves missing ones to the closest', async () => {
  const { nearestEffort } = await import('../server/transcript.js')
  const levels = (...values) => values.map((value) => ({ value }))
  const codex = levels('', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')
  assert.equal(nearestEffort('max', codex), 'max')
  assert.equal(nearestEffort('', codex), 'medium')
  assert.equal(nearestEffort('max', levels('', 'low', 'medium', 'high', 'xhigh')), 'xhigh')
  assert.equal(nearestEffort('medium', levels('off', 'low', 'high', 'max')), 'low')
  assert.equal(nearestEffort('low', levels('high', 'max')), 'high')
  assert.equal(nearestEffort('high', levels('')), '')
})
