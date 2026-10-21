import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Unit tests import single modules; this parses every server and script file,
// so an error only an entry point has (a duplicate import name) fails here, not at launch.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('every server and script file parses', () => {
  const files = ['server', 'scripts'].flatMap((dir) => fs.readdirSync(path.join(root, dir))
    .filter((name) => /\.m?js$/.test(name))
    .map((name) => path.join(root, dir, name)))
  assert.ok(files.length > 10)
  for (const file of files) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    } catch (error) {
      assert.fail(`${path.relative(root, file)}: ${String(error.stderr).trim()}`)
    }
  }
})
