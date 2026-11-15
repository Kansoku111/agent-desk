// Retention is a preference, not a reason to skip pressure relief forever.
// A large imported first message can consume the entire retained-tail budget.
// In that case condense the smallest balanced prefix and keep the largest
// possible recent tail. Transactions, summaries and persistence stay upstream.
export function patchCompactionSelectorSource(source) {
  const start = source.indexOf('function selectCompactableRange(session, measurement, retainTokens) {')
  const end = source.indexOf('\n}', start)
  if (start < 0 || end < 0) return null
  const original = source.slice(start, end + 2)
  const anchor = '\tconst firstIdx = systemHead(session, surfaceNodes[0]) === void 0 ? 0 : 1;'
  const skip = '\tif (keepFromIdx <= firstIdx) return null;'
  if (!original.includes(anchor) || original.split(skip).length !== 3
    || !original.includes('toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx])')) return null
  const fallback = [
    anchor,
    '\t// Keep at least one recent node and never cut a tool-call/result pair.',
    '\tconst fallbackRange = () => {',
    '\t\tfor (let index = firstIdx + 1; index < surfaceNodes.length; index += 1) {',
    '\t\t\tif (toolPairingBalancedBefore(session, surfaceNodes[index])) return {',
    '\t\t\t\tstart: surfaceNodes[firstIdx], end: surfaceNodes[index - 1]',
    '\t\t\t};',
    '\t\t}',
    '\t\treturn null;',
    '\t};',
  ].join('\n')
  const patched = original.replace(anchor, fallback).replaceAll(skip, '\tif (keepFromIdx <= firstIdx) return fallbackRange();')
  return source.slice(0, start) + patched + source.slice(end + 2)
}

// dsh's summary call is built to be a prefix of the last routed request so its
// input is served from the prompt cache, but it leaves out the request's
// reasoning effort. On the official ChatGPT route the effort is part of the
// cached prefix (measured 2026-11-15: switching low and medium between two
// identical requests drops the hit from 6.5k to 0), and the omitted effort is
// sent as the route's lowest, so every automatic summary of a max or high task
// paid its whole ~100k input uncached. Reuse the effort of the request the
// summary continues, only when the summary goes to that same model.
export function patchSummaryEffortSource(source) {
  const anchor = '\t\tmaxTokens: config.maxTokens,\n\t\tsessionId: agent.session.id,\n\t\tpurpose: "compaction",'
  const head = 'async function summarizeWithLlm(ctx, config, input, agent, signal) {'
  const start = source.indexOf(head)
  const end = source.indexOf('\n}', start)
  if (start < 0 || end < 0) return null
  const body = source.slice(start, end)
  if (body.split(anchor).length !== 2 || !body.includes('const latest = agent.session.requestHeader()?.config;')
    || !body.includes('const target = configured ?? latest ?? agentTarget;')) return null
  const patched = body.replace(anchor, [
    '\t\tmaxTokens: config.maxTokens,',
    '\t\t...target === latest && latest.reasoningEffort !== void 0 ? { reasoningEffort: latest.reasoningEffort } : {},',
    '\t\tsessionId: agent.session.id,',
    '\t\tpurpose: "compaction",',
  ].join('\n'))
  return source.slice(0, start) + patched + source.slice(end)
}

export function patchCompactionSource(source) {
  const selected = patchCompactionSelectorSource(source)
  return selected && patchSummaryEffortSource(selected)
}
