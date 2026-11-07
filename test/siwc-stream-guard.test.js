import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SiwcArgumentGuard, SIWC_ARGUMENT_RUNAWAY, SIWC_ARGUMENT_WHITESPACE_LIMIT } from '../server/siwc-stream-guard.js'
import { requireCompleted } from '../server/siwc-request.js'

const delta = (text, id = 'call') => ({ type: 'response.function_call_arguments.delta', item_id: id, delta: text })
const sse = event => 'data: ' + JSON.stringify(event) + '\n\n'

test('argument padding is bounded across chunks and independent calls', () => {
  const guard = new SiwcArgumentGuard()
  guard.observe(delta('{'))
  guard.observe(delta(' '.repeat(SIWC_ARGUMENT_WHITESPACE_LIMIT), 'other'))
  guard.observe(delta(' '.repeat(SIWC_ARGUMENT_WHITESPACE_LIMIT)))
  assert.throws(() => guard.observe(delta(' ')), error => error.code === SIWC_ARGUMENT_RUNAWAY)
})

test('code strings, escaped quotes and ordinary formatted JSON are preserved', async () => {
  const event = delta(JSON.stringify({ code: '\"' + '\n'.repeat(SIWC_ARGUMENT_WHITESPACE_LIMIT * 2) + '\\' }))
  const guard = new SiwcArgumentGuard()
  for (const char of event.delta) guard.observe(delta(char))
  const formatted = '{' + ' '.repeat(SIWC_ARGUMENT_WHITESPACE_LIMIT) + '\"code\":' + ' '.repeat(SIWC_ARGUMENT_WHITESPACE_LIMIT) + '\"ok\"}'
  guard.observe(delta(formatted, 'formatted'))
  const wire = sse(event) + sse({ type: 'response.completed' })
  assert.equal(await requireCompleted(new Response(wire)).text(), wire)
})

test('completed calls release their padding state and custom calls are not parsed as JSON', () => {
  const guard = new SiwcArgumentGuard()
  guard.observe(delta(' '.repeat(SIWC_ARGUMENT_WHITESPACE_LIMIT)))
  guard.observe({ type: 'response.function_call_arguments.done', item_id: 'call' })
  guard.observe(delta(' '))
  guard.observe({ type: 'response.custom_tool_call_input.delta', delta: ' '.repeat(SIWC_ARGUMENT_WHITESPACE_LIMIT * 2) })
  guard.observe({ type: 'response.function_call_arguments.delta', delta: null })
})

test('a runaway SSE stream fails terminally and cancels its upstream reader', { timeout: 3000 }, async () => {
  const cancelled = Promise.withResolvers()
  const encoder = new TextEncoder()
  const bytes = encoder.encode(sse(delta('{')) + sse(delta(' '.repeat(SIWC_ARGUMENT_WHITESPACE_LIMIT + 1))))
  let offset = 0
  const source = new ReadableStream({
    pull(controller) {
      if (offset < bytes.length) { controller.enqueue(bytes.slice(offset, offset + 11)); offset += 11 }
      // It deliberately never closes, just like the observed provider stream.
    },
    cancel(reason) { cancelled.resolve(reason) },
  })
  const response = requireCompleted(new Response(source))
  await assert.rejects(response.text(), error => error.code === SIWC_ARGUMENT_RUNAWAY)
  assert.equal((await cancelled.promise).code, SIWC_ARGUMENT_RUNAWAY)
})
