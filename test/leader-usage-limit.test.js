import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isLeaderUsageLimit } from '../server/leader-usage-limit.js'

test('only explicit usage exhaustion triggers leader fallback', () => {
  for (const error of ['subscription_sharing_usage_limit_exceeded', "You've hit your limit", { detail: 'usage_limit_reached' }]) assert.equal(isLeaderUsageLimit(error), true)
  for (const error of ['429 rate limit', '利用上限に達しました。', 'requests per minute limit exceeded', '503 overloaded', '401 authentication failed', '', null]) assert.equal(isLeaderUsageLimit(error), false)
})
