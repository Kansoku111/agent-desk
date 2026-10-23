import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'

for (const [name, now, first] of [
  ['spring-forward', '2026-03-09T00:30:00-04:00', '2026-02-08'],
  ['fall-back', '2026-11-02T23:30:00-05:00', '2026-10-04'],
]) {
  test(`usage history includes 30 consecutive local calendar days across ${name}`, () => {
    const source = `
      import { summarizeHistory } from ${JSON.stringify(new URL('../server/usage-history.js', import.meta.url).href)}
      console.log(JSON.stringify(summarizeHistory({}, Date.parse(${JSON.stringify(now)})).daily.map(point => point.day)))
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8', timeout: 10000,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr)
    const expected = Array.from({ length: 30 }, (_, index) => new Date(Date.parse(`${first}T00:00:00Z`) + index * 86400000).toISOString().slice(0, 10))
    assert.deepEqual(JSON.parse(result.stdout), expected)
  })
}
