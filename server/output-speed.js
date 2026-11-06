// Live: approximate received text throughput. Settled: billed output over the
// receive span when the provider reports it. Never a provider decoding benchmark.
export const OUTPUT_SPEED_META = 'agentDesk/outputSpeed'
export const SPEED_INTERVAL_MS = 300
const MIN_SPAN_MS = 1000
// GPT thinking summaries are one short heading (22-77 characters, about 5-19
// tokens, in real GPT-6.1 Sol logs) after long hidden thinking. So few tokens
// over that silence read as "0.1 t/s" while the model is generating at 20+ t/s.
const MIN_VISIBLE_TOKENS = 25

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
    this.lastBasis = null
    this.responseAt = null
    this.billedRate = null
  }

  start() {
    if (this.state === 'done') return
    clearInterval(this.timer)
    this.timer = null
    this.firstAt = this.lastAt = null
    this.tokens = 0
    this.lastRate = null
    this.lastBasis = null
    this.responseAt = null
    this.billedRate = null
    this.state = 'streaming'
    this.#publish(null, 'streaming')
  }

  push(text) {
    if (this.state === 'done' || typeof text !== 'string' || !text.length) return
    if (this.state !== 'streaming') this.start()
    const now = this.now()
    this.responseAt ??= now
    // The first batch has no observable generation interval; exclude it.
    if (this.firstAt === null) this.firstAt = now
    else this.tokens += estimateOutputTokens(text)
    this.lastAt = now
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), SPEED_INTERVAL_MS)
      this.timer.unref?.()
    }
  }

  /**
   * Hidden thinking happens between blocks, so the live window restarts at each
   * one. Silence inside a block (network buffering, slow generation) still counts.
   */
  startBlock() {
    if (this.state === 'done') return
    if (this.state !== 'streaming') this.start()
    this.responseAt ??= this.now()
    this.firstAt = this.lastAt = null
    this.tokens = 0
    this.#publish(null, 'streaming')
  }

  /** Billed output includes hidden thinking and tool arguments, which text cannot show. */
  usage(outputTokens) {
    if (this.state !== 'streaming' || this.responseAt === null) return
    if (!Number.isFinite(outputTokens) || outputTokens <= 0) return
    const span = this.now() - this.responseAt
    if (span >= MIN_SPAN_MS) this.billedRate = outputTokens * 1000 / span
  }

  #rate(until) {
    // Eligibility is based on actual receive times, not a timer aging a burst.
    if (this.firstAt === null || this.lastAt - this.firstAt < MIN_SPAN_MS || this.tokens < MIN_VISIBLE_TOKENS) return null
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
    if (this.state === 'streaming') {
      this.lastRate = this.billedRate ?? this.#rate(this.lastAt)
      this.lastBasis = this.billedRate === null ? null : 'usage'
    }
    if (discard) this.lastRate = this.lastBasis = null
    clearInterval(this.timer)
    this.timer = null
    this.state = 'paused'
    this.#publish(null, 'paused') // Never show a previous response during tools.
  }

  finish() {
    if (this.state === 'done') return
    this.pause()
    this.state = 'done'
    this.#publish(this.lastRate, 'done', this.lastBasis)
  }

  #publish(rate, state, basis = null) {
    const snapshot = Number.isFinite(rate) && rate > 0
      ? { tokensPerSecond: Math.max(0.1, Math.round(rate * 10) / 10), state, estimated: true, ...(basis ? { basis } : {}) } : null
    if (JSON.stringify(snapshot) === JSON.stringify(this.published)) return
    this.published = snapshot
    this.onChange(snapshot)
  }
}
