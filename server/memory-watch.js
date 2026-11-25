// Logs the heap size once at start and then each time it reaches a new high
// (from 1 GB, in 512 MB steps). A server that runs out of memory stops with
// only Node's last words, so this leaves a trail of when and how fast it grew,
// and what was loaded.
import v8 from 'node:v8'

const mb = (bytes) => `${Math.round(bytes / 1024 ** 2)} MB`

export function watchMemory(log, { intervalMs = 60_000, fromBytes = 1024 ** 3, stepBytes = 512 * 1024 ** 2, details = () => '', usage = () => process.memoryUsage() } = {}) {
  let next = fromBytes
  const write = (label, heapUsed, rss) => {
    let extra = ''
    try { extra = details() } catch (error) { extra = `details failed: ${error.message}` }
    log(`memory${label}: heap ${mb(heapUsed)} of ${mb(v8.getHeapStatistics().heap_size_limit)}, rss ${mb(rss)}${extra ? ` · ${extra}` : ''}`)
  }
  const check = () => {
    const { heapUsed, rss } = usage()
    if (heapUsed < next) return
    write('', heapUsed, rss)
    while (next <= heapUsed) next += stepBytes
  }
  const { heapUsed, rss } = usage()
  write(' at start', heapUsed, rss)
  while (next <= heapUsed) next += stepBytes
  const timer = setInterval(check, intervalMs)
  timer.unref?.()
  return { check, stop: () => clearInterval(timer) }
}
