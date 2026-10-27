import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import { nextCheckId } from '../web/src/execution-checks.ts'
import { normalizeChecks } from '../server/execution.js'

// Bug audit (調査04 C1): adding a verification row after deleting an earlier one
// produced a second "check-2", so saving failed on the server's unique-ID rule.

test('an added verification row takes an ID that no row uses, after a deletion', () => {
  // Rows were check-1, check-2; the first row was deleted, leaving check-2.
  const remaining = [{ id: 'check-2', command: 'npm test' }]
  const added = nextCheckId(remaining)
  assert.equal(added, 'check-1')
  assert.doesNotThrow(() => normalizeChecks([...remaining, { id: added, command: 'npm run lint' }]))
})

test('an added row skips IDs that were typed by hand, including surrounding spaces', () => {
  assert.equal(nextCheckId([]), 'check-1')
  assert.equal(nextCheckId([{ id: 'check-1' }, { id: 'check-2' }]), 'check-3')
  assert.equal(nextCheckId([{ id: 'check-2' }, { id: 'check-1' }]), 'check-3')
  assert.equal(nextCheckId([{ id: ' check-1 ' }]), 'check-2')
  assert.equal(nextCheckId([{ id: 'lint' }]), 'check-1')
})

test('the server still rejects IDs that the user types as duplicates', () => {
  assert.throws(() => normalizeChecks([{ id: 'lint', command: 'a' }, { id: 'lint', command: 'b' }]), /重複/)
})

test('the add button uses the shared ID helper, not a row count', async () => {
  const code = await fs.readFile(new URL('../web/src/components/ExecutionSettings.tsx', import.meta.url), 'utf8')
  assert.match(code, /import \{ nextCheckId \} from '\.\.\/execution-checks'/)
  assert.match(code, /id: nextCheckId\(checks\)/)
  assert.doesNotMatch(code, /check-\$\{checks\.length \+ 1\}/)
})
