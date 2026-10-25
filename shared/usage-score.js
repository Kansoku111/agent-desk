// A fixed API-price equivalent, not a bill or a subscription quota estimate.
export const USD_PER_POINT = 0.002

export const emptyScore = () => ({ points: 0, priced: 0, unpriced: 0 })

/** Missing usage is unknown, never free. An explicit empty score is known zero. */
export function addScores(...scores) {
  const total = emptyScore()
  for (const score of scores) {
    total.points += score?.points ?? 0
    total.priced += score?.priced ?? 0
    total.unpriced += score?.unpriced ?? 1
  }
  return total
}

/** All turns, including retries and reverted edits, still consumed resources. */
export function scoresUpTo(turns) {
  let total = emptyScore()
  return turns.map((turn) => {
    total = turn.totalScore ?? addScores(total, turn.usage?.score ?? (turn.status === 'running' ? emptyScore() : null))
    return total
  })
}

export function scoreFromUsd(usd) {
  return Number.isFinite(usd) && usd >= 0
    ? { points: usd / USD_PER_POINT, priced: 1, unpriced: 0 }
    : { points: 0, priced: 0, unpriced: 1 }
}

export function formatScore(score) {
  if (!score || (!score.priced && score.unpriced)) return '— pt'
  const value = !score.unpriced && score.points > 0 && score.points < 0.01 ? '<0.01'
    : score.points.toLocaleString('en-US', { maximumFractionDigits: 2, ...(score.unpriced ? { roundingMode: 'floor' } : {}) })
  return `${score.unpriced ? '≥ ' : ''}${value} pt`
}

export const SCORE_NOTE = 'セッション全体のAPI料金換算。1 pt = $0.002。実際の請求額やサブスク利用枠の消費ではありません。'
export const SCORE_PARTIAL_NOTE = '料金または使用量が不明な分は未算定です。'
