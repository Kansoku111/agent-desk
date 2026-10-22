import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { mergeClaudeLimits, normalizeClaudeLimits, readSavedClaudeLimits } from '../server/claude-limits.js'
import { ClaudeRunner } from '../server/claude-runner.js'

// What Claude Code 2.1.307 wrote at the end of a turn.
const INFO = {
  status: 'allowed', resetsAt: 1792640400, rateLimitType: 'five_hour', overageStatus: 'rejected', isUsingOverage: false,
  unifiedWindows: {
    five_hour: { utilization: 0.01, resetsAt: 1792640400 },
    seven_day: { utilization: 0.69, resetsAt: 1792929600 },
  },
}

test('the five-hour and weekly windows come out as percentages with reset times in milliseconds', () => {
  const limits = normalizeClaudeLimits(INFO, 42)
  assert.equal(limits.status, 'ok')
  assert.equal(limits.fetchedAt, 42)
  assert.deepEqual(limits.windows, [
    { label: '5時間', seconds: 18000, usedPercent: 1, resetAt: 1792640400_000 },
    { label: '週間', seconds: 604800, usedPercent: 69, resetAt: 1792929600_000 },
  ])
})

test('an event without usage, or with nonsense in it, gives nothing to show', () => {
  assert.equal(normalizeClaudeLimits(undefined), null)
  assert.equal(normalizeClaudeLimits({ status: 'allowed', resetsAt: 1, rateLimitType: 'five_hour' }), null)
  assert.equal(normalizeClaudeLimits({ unifiedWindows: { five_hour: { utilization: 'lots' } } }), null)
  const clamped = normalizeClaudeLimits({ unifiedWindows: { seven_day: { utilization: 1.4, resetsAt: null } } })
  assert.deepEqual(clamped.windows, [{ label: '週間', seconds: 604800, usedPercent: 100, resetAt: null }])
})

test('a newer reading replaces its windows and keeps the ones it does not carry', () => {
  const before = normalizeClaudeLimits(INFO, 1)
  const after = normalizeClaudeLimits({ unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 1792650000 } } }, 2)
  const merged = mergeClaudeLimits(before, after)
  assert.equal(merged.fetchedAt, 2)
  assert.deepEqual(merged.windows.map((window) => [window.seconds, window.usedPercent]), [[18000, 50], [604800, 69]])
  assert.equal(mergeClaudeLimits(null, after), after)
})

test('a saved reading is trusted only when it still has the shape of one', () => {
  const limits = normalizeClaudeLimits(INFO, 1)
  assert.deepEqual(readSavedClaudeLimits(JSON.parse(JSON.stringify(limits))), limits)
  assert.equal(readSavedClaudeLimits(null), null)
  assert.equal(readSavedClaudeLimits({ status: 'ok', windows: [{}], fetchedAt: 1 }), null)
})

test('a team run reports the limits Claude Code printed, and nothing else is asked of it', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-limits-'))
  const spawned = []
  const spawn = (file, args) => {
    const proc = Object.assign(new EventEmitter(), {
      file, args, pid: 5000, exitCode: null,
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill() {},
    })
    spawned.push(proc)
    return proc
  }
  const runner = await new ClaudeRunner({ dir, spawn, findClaude: () => '/usr/bin/claude', platform: 'linux' }).load()
  t.after(() => runner.shutdown())
  const readings = []
  runner.on('rateLimits', (reading) => readings.push(reading))
  const session = await runner.create({ workspace: '/work' })
  const finished = new Promise((resolve) => runner.once('finished', resolve))
  runner.run(session.id, 'x')
  const [proc] = spawned
  const write = (event) => proc.stdout.write(`${JSON.stringify(event)}\n`)
  write({ type: 'system', subtype: 'init', model: 'claude-haiku-5-5', apiKeySource: 'none' })
  write({ type: 'rate_limit_event', rate_limit_info: INFO })
  write({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })
  write({ type: 'result', subtype: 'success', is_error: false, result: 'ok', permission_denials: [] })
  proc.exitCode = 0
  proc.stdout.end()
  proc.stderr.end()
  setImmediate(() => proc.emit('close', 0))
  await finished
  assert.equal(readings.length, 1)
  assert.deepEqual(readings[0].windows.map((window) => window.usedPercent), [1, 69])
  assert.equal(spawned.length, 1)
  // The event is not a turn item: the turn holds only what Claude said and did.
  assert.deepEqual(runner.turns(session.id)[0].items, [])
})
