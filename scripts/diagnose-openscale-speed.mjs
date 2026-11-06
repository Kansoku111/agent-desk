// Bounded standard-mode probes. Never print keys, prompts, or model output.
// Refuse to compete with a running OpenScale task on a one-slot plan.
import fs from 'node:fs/promises'
import WebSocket from 'ws'
import { appPaths } from '../server/paths.js'
import { CredentialStore, OPENSCALE_REF } from '../server/credentials.js'
import { openscaleRoute } from '../server/openscale.js'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'

const paths = appPaths()
const log = data => console.log(JSON.stringify(data))
const round = n => Math.round(n * 100) / 100
async function appState() {
  const info = JSON.parse(await fs.readFile(`${paths.home}/server.json`, 'utf8'))
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${info.port}/ws?t=${info.token}`, { origin: `http://127.0.0.1:${info.port}` })
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('state_timeout')) }, 5000)
    ws.on('error', () => { clearTimeout(timer); reject(new Error('state_unavailable')) })
    ws.on('message', raw => {
      const message = JSON.parse(String(raw))
      if (message.event !== 'hello') return
      clearTimeout(timer); ws.close(); resolve(message.state)
    })
  })
}

try {
  const state = await appState()
  if (state.threads?.some(t => String(t.model).includes('"openscale"') && ['running', 'starting', 'restoring'].includes(t.status))) {
    log({ outcome: 'not_run', reason: 'openscale_task_running' }); process.exit(2)
  }
} catch {
  log({ outcome: 'not_run', reason: 'cannot_verify_app_idle' }); process.exit(2)
}
const key = (await new CredentialStore(paths.credentials).read()).refs[OPENSCALE_REF]
if (!key?.startsWith('sk-openscale-plan-')) {
  log({ outcome: 'not_run', reason: 'plan_key_required' }); process.exit(2)
}

const route = openscaleRoute(), entry = route.models[0]
const prompt = 'Explain how a bicycle works in approximately 300 English words. Do not use tools.'
for (const mode of ['direct-messages', 'pi-ai-messages']) {
  // Recheck between probes: the user's work takes priority over diagnostics.
  const state = await appState()
  if (state.threads?.some(t => String(t.model).includes('"openscale"') && t.status === 'running')) {
    log({ outcome: 'not_run', reason: 'openscale_task_running', mode }); break
  }
  const started = performance.now(), controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)
  let first = null, last = null, tokens = null, chunks = 0
  const mark = () => { const n = performance.now(); first ??= n; last = n; chunks++ }
  log({ mode, phase: 'starting', model: entry.id, effort: 'low', maxTokens: 512 })
  try {
    if (mode === 'direct-messages') {
      const response = await fetch(`${route.baseURL}/v1/messages`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: entry.id, max_tokens: 512, stream: true, thinking: { type: 'adaptive' }, output_config: { effort: 'low' }, messages: [{ role: 'user', content: prompt }] }),
      })
      log({ mode, phase: 'headers', status: response.status, elapsedMs: round(performance.now() - started) })
      if (!response.ok) { await response.body?.cancel(); continue }
      let buffer = ''
      for await (const bytes of response.body) {
        buffer += new TextDecoder().decode(bytes)
        let end
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1)
          if (!line.startsWith('data:')) continue
          let event; try { event = JSON.parse(line.slice(5)) } catch { continue }
          if (event.type === 'content_block_delta' && (event.delta?.text || event.delta?.thinking)) mark()
          if (event.usage?.output_tokens != null) tokens = event.usage.output_tokens
          if (event.type === 'error') throw new Error('stream_error')
        }
      }
    } else {
      const model = { ...entry, api: route.api, provider: 'openscale', baseUrl: route.baseURL, reasoning: true,
        compat: route.compat, thinkingLevelMap: { low: 'low', high: 'high' }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
      const stream = anthropicMessagesApi().streamSimple(model, { messages: [{ role: 'user', content: prompt, timestamp: Date.now() }] }, { apiKey: key, reasoning: 'low', maxTokens: 512, maxRetries: 0, signal: controller.signal })
      for await (const event of stream) {
        if (event.type === 'text_delta' || event.type === 'thinking_delta') mark()
        if (event.type === 'done') tokens = event.message.usage.output
        if (event.type === 'error') throw new Error('sdk_error')
      }
    }
    const seconds = first === null || last === null ? null : (last - first) / 1000
    log({ mode, outcome: 'completed', outputTokens: tokens, chunks, firstDeltaMs: first === null ? null : round(first - started), receiveSeconds: seconds === null ? null : round(seconds), tokensPerSecond: seconds > 1 && tokens ? round(tokens / seconds) : null })
  } catch (error) {
    log({ mode, outcome: controller.signal.aborted ? 'timeout' : 'error', errorName: error.name, chunks, elapsedMs: round(performance.now() - started) })
  } finally { clearTimeout(timeout) }
}
