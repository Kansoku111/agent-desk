// Runs inside dsh. ACP's standard "chunks" are committed messages, not live
// deltas. Observe the root Agent's real transient stream, sending only scalar
// snapshots through standard empty-text ACP updates with extension metadata.
import { OutputSpeedMeter, OUTPUT_SPEED_META } from './output-speed.js'

const meters = new WeakMap()

export function beginOutputSpeed(record) {
  const meter = new OutputSpeedMeter({ onChange: (speed) => {
    record.outputTail = record.outputTail.then(() => record.notify({
      sessionId: record.agent.session.id,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' }, _meta: { [OUTPUT_SPEED_META]: speed } },
    })).catch(() => {}) // Metrics must never fail a model turn.
  } })
  meters.set(record, meter)
  return meter
}

export function observeOutputSpeed(record, frame) {
  const meter = record && meters.get(record)
  if (!meter || !frame) return
  if (frame.type === 'start' || frame.type === 'end') return meter.pause()
  if (frame.type !== 'chunk') return
  const chunk = frame.chunk
  if (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta') meter.push(chunk.text)
  else if (chunk?.type === 'tool-call-delta' || chunk?.type === 'finish'
    || (chunk?.type === 'block-start' && chunk.block?.type === 'tool-call')) meter.pause()
}

export async function finishOutputSpeed(record) {
  const meter = meters.get(record)
  meters.delete(record)
  meter?.finish()
  // Final average must arrive before the prompt response/new turn can start.
  await record.outputTail
}
