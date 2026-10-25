// Starts isolated ACP runtimes only; never sends a model prompt or copies credentials.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { appPaths } from '../../server/paths.js'
import { writeHomePatch, writeAbPatches } from '../../server/dsh-config.js'
import { RuntimePool } from '../../server/runtime.js'
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-ab-runtime-'))
const paths = appPaths(home)
await fs.mkdir(paths.dshHome, { recursive: true })
await writeHomePatch(paths.homePatch, {})
await writeAbPatches(paths, {})
const pool = new RuntimePool({ paths, onUpdate: () => {}, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
try {
  for (const key of ['ab:lean', 'ab:research', 'ab:write', 'ab:write:danger-full-access']) {
    const runtime = await pool.get(key)
    console.log(key, runtime.state, runtime.agentInfo?.name)
    if (/error|failed|unknown.*plugin/i.test(runtime.stderr)) console.log(runtime.stderr)
  }
} finally {
  await pool.pause()
  // This temp directory is exclusively owned by this invocation.
  await fs.rm(home, { recursive: true, force: true })
}
