// Checks that the installed dsh works the way Agent Desk uses it: the model
// catalog additions apply, `dsh --profile acp` boots with the app's dsh home,
// opens a session that lists models and accepts a model choice. Run it in a
// fresh process after installing a dsh release (docs/updating.md), so the new
// packages are the ones loaded here. Prints one JSON line; exit code 1 on
// failure.
import { createRequire } from 'node:module'
import { appPaths } from '../server/paths.js'
import { verifyDshCompatibility } from '../server/dsh-compatibility.js'
import { readJson } from '../server/json-file.js'
import { ensureModelCatalog } from '../server/model-catalog.js'
import { readFetchedCatalog } from '../server/model-updates.js'
import { AcpRuntime } from '../server/runtime.js'
import { parseConfigOptions } from '../server/transcript.js'

const require = createRequire(import.meta.url)
const paths = appPaths()
const report = (result) => console.log(JSON.stringify(result))

let runtime = null
const deadline = setTimeout(() => {
  report({ ok: false, error: 'dsh の動作確認が時間内に終わりませんでした' })
  process.exit(1)
}, 150_000)

try {
  const version = require('@deepseek-ai/dsh/package.json').version
  // Required even when ACP startup and model selection happen to work. The
  // ordinary runtime hooks only warn on drift, which is not an update success.
  const compatibility = await verifyDshCompatibility()
  const settings = await readJson(paths.settings, {})
  const fetched = settings.modelAutoUpdate === false ? null : await readFetchedCatalog(paths.home)
  const catalog = await ensureModelCatalog(settings.customModels ?? [], fetched)
  if (catalog.warnings.length) throw new Error(`model catalog: ${catalog.warnings.join('; ')}`)
  runtime = new AcpRuntime({
    mode: 'read-only',
    paths,
    onUpdate: () => {},
    onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  })
  await runtime.start()
  const session = await runtime.newSession(paths.runtimeCwd)
  const parsed = parseConfigOptions(session.configOptions ?? [])
  if (!parsed.models.length) throw new Error('dsh がモデルの一覧を返しませんでした')
  const model = parsed.currentModel ?? parsed.models[0].value
  const options = parseConfigOptions(await runtime.setOption(session.sessionId, 'model', model))
  if (options.currentModel !== model) throw new Error('dsh でモデルを選択できませんでした')
  await runtime.closeSession(session.sessionId).catch(() => {})
  report({ ok: true, version, models: parsed.models.length, compatibility, warnings: catalog.warnings })
  process.exitCode = 0
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  report({ ok: false, error: message.split('\n').slice(0, 6).join('\n') })
  process.exitCode = 1
} finally {
  clearTimeout(deadline)
  await runtime?.stop().catch(() => {})
}
