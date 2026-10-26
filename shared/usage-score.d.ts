export interface UsageScore { points: number; priced: number; unpriced: number }
export const USD_PER_POINT: number
export function emptyScore(): UsageScore
export function addScores(...scores: (UsageScore | null | undefined)[]): UsageScore
export function scoresUpTo(turns: { status: string; totalScore?: UsageScore; usage?: { score?: UsageScore } }[]): UsageScore[]
export function scoreFromUsd(usd: number | null | undefined): UsageScore
export function formatEquivalentUsd(score: UsageScore | null | undefined): string
export const SCORE_NOTE: string
export const SCORE_PARTIAL_NOTE: string
