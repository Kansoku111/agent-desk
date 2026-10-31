// Do not treat HTTP 429 alone as an exhausted subscription: it also covers
// temporary per-minute throttling, for which changing billing routes is surprising.
export function isLeaderUsageLimit(error) {
  const text = typeof error === 'string' ? error : [error?.message, error?.detail].filter(Boolean).join('\n')
  return /subscription_sharing_usage_limit_exceeded|subscription sharing usage limit|usage_limit_reached|usage_limit_exceeded|you(?:'ve| have) hit your (?:usage )?limit/i.test(text)
}
