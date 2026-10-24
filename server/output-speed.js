// Observed text throughput, not the provider's internal decoding speed. Never
// divide billed usage by these timings: it may include hidden reasoning/tools.
export const OUTPUT_SPEED_META = 'agentDesk/outputSpeed'
export const SPEED_INTERVAL_MS = 300
export const SPEED_IDLE_MS = 2000
const WINDOW_MS = 3000
const MIN_SPAN_MS = 500
const BUCKET_MS = 100

/** Cheap, deliberately approximate token weights. Additive across chunk splits. */
export function estimateOutputTokens(text) {
  let tokens = 0
  for (const char of text) {
    const point = char.codePointAt(0)
    tokens += point <= 0x7f ? 0.25 : point >= 0xd800 && point <= 0xdfff ? 0.5 : 1
  }
  return tokens
}

/** One per turn. Only the small published snapshot is stored/sent to the UI. */
export class OutputSpeedMeter {
  constructor({ onChange = () => {}, now = () => performance.now() } = {}) {
    this.onChange = onChange
    this.now = now
    this.samples = []
    this.tokens = 0
    this.elapsed = 0
    this.lastAt = null
    this.segmentTokens = 0
    this.lastRate = null
    this.state = 'paused'
    this.timer = null
    this.published = null
  }

  push(text) {
    if (this.state === 'done' || typeof text !== 'string' || !text.length) return
    const now = this.now()
    if (this.lastAt === null || now - this.lastAt >= SPEED_IDLE_MS) {
      // The first chunk has no known start time. Exclude its tokens rather than
      // inventing a generation interval (also makes a single buffered reply N/A).
      this.samples = [{ at: now, tokens: 0 }]
      this.segmentTokens = 0
    } else {
      const tokens = estimateOutputTokens(text)
      this.tokens += tokens
      this.elapsed += Math.max(0, now - this.lastAt)
      this.segmentTokens += tokens
      const sample = { at: now, tokens: this.segmentTokens }
      const last = this.samples.at(-1)
      if (this.samples.length > 1 && Math.floor(last.at / BUCKET_MS) === Math.floor(now / BUCKET_MS)) {
        this.samples[this.samples.length - 1] = sample
      } else this.samples.push(sample)
      // Keep one anchor at/before the rolling window. At most ~32 buckets.
      while (this.samples.length > 2 && this.samples[1].at <= now - WINDOW_MS) this.samples.shift()
    }
    this.lastAt = now
    this.state = 'streaming'
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), SPEED_INTERVAL_MS)
      this.timer.unref?.()
    }
  }

  tick() {
    if (this.state !== 'streaming') return
    if (this.now() - this.lastAt >= SPEED_IDLE_MS) return this.pause()
    const first = this.samples[0], last = this.samples.at(-1)
    if (last.at - first.at >= MIN_SPAN_MS) {
      this.lastRate = (last.tokens - first.tokens) * 1000 / (last.at - first.at)
      this.#publish(this.lastRate, 'streaming')
    } else this.#publish(null, 'streaming')
  }

  pause() {
    if (this.state === 'done') return
    // Capture the latest received samples before closing the segment. Waiting
    // after its last chunk never enters the denominator.
    const first = this.samples[0], last = this.samples.at(-1)
    if (first && last.at - first.at >= MIN_SPAN_MS) {
      this.lastRate = (last.tokens - first.tokens) * 1000 / (last.at - first.at)
    }
    clearInterval(this.timer)
    this.timer = null
    this.lastAt = null
    this.samples = []
    this.state = 'paused'
    this.#publish(this.lastRate, 'paused')
  }

  finish() {
    if (this.state === 'done') return
    this.pause()
    this.state = 'done'
    this.#publish(this.elapsed >= MIN_SPAN_MS ? this.tokens * 1000 / this.elapsed : null, 'done')
  }

  #publish(rate, state) {
    const snapshot = Number.isFinite(rate) && rate > 0
      ? { tokensPerSecond: Math.max(0.1, Math.round(rate * 10) / 10), state, estimated: true } : null
    if (JSON.stringify(snapshot) === JSON.stringify(this.published)) return
    this.published = snapshot
    this.onChange(snapshot)
  }
}
