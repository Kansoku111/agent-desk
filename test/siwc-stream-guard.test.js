import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SiwcArgumentGuard, SIWC_ARGUMENT_REPEAT, SIWC_ARGUMENT_REPEAT_WINDOW, SIWC_ARGUMENT_RUNAWAY, SIWC_ARGUMENT_WHITESPACE_LIMIT } from '../server/siwc-stream-guard.js'
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

// Stream in small pieces, as the provider does, so the window is checked mid-string.
const stream = (guard, text, id) => { for (let at = 0; at < text.length; at += 100) guard.observe(delta(text.slice(at, at + 100), id)) }

test('a short unit repeated for a whole window stops function and custom calls', () => {
  // The observed loop after a broken data array: `}]} (sic) ` for 181k characters.
  const loop = '{"code":"x","data":[{"a":"b",' + '}]} (sic) '.repeat(SIWC_ARGUMENT_REPEAT_WINDOW / 4)
  assert.throws(() => stream(new SiwcArgumentGuard(), loop), error => error.code === SIWC_ARGUMENT_REPEAT)
  const custom = new SiwcArgumentGuard()
  assert.throws(() => custom.observe({ type: 'response.custom_tool_call_input.delta', item_id: 'c', delta: '// x\n' + 'return 1;'.repeat(SIWC_ARGUMENT_REPEAT_WINDOW / 4) }), error => error.code === SIWC_ARGUMENT_REPEAT)
  // Letters that only look like escapes are a loop: `nr` is not `\n\r`.
  assert.throws(() => stream(new SiwcArgumentGuard(), JSON.stringify({ code: 'nr'.repeat(SIWC_ARGUMENT_REPEAT_WINDOW) })), error => error.code === SIWC_ARGUMENT_REPEAT)
})

test('a loop that slips one character every few thousand is still stopped within a window', () => {
  // The observed shape: `\u001b[0m` written out in a JSON string, now and then as `\u001b[0b`.
  const unit = String.raw`\u001b[0m`, slip = String.raw`\u001b[0b`
  const loop = '{"code":"throw new Error(' + Array.from({ length: SIWC_ARGUMENT_REPEAT_WINDOW }, (_, i) => i % 800 === 799 ? slip : unit).join('')
  const guard = new SiwcArgumentGuard()
  let seen = 0
  assert.throws(() => { for (let at = 0; at < loop.length; at += 100) { seen = at + 100; guard.observe(delta(loop.slice(at, at + 100))) } }, error => error.code === SIWC_ARGUMENT_REPEAT)
  assert.ok(seen <= SIWC_ARGUMENT_REPEAT_WINDOW + 8192, `stopped after ${seen} characters`)
})

test('long blank-line, single-character, varied and shorter repetitive content is not a repetition runaway', () => {
  const guard = new SiwcArgumentGuard()
  // Escaped blank lines and tab/space/CRLF runs, whichever character the window starts on.
  stream(guard, JSON.stringify({ code: '\n'.repeat(SIWC_ARGUMENT_REPEAT_WINDOW * 2) + '\t \r\n'.repeat(SIWC_ARGUMENT_REPEAT_WINDOW / 2) }), 'blank')
  stream(guard, JSON.stringify({ code: '='.repeat(SIWC_ARGUMENT_REPEAT_WINDOW * 2) }), 'rule')
  const varied = Array.from({ length: 4000 }, (_, i) => `line ${i};`).join('\n')
  stream(guard, JSON.stringify({ code: varied }), 'varied')
  guard.observe({ type: 'response.custom_tool_call_input.delta', item_id: 'c', delta: varied })
  // A valid call with a long repetitive fixture that is shorter than the window.
  stream(guard, JSON.stringify({ code: varied + 'ab'.repeat(SIWC_ARGUMENT_REPEAT_WINDOW / 2 - 1000) + varied }), 'fixture')
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
