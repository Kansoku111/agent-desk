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

// Keep saved scores in their original unit; converting the display never reprices history.
export function formatEquivalentUsd(score) {
  if (!score || (!score.priced && score.unpriced)) return '—'
  const usd = score.points * USD_PER_POINT
  if (!score.unpriced && usd > 0 && usd < 0.000001) return '< $0.000001'
  const value = usd.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2,
    maximumFractionDigits: 6, ...(score.unpriced ? { roundingMode: 'floor' } : {}) })
  return `${score.unpriced ? '≥ ' : ''}${value}`
}

export const SCORE_NOTE = 'API料金換算の累計額（米ドル）。実際の請求額やサブスク利用枠の消費ではありません。'
export const SCORE_PARTIAL_NOTE = '料金または使用量が不明な分は未算定です。'
