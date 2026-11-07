// For the two context-capped managed routes, contextWindow is also the user's
// compaction budget. A successful provider response above that soft budget is
// not proof of provider overflow. Keep the real error and zero-output length
// checks, and leave silent-overflow detection on other routes unchanged.
export function patchContextOverflowSource(source) {
  const anchor = 'function mapStopReason(message, contextWindow) {\n\tconst piAiOverflow = isContextOverflow(message, contextWindow);'
  if (source.split(anchor).length !== 2) return null
  return source.replace(anchor, [
    'function mapStopReason(message, contextWindow) {',
    '\tconst completedManagedResponse = message.stopReason === "stop" && (message.provider === "openai-codex" || message.provider === "anthropic");',
    '\tconst piAiOverflow = isContextOverflow(message, completedManagedResponse ? undefined : contextWindow);',
  ].join('\n'))
}
