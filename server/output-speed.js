// Approximate received text throughput, never a provider decoding benchmark.
export const OUTPUT_SPEED_META = 'agentDesk/outputSpeed'
export const SPEED_INTERVAL_MS = 300
const MIN_SPAN_MS = 1000

/** Additive even when a surrogate pair is split between chunks. */
export function estimateOutputTokens(text) {
  let tokens = 0
  for (const char of text) {
    const point = char.codePointAt(0)
    tokens += point <= 0x7f ? 0.25 : point >= 0xd800 && point <= 0xdfff ? 0.5 : 1
  }
  return tokens
}

/** One turn owner, but only the latest model response is measured/retained. */
export class OutputSpeedMeter {
  constructor({ onChange = () => {}, now = () => performance.now() } = {}) {
    this.onChange = onChange
    this.now = now
    this.state = 'paused'
    this.timer = null
    this.published = null
    this.firstAt = null
    this.lastAt = null
    this.tokens = 0
    this.lastRate = null
  }

  start() {
    if (this.state === 'done') return
    clearInterval(this.timer)
    this.timer = null
    this.firstAt = this.lastAt = null
    this.tokens = 0
    this.lastRate = null
    this.state = 'streaming'
    this.#publish(null, 'streaming')
  }

  push(text) {
    if (this.state === 'done' || typeof text !== 'string' || !text.length) return
    if (this.state !== 'streaming') this.start()
    const now = this.now()
    // The first batch has no observable generation interval; exclude it.
    if (this.firstAt === null) this.firstAt = now
    else this.tokens += estimateOutputTokens(text)
    this.lastAt = now
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), SPEED_INTERVAL_MS)
      this.timer.unref?.()
    }
  }

  #rate(until) {
    // Eligibility is based on actual receive times, not a timer aging a burst.
    if (this.firstAt === null || this.lastAt - this.firstAt < MIN_SPAN_MS) return null
    return this.tokens * 1000 / (until - this.firstAt)
  }

  tick() {
    if (this.state !== 'streaming' || this.lastAt === null) return
    // Include silence within this response. An arbitrary idle timeout cannot
    // distinguish slow generation from network buffering or a tool wait.
    this.#publish(this.#rate(this.now()), 'streaming')
  }

  pause({ discard = false } = {}) {
    if (this.state === 'done') return
    if (this.state === 'streaming') this.lastRate = this.#rate(this.lastAt)
    if (discard) this.lastRate = null
    clearInterval(this.timer)
    this.timer = null
    this.state = 'paused'
    this.#publish(null, 'paused') // Never show a previous response during tools.
  }

  finish() {
    if (this.state === 'done') return
    this.pause()
    this.state = 'done'
    this.#publish(this.lastRate, 'done')
  }

  #publish(rate, state) {
    const snapshot = Number.isFinite(rate) && rate > 0
      ? { tokensPerSecond: Math.max(0.1, Math.round(rate * 10) / 10), state, estimated: true } : null
    if (JSON.stringify(snapshot) === JSON.stringify(this.published)) return
    this.published = snapshot
    this.onChange(snapshot)
  }
}
