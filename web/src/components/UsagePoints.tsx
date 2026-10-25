import type { UsageScore } from '../types'
import { formatScore, SCORE_NOTE, SCORE_PARTIAL_NOTE } from '../../../shared/usage-score.js'

export function UsagePoints({ score }: { score?: UsageScore | null }) {
  const partial = !score || score.unpriced > 0
  return <span className="usage-points" title={`${SCORE_NOTE}${partial ? `\n${SCORE_PARTIAL_NOTE}` : ''}`}>
    {formatScore(score)}
  </span>
}
