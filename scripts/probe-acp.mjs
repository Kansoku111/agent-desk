// Dev diagnostic: boot `dsh --profile acp` and print what an ACP client sees.
// Usage: DSH_HOME=<home> node scripts/probe-acp.mjs [workspaceDir]
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dshBin = path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const cwd = path.resolve(process.argv[2] ?? root)
const child = spawn(process.execPath, [dshBin, '--profile', 'acp'], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
let stderr = ''
child.stderr.on('data', (d) => { stderr += d })
const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
const conn = new ClientSideConnection(() => ({
  async requestPermission(p) {
    console.log('PERMISSION', JSON.stringify(p).slice(0, 1500))
    const allow = process.env.PROBE_ALLOW && p.options.find((o) => o.kind === 'allow_once')
    return allow ? { outcome: { outcome: 'selected', optionId: allow.optionId } } : { outcome: { outcome: 'cancelled' } }
  },
  async sessionUpdate(n) { console.log('UPDATE', JSON.stringify(n.update).slice(0, Number(process.env.PROBE_W ?? 300))) },
}), stream)
const t = setTimeout(() => { console.log('TIMEOUT\n' + stderr.slice(-2000)); child.kill(); process.exit(1) }, 60000)
try {
  const init = await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
  console.log('INIT', JSON.stringify(init, null, 1).slice(0, 1500))
  const s = await conn.newSession({ cwd, mcpServers: [] })
  console.log('SESSION', JSON.stringify(s, null, 1).slice(0, 6000))
  if (process.env.PROBE_PROMPT) {
    const r = await conn.prompt({ sessionId: s.sessionId, prompt: [{ type: 'text', text: process.env.PROBE_PROMPT }] })
    console.log('PROMPT RESULT', JSON.stringify(r))
  }
  await conn.closeSession({ sessionId: s.sessionId }).catch((e) => console.log('close err', e.message))
} catch (e) {
  console.log('ERROR', e?.message ?? e, JSON.stringify(e?.data ?? '').slice(0, 800), '\nSTDERR:\n' + stderr.slice(-3000))
} finally { clearTimeout(t); child.stdin.end(); setTimeout(() => { child.kill(); process.exit(0) }, 3000) }
