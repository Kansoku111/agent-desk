import type { UsageScore } from '../types'
import { formatEquivalentUsd, SCORE_NOTE, SCORE_PARTIAL_NOTE } from '../../../shared/usage-score.js'

export function UsageCost({ score }: { score?: UsageScore | null }) {
  const partial = !score || score.unpriced > 0
  return <span className="usage-cost" title={`${SCORE_NOTE}${partial ? `\n${SCORE_PARTIAL_NOTE}` : ''}`}>
    API換算 {formatEquivalentUsd(score)}
  </span>
}
