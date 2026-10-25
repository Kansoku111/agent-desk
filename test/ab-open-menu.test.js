import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'

test('AB header reuses the shared open menu, guarded from remote access', async () => {
  const code = await fs.readFile(new URL('../web/src/components/Ab.tsx', import.meta.url), 'utf8')
  assert.match(code, /import \{ OpenInMenu \} from '\.\/ThreadView'/)
  assert.match(code, /import \{[^}]*useRemote[^}]*\} from '\.\.\/store'/)
  const view = code.split('export function AbView(')[1]
  assert.match(view, /const remote = useRemote\(\)/)
  const header = view.split('<header className="ab-header">')[1].split('</header>')[0]
  assert.match(header, /\{!remote && <OpenInMenu workspace=\{run\.workspace\} \/>\}/)
  assert.ok(header.indexOf('<OpenInMenu') > header.indexOf('className="ab-phase"'), 'open menu sits after the phase')
  assert.ok(header.indexOf('<OpenInMenu') < header.indexOf('aria-label="ABを停止"'), 'open menu sits before stop and delete')
})
