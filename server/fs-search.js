// Bounded stdout for dsh's file-search tools. Keep a head of complete records,
// terminate through the existing managed subprocess seam, and never reinterpret
// cancellation, stderr diagnostics or a genuine rg error as a successful search.
import { finished } from 'node:stream/promises'

export const SEARCH_MAX_BYTES = 1024 * 1024
export const SEARCH_MAX_RECORDS = { glob: 1000, grep: 5000 }

export function partialSearchText(body, shown, noun) {
  return [
    'Partial search: output limit reached; the search was stopped before completion. The total is unknown, and no complete result was saved.',
    'Narrow pattern, path, or include and search again. Do not infer that a file or match is absent from these partial results.',
    `Showing ${shown} retained ${noun}.`,
    body,
  ].filter(Boolean).join('\n\n')
}

export async function runBoundedSearch(ctx, exec, toolName, argv, rawOutputMaxBytes, graceMs, stderrMaxBytes, { resolveRgPath, SearchError, classifyRunFailure }) {
  const aborted = () => new SearchError(`${toolName} was aborted before completion (tool timeout or caller cancellation)`, 'SEARCH_ABORTED')
  if (exec.signal.aborted) throw aborted()
  const workdir = exec.agent === undefined ? process.cwd() : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
  let handle
  try {
    handle = ctx.subprocess.spawn({
      argv: [await resolveRgPath(), '--no-config', ...argv],
      cwd: workdir,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: stderrMaxBytes } },
      graceMs,
      signal: exec.signal,
    })
  } catch (error) {
    if (exec.signal.aborted) throw aborted()
    throw new SearchError(`${toolName} could not start its search command (ripgrep launch failed)`, 'SEARCH_FAILED', { cause: error })
  }

  const maxBytes = Math.min(rawOutputMaxBytes, SEARCH_MAX_BYTES)
  const maxRecords = SEARCH_MAX_RECORDS[toolName]
  const chunks = []
  let bytes = 0
  let records = 0
  let partial = false
  const collect = (chunk) => {
    if (partial) return // Continue draining the pipe while termination settles.
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    let end = Math.min(data.length, maxBytes - bytes)
    let start = 0
    while (start < end) {
      if (records === maxRecords) { end = start; break }
      const newline = data.indexOf(10, start)
      if (newline === -1 || newline >= end) break
      records++
      start = newline + 1
    }
    if (end) {
      chunks.push(Buffer.from(data.subarray(0, end)))
      bytes += end
    }
    if (end < data.length) {
      partial = true
      handle.terminate()
    }
  }

  let outcome
  try {
    if (!handle.stdout) throw new Error('search command produced no stdout pipe')
    handle.stdout.on('data', collect)
    ;[outcome] = await Promise.all([handle.done, finished(handle.stdout)])
  } catch (error) {
    handle.terminate()
    // Observe the provider outcome even when the stdout stream failed first.
    await handle.done.catch(() => {})
    if (exec.signal.aborted) throw aborted()
    throw new SearchError(`${toolName} subprocess failed before reporting an outcome (ripgrep provider failure)`, 'SEARCH_FAILED', { cause: error })
  } finally {
    handle.stdout?.off('data', collect)
  }
  if (exec.signal.aborted) throw aborted()
  const stderr = handle.collected.stderr?.readFrom(0)
  if (!stderr) throw new SearchError(`${toolName} search command produced no collected stderr stream`, 'SEARCH_FAILED')
  // Windows termination can report exit 1; POSIX reports SIGTERM/SIGKILL.
  // Only the tool's own output-limit termination may produce a partial success.
  if (partial && stderr.text.trim()) throw classifyRunFailure(toolName, outcome.exitCode, stderr.text, stderr.lossy)
  if (outcome.exitCode !== null && outcome.exitCode !== 0 && outcome.exitCode !== 1) {
    throw classifyRunFailure(toolName, outcome.exitCode, stderr.text, stderr.lossy)
  }
  if ((outcome.signal !== null || outcome.exitCode === null)
    && !(partial && ['SIGTERM', 'SIGKILL'].includes(outcome.signal))) {
    throw new SearchError(`${toolName} search command was killed by signal ${outcome.signal ?? '(unknown)'}`, 'SEARCH_FAILED')
  }
  let output = Buffer.concat(chunks, bytes)
  // A byte cutoff can bisect UTF-8 or an rg JSON record. Never parse that tail.
  if (partial) output = output.subarray(0, output.lastIndexOf(10) + 1)
  return { stdout: output.toString('utf8'), noMatches: !partial && outcome.exitCode === 1, workdir, partial }
}
