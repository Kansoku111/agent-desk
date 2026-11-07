// Preserve pi-ai's reasoning subset when dsh maps terminal usage. Installed packages stay untouched.
const BEFORE = [
  'function mapUsage(usage) {',
  '\treturn {',
  '\t\tinputTokens: usage.input,',
  '\t\toutputTokens: usage.output,',
  '\t\ttotalTokens: usage.totalTokens,',
  '\t\t...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},',
  '\t\t...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}',
  '\t};',
  '}',
].join('\n')

// Some pi-ai routes coalesce an absent breakdown to zero. Preserve only a
// positive, valid subset so missing data is not recorded as a measured zero.
const AFTER = BEFORE.replace(
  '\t\t...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}',
  '\t\t...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {},\n'
  + '\t\t...Number.isSafeInteger(usage.reasoning) && Number.isSafeInteger(usage.output) && usage.reasoning > 0 && usage.reasoning <= usage.output ? { reasoningTokens: usage.reasoning } : {}',
)

/** Patch only the known upstream mapper; source drift is handled by the hook and update gate. */
export function patchReasoningUsageSource(source) {
  if (source.split(BEFORE).length !== 2) return null
  return source.replace(BEFORE, AFTER)
}
