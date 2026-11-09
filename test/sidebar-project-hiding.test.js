import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'

const sidebar = await fs.readFile(new URL('../web/src/components/Sidebar.tsx', import.meta.url), 'utf8')

test('every project can be hidden without deleting sessions or folders', () => {
  assert.match(sidebar, /!group\.pc && \(\s*<MenuItem\s*icon=\{<X size=\{14\} \/>\}\s*label="一覧から外す"/)
  assert.doesNotMatch(sidebar, /!group\.pc && rows\.length === 0/)
  assert.match(sidebar, /act\('project.hide', \{ path: group.path \}\)/)
  assert.match(sidebar, /セッションとフォルダは削除されません/)
})

test('hidden projects stay out of normal, search, and archive results', () => {
  assert.match(sidebar, /if \(!pc && hiddenProjects\?\.includes\(path\)\) continue/)
  assert.match(sidebar, /\[threads, terminals, ab, codex, workspaces, hiddenProjects, myPc, names, colors, needle, archived\]/)
})
