#!/usr/bin/env node
import { abImages, assertAbImageModels } from './ab-images.js'
// Agent Desk server: serves the UI, owns the dsh ACP runtimes, and talks to
// the UI over one authenticated WebSocket. Binds to 127.0.0.1, plus this PC's
// Tailscale addresses when remote access (phones) is turned on.
import { randomBytes, createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Catalog } from './catalog.js'
import { codeStamp, uiBuild } from './code-stamp.js'
import { ChatGptLogin } from './chatgpt-login.js'
import { Checkpoints } from './checkpoints.js'
import {
  ANTHROPIC_ADMIN_REF, ANTHROPIC_REF, CredentialStore, DEEPSEEK_REF, describeChatGpt, LOCAL_LLM_REF, maskSecret, OPENCODE_GO_REF,
} from './credentials.js'
import { SUBAGENT_TOOLS, contextOverrides, shippedPersona, WEB_SEARCH_PLUGIN, writeHomePatch, writeGptSubagentPatch, writeTeamChildPatch, writeAbPatches } from './dsh-config.js'
import { UpdateChecker } from './update-checks.js'
import { createAppInstaller, githubRepository, installMethod, latestRelease, takeUpdateResult } from './app-update.js'
import { createAppRestarter } from './app-restart.js'
import { fastModels, fastPricing, writeFastModeState } from './fast-mode.js'
import { createSettingsService, DEFAULT_SETTINGS, migrateSettings } from './settings.js'
import { localLlmSettings, localRoute } from './local-llm.js'
import { teamConfig } from './team-config.js'
import { readJson, UnmovableFileError, writeJson } from './json-file.js'
import { catalogModelLimits, configuredModelCatalog, readOpenCodeCatalog } from './model-catalog.js'
import { combineOpenCodeAdditions, openCodeModels } from './opencode-go-catalog.js'
import { OpenCodeGoRegistry } from './opencode-go-registry.js'
import { SiwcModelCatalog } from './siwc-models.js'
import { ModelCatalogUpdater } from './model-updates.js'
import { installedModels, OpenCodeGoModels } from './opencode-go-models.js'
import { resetPricing, setFastPricing } from './usage.js'
import { UsageHistory } from './usage-history.js'
import { ClaudeCost } from './claude-cost.js'
import { ChatGptUsage } from './chatgpt-usage.js'
import { AUTH_REQUIRED } from './claude-auth.js'
import { mergeClaudeLimits, readSavedClaudeLimits } from './claude-limits.js'
import { CODEX_VERSION, CodexAppServer } from './codex-app-server.js'
import { accountModelAdditions, markRetired, retiredModels, withCodexModelLimits } from './codex-models.js'
import { appPaths, projectRoot } from './paths.js'
import { PERMISSION_MODES, RuntimePool } from './runtime.js'
import { openAppWindow, openExternal, openTargets } from './system.js'
import { ThreadManager } from './threads.js'
import { SubagentTracker } from './subagents.js'
import { assignProjectColors } from './project-colors.js'
import { DEFAULT_REMOTE_PORT, RemoteAccess } from './remote.js'
import { TerminalManager } from './terminals.js'
import { TeamManager } from './teams.js'
import { ClaudeRunner } from './claude-runner.js'
import { AbManager } from './ab.js'
import { AbRunner } from './ab-runner.js'
import { createAbHandlers } from './rpc-handlers-ab.js'
import { claimDataFolder } from './single-instance.js'
import { createRequestHandler, listenWithRetry } from './http-routes.js'
import { createSocketServer } from './websocket.js'
import { createMcpServerList } from './mcp-servers.js'
import { createThreadHandlers } from './rpc-handlers-threads.js'
import { createWorkspaceHandlers } from './rpc-handlers-workspaces.js'
import { createAccountHandlers } from './rpc-handlers-accounts.js'
import { createModelHandlers } from './rpc-handlers-models.js'
import { createTerminalHandlers } from './rpc-handlers-terminals.js'

const require = createRequire(import.meta.url)
const APP_VERSION = require('../package.json').version
// Where Agent Desk's own releases come from; AGENT_DESK_UPDATE_REPO (owner/name) points elsewhere, e.g. to try an update.
const APP_REPO = process.env.AGENT_DESK_UPDATE_REPO || githubRepository(require('../package.json'))
const DSH_VERSION = require('@deepseek-ai/dsh/package.json').version

// ------------------------------------------------------------------ options

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const DEV = flag('--dev')
const OPEN_WINDOW = !flag('--no-open') && !DEV
const KEEP_ALIVE = flag('--keep-alive') || DEV || !OPEN_WINDOW
const PREFERRED_PORT = Number(option('--port', process.env.AGENT_DESK_PORT ?? 47130))
const REMOTE_PORT = Number(option('--remote-port', process.env.AGENT_DESK_REMOTE_PORT ?? DEFAULT_REMOTE_PORT))

const paths = appPaths()
const serverInfoFile = path.join(paths.home, 'server.json')

const log = (...parts) => console.log('[agent-desk]', ...parts)

// ------------------------------------------------------------------ single instance

const CODE_STAMP = codeStamp()
const UI_BUILD = uiBuild()

// One instance per data folder. An instance running older code is replaced
// when it is idle; this one then takes over its port and token, so windows
// that are already open reconnect (and reload to the new UI) by themselves.
// When it is busy, this launch shows it and waits to replace it.
const { takeover, releaseDataLock } = await claimDataFolder({ paths, serverInfoFile, codeStamp: CODE_STAMP, openWindow: OPEN_WINDOW, log })

// ------------------------------------------------------------------ state

await fsp.mkdir(paths.threadsDir, { recursive: true })
await fsp.mkdir(paths.attachmentsDir, { recursive: true })
let settingsKept = false
let settings
try {
  settings = migrateSettings(await readJson(paths.settings, {}))
} catch (error) {
  // Only a corrupt file that could not be kept is tolerated: it stays where it is, this launch runs on defaults,
  // and json-file.js refuses to save over it. Any other read error still stops the launch.
  if (!(error instanceof UnmovableFileError)) throw error
  log(error.message)
  settingsKept = true
  settings = migrateSettings({})
}
// Saved by an older version, the team settings lack newer fields (the GPT leader's).
settings.agentTeams = teamConfig(settings.agentTeams)
// Runtime writes are serialized by settingsService; startup writes finish before
// requests are accepted. Persistence never changes the published snapshot.
const saveSettings = async (candidate) => {
  const saved = structuredClone(candidate)
  const colors = assignProjectColors(saved.projectColors ?? {}, [paths.myPc, ...saved.workspaces])
  if (colors) saved.projectColors = colors
  await writeJson(paths.settings, saved)
  return saved
}
if (!settingsKept && assignProjectColors(settings.projectColors ?? {}, [paths.myPc, ...settings.workspaces])) settings = await saveSettings(settings)
// The provider default ('') is no longer offered; medium is the default level.
if (!settings.defaultEffort) settings.defaultEffort = 'medium'
await fsp.mkdir(paths.myPc, { recursive: true })

const credentials = new CredentialStore(paths.credentials)
const codexApp = new CodexAppServer({ home: paths.codexHome, openUrl: openExternal })

// Agent teams (teams.js) give their leader's Claude Code its flags.
let teams = null
// Claude Code tasks: the user's own `claude` CLI in a terminal (see terminals.js).
const terminals = await new TerminalManager({
  file: path.join(paths.home, 'terminals.json'),
  settingsFile: path.join(paths.home, 'claude-terminal-settings.json'),
  hookUrl: () => `http://127.0.0.1:${server.address().port}/api/terminal-hook`,
  send: (client, frame) => {
    if (client.socket?.readyState === client.socket?.OPEN) client.socket.send(JSON.stringify(frame))
  },
  launch: (record) => teams?.launchFor(record) ?? null,
  instructions: () => settings.customInstructions,
  gptSubagent: () => (settings.subagentsEnabled !== false && settings.subagentModels?.['openai-codex'] ? { model: settings.subagentModels['openai-codex'], home: paths.home } : null),
  preflight: (context) => teams?.guardClaudeLaunch(context) ?? AUTH_REQUIRED,
  log,
}).load()
/** Whether an agent or a Claude Code task is working: the app must not exit or be replaced then. */
const busy = () => threads.busy || terminals.busy || agents.busy || teams.busy || ab.busy || abAgents.busy

async function accounts() {
  let snapshot = { refs: {}, records: {} }
  let error = null
  try {
    snapshot = await credentials.read()
  } catch (cause) {
    error = cause.message
  }
  return {
    chatgpt: describeChatGpt(snapshot.records),
    codex: codexApp.accountState,
    claude: {
      configured: Boolean(snapshot.refs[ANTHROPIC_REF]),
      masked: maskSecret(snapshot.refs[ANTHROPIC_REF]),
      workspaceId: settings.anthropicWorkspaceId ?? null,
    },
    claudeAdmin: { configured: Boolean(snapshot.refs[ANTHROPIC_ADMIN_REF]), masked: maskSecret(snapshot.refs[ANTHROPIC_ADMIN_REF]) },
    deepseek: { configured: Boolean(snapshot.refs[DEEPSEEK_REF]), masked: maskSecret(snapshot.refs[DEEPSEEK_REF]) },
    opencodeGo: { configured: Boolean(snapshot.refs[OPENCODE_GO_REF]), masked: maskSecret(snapshot.refs[OPENCODE_GO_REF]) },
    localLlm: {
      configured: Boolean(localRoute(settings.localLlm)),
      keyed: Boolean(snapshot.refs[LOCAL_LLM_REF]),
      masked: maskSecret(snapshot.refs[LOCAL_LLM_REF]),
    },
    error,
  }
}

// Newer releases of Agent Desk, dsh, the bundled Codex and Claude Code (設定 → 情報).
// `npm run dev` serves the sources being edited: it shows a new release but does not install it.
const APP_UPDATE_METHOD = DEV ? null : installMethod(projectRoot)
const updates = new UpdateChecker({
  root: projectRoot,
  installed: { dsh: DSH_VERSION, codex: CODEX_VERSION },
  getChannel: () => settings.dshUpdateChannel,
  app: APP_REPO && {
    installed: APP_VERSION,
    method: APP_UPDATE_METHOD,
    lookup: () => latestRelease({ repo: APP_REPO, needAsset: APP_UPDATE_METHOD === 'zip' }),
    install: createAppInstaller({
      root: projectRoot, home: paths.home, repo: APP_REPO, method: APP_UPDATE_METHOD, version: APP_VERSION, args, busy, shutdown,
      // The next version takes over this port and token, so the open windows reconnect.
      handoff: () => ({ port: server.address().port, token, windows: countClients(false) }),
      log,
    }),
    result: await takeUpdateResult(paths.home),
  },
  log: (...parts) => log('update check:', ...parts),
})

// What the ChatGPT backend says about each Codex model: its default and maximum
// window, fast mode, and which models the account offers (cached from its model list).
const codexLimits = await new SiwcModelCatalog(path.join(paths.home, 'siwc-models.json')).load()
let configuredModels = {}

// Models newer than the dsh release (bundled, fetched from the newest pi-ai
// release, and offered by the ChatGPT account's own list), and the user's own,
// join dsh's catalog before any runtime starts.
const modelUpdater = await new ModelCatalogUpdater({
  root: projectRoot,
  home: paths.home,
  enabled: () => settings.modelAutoUpdate !== false,
  onCatalog: () => updateModelCatalog().then(() => {}),
  log: (...parts) => log('model update:', ...parts),
}).load()
const opencodeRegistry = await new OpenCodeGoRegistry({
  file: path.join(paths.home, 'opencode-go-definitions.json'),
  base: () => readOpenCodeCatalog(modelUpdater.fetched),
}).load()
/** pi-ai stays authoritative for known definitions; official metadata fills exact-id gaps. */
const openCodeFetched = () => settings.modelAutoUpdate === false ? null : ({
  ...modelUpdater.fetched,
  providers: {
    ...modelUpdater.fetched?.providers,
    'opencode-go': combineOpenCodeAdditions(opencodeRegistry.groups, modelUpdater.fetched?.providers?.['opencode-go']),
  },
})
/** The OpenCode Go models the service still lists, among the supported definitions. */
const opencodeGoModels = await new OpenCodeGoModels({
  file: path.join(paths.home, 'opencode-go-models.json'),
  installed: () => installedModels(openCodeFetched()),
  refreshDefinitions: (ids, options) => opencodeRegistry.refresh(ids, options),
  unlisted: () => opencodeRegistry.unlisted,
}).load()
let opencodeGoKeyed = false
/** The saved OpenCode Go key, while models follow the service (the sync setting is on). */
async function opencodeGoKey() {
  const key = (await credentials.read().catch(() => null))?.refs?.[OPENCODE_GO_REF] ?? null
  opencodeGoKeyed = Boolean(key)
  return settings.modelAutoUpdate !== false ? key : null
}
await opencodeGoKey()
/** The catalog models served to the picker; null serves them all. */
const opencodeGoServed = () => (settings.modelAutoUpdate !== false ? opencodeGoModels.served : null)
/** Reads the service's list now (the shared 今すぐ確認) and applies it. */
async function checkOpenCodeGoModels() {
  await updateModelCatalog({ forceOpenCode: true })
}
/** The bundled and fetched models Agent Desk currently adds to dsh's catalog. */
let catalogAdditions = []
/** The account's model list, while models follow it (the setting is on). */
const accountAvailability = () => (settings.modelAutoUpdate !== false ? codexLimits.availability : null)
const modelUpdateState = () => ({
  ...modelUpdater.snapshot(),
  lastAdded: [modelUpdater.snapshot().lastAdded, settings.modelAutoUpdate !== false ? opencodeRegistry.lastAdded : null]
    .filter(Boolean).sort((a, b) => b.at - a.at)[0] ?? null,
  models: catalogAdditions,
  account: {
    status: codexLimits.status,
    checkedAt: codexLimits.checkedAt,
    retired: retiredModels(catalog.data.models, accountAvailability()).map(({ provider, id, name }) => ({ provider, id, name })),
  },
  // The OpenCode Go list follows the service, while a key is saved and the sync is on.
  opencodeGo: opencodeGoKeyed && settings.modelAutoUpdate !== false
    ? {
      checkedAt: opencodeGoModels.checkedAt, error: opencodeGoModels.failed,
      hidden: opencodeGoModels.hidden, missing: opencodeGoModels.missing,
      unlisted: opencodeRegistry.unlisted.filter((id) => opencodeGoModels.saved?.ids.includes(id)),
      definitionCheckedAt: opencodeRegistry.checkedAt, definitionError: opencodeRegistry.failed,
    }
    : null,
})
/** The catalog as the UI gets it: models the account's list no longer has are marked `retired`. */
const catalogState = (snapshot = catalog.snapshot()) => markRetired(snapshot, codexLimits.availability, settings.modelAutoUpdate !== false)
async function syncModelCatalog() {
  let result
  try {
    const fromAccount = settings.modelAutoUpdate !== false ? accountModelAdditions(codexLimits.availability) : []
    result = await configuredModelCatalog(fromAccount, modelUpdater.fetched)
    configuredModels = result.definitions
    if (codexLimits.definitions.length) configuredModels['openai-codex'] = codexLimits.definitions
    const goAdditions = openCodeFetched()?.providers?.['opencode-go'] ?? {}
    const previous = await readJson(paths.opencodeGoCatalog, null)
    if (JSON.stringify(previous) !== JSON.stringify(goAdditions)) {
      await writeJson(paths.opencodeGoCatalog, goAdditions)
      result.changed = true
    }
    const shippedGo = await installedModels()
    const piGo = await installedModels(modelUpdater.fetched)
    for (const model of openCodeModels(await readOpenCodeCatalog(openCodeFetched()))) {
      if (shippedGo.has(model.id)) continue
      result.added.push(`opencode-go/${model.id}`)
      result.models.push({ provider: 'opencode-go', id: model.id, name: model.name, source: piGo.has(model.id) ? 'fetched' : 'registry' })
    }
  } catch (error) {
    result = { changed: false, added: [], models: [], skipped: [], warnings: [error.message] }
  }
  for (const warning of result.warnings) log('model catalog:', warning)
  catalogAdditions = result.models
  return result
}
// Bump `learn` when the catalog learns something new, so caches refresh once.
const catalogSignature = async (result) => JSON.stringify({
  dsh: DSH_VERSION, added: [...result.added].sort(), learn: 'official-siwc',
  definitions: createHash('sha256').update(JSON.stringify(configuredModels)).digest('hex'),
  // Native DeepSeek discovery returns no models until its key is present.
  deepseek: (await accounts()).deepseek.configured,
  // OpenCode Go's route is in the home patch only while its key is saved.
  opencodeGo: (await accounts()).opencodeGo.configured,
  opencodeGoModels: (await accounts()).opencodeGo.configured
    ? opencodeGoServed() ?? [...(await installedModels(openCodeFetched())).keys()].sort()
    : [],
  local: localLlmSettings(settings.localLlm),
})

const getSettings = () => settings
const mcpServersFor = createMcpServerList({ paths, getSettings, getTeams: () => teams })

const catalog = await new Catalog(paths.catalog, await catalogSignature(await syncModelCatalog())).load()

async function modelLimits() {
  const limits = await catalogModelLimits()
  for (const [provider, models] of Object.entries(configuredModels)) {
    limits[provider] = Object.fromEntries(models.map(model => [model.id, { contextWindow: model.contextWindow, maxTokens: model.maxTokens }]))
  }
  return withCodexModelLimits(limits, codexLimits.limits)
}

/** Rewrites the dsh home patch (and the team children's layer) from the settings; true when it changed. */
async function applyHomePatch() {
  const subagents = Object.keys(SUBAGENT_TOOLS)
    .filter((provider) => settings.subagentModels?.[provider])
    .map((provider) => {
      const model = settings.subagentModels[provider]
      const name = catalog.data.models.find((entry) => entry.provider === provider && entry.id === model)?.name ?? null
      return { provider, model, name }
    })
  const persona = await shippedPersona()
  const home = await writeHomePatch(paths.homePatch, {
    anthropicWorkspaceId: settings.anthropicWorkspaceId,
    modelOverrides: contextOverrides(settings.contextLimits, await modelLimits()),
    catalogModels: configuredModels,
    subagents,
    subagentsEnabled: settings.subagentsEnabled !== false,
    settingsFile: paths.settings,
    persona,
    webSearch: { plugin: WEB_SEARCH_PLUGIN, credentials: paths.credentials },
    instructions: settings.customInstructions,
    localRoute: localRoute(settings.localLlm, { keyed: (await accounts()).localLlm.keyed }),
    opencodeGo: (await accounts()).opencodeGo.configured,
    opencodeGoModels: opencodeGoServed(),
  })
  const children = await writeTeamChildPatch(paths.teamChildPatch, { subagents, persona })
  // Read by each subagent_gpt call, so no runtime restarts for it.
  await writeGptSubagentPatch(paths.gptSubagentPatch, { subagents, persona, subagentsEnabled: settings.subagentsEnabled !== false })
  const abChanged = await writeAbPatches(paths, { subagents })
  return home || children || abChanged
}
await applyHomePatch()

// Fast mode: each dsh process reads the state file per request, so a switch
// applies to the next model request without a restart.
const currentFastModels = () => fastModels(codexLimits.limits)
async function applyFastMode() {
  setFastPricing(fastPricing(settings.fastModePeriods?.anthropic ?? []))
  await writeFastModeState(paths.fastMode, settings.fastMode, currentFastModels())
}
await applyFastMode()

/** Refresh after startup or sign-in; keep running tasks intact until they finish. */
async function refreshCodexModels() {
  try {
    const changed = await codexLimits.refresh(credentials)
    // The result of the check (also "signed out") shows in settings.
    broadcast('modelUpdate', { modelUpdate: modelUpdateState() })
    if (!changed) return
    await applyFastMode()
    broadcast('fastModels', { fastModels: currentFastModels() })
    // The account's list can add models and retire others, as well as move the limits.
    await updateModelCatalog()
  } catch (error) {
    log('Codex model limits:', error.message)
  }
}

let threads
const pool = new RuntimePool({
  paths,
  onUpdate: (sessionId, update) => threads.onUpdate(sessionId, update),
  onPermission: (params) => threads.onPermission(params),
})
threads = new ThreadManager({
  paths,
  pool,
  catalog,
  getAccounts: accounts,
  getMcpServers: mcpServersFor,
  checkpoints: new Checkpoints({ root: paths.checkpoints }),
  checkpointsEnabled: () => settings.checkpoints !== false,
})
await threads.load()

// Agent teams: a Claude Code leader hands work to GPT (dsh) and Claude Code children.
// Claude children run headless (claude -p), after per-team auth consent checks.
const agents = await new ClaudeRunner({ dir: path.join(paths.home, 'team-agents'), preflight: (context) => teams?.guardClaudeLaunch(context) ?? AUTH_REQUIRED, log }).load()
agents.on('turn', ({ id, turn }) => broadcast('agentTurn', { id, turn }))
agents.on('turn-speed', ({ id, turnId, speed }) => broadcast('agentTurnSpeed', { id, turnId, speed }))
// The Claude subscription's limits, as the team's `claude -p` runs last reported them.
const claudeLimitsFile = path.join(paths.home, 'claude-limits.json')
let claudeLimits = readSavedClaudeLimits(await readJson(claudeLimitsFile, null).catch(() => null))
agents.on('rateLimits', (reading) => {
  claudeLimits = mergeClaudeLimits(claudeLimits, reading)
  broadcast('claudeLimits', { limits: claudeLimits })
  void writeJson(claudeLimitsFile, claudeLimits).catch((error) => log('claude limits:', error.message))
})
teams = await new TeamManager({
  file: path.join(paths.home, 'teams.json'),
  dir: path.join(paths.home, 'teams'),
  threads,
  terminals,
  agents,
  catalog,
  getSettings: () => settings.agentTeams,
  apiUrl: () => `http://127.0.0.1:${server.address().port}/api/team`,
  instructions: () => settings.customInstructions,
  guides: () => ({ policies: settings.teamPolicies, playbooks: settings.teamPlaybooks }),
  log,
}).load()

const abAgents = await new ClaudeRunner({ dir: path.join(paths.home, 'ab-agents'),
  preflight: (context) => teams.claudeAuth.guard(null, context), log }).load()
const abRunner = new AbRunner({ threads, agents: abAgents, attachmentsDir: paths.attachmentsDir, instructions: () => settings.customInstructions,
  guard: (record) => teams.guardExecution(record) })
const ab = await new AbManager({ dir: path.join(paths.home, 'ab'), runner: abRunner, catalog: () => catalog.data,
  validateImages: async (images, config) => {
    const saved = await abImages(paths.attachmentsDir, images)
    if (saved.length) assertAbImageModels(config, catalog.data.models)
    return saved
  },
  validateModel: (value) => {
    if (['claude:opus', 'claude:sonnet', 'claude:haiku'].includes(value)) return
    if (!catalog.data.models.some((model) => model.value === value && !model.retired && settings.modelVisibility?.[value] !== false)) throw new Error('ABのモデルを選び直してください')
  },
  authorize: async ({ workspace, config, authConfirmation }) => {
    if ([config.a, config.b, config.leader, config.implementer].some((value) => value.startsWith('claude:'))) {
      await teams.confirmAbAuth(workspace, authConfirmation)
      const problem = await teams.claudeAuth.guard(null, teams.claudeAuth.context(workspace))
      if (problem) throw new Error(problem)
    }
  },
}).load()
ab.on('ab', (run) => broadcast('ab', { run }))
ab.on('removed', ({ id }) => broadcast('abRemoved', { id }))
ab.on('fault', (error) => log('AB:', error.message))
abRunner.on('fault', (error) => log('AB runner:', error.message))
ab.on('notify', (notification) => broadcast('notify', notification))

// What each task's subagents are doing, read from their dsh logs (see subagents.js).
const subagents = new SubagentTracker({
  dshHome: paths.dshHome,
  modelName: (provider, id) => catalog.data.models.find((entry) => entry.provider === provider && entry.id === id)?.name ?? null,
  isLive: (sessionId) => pool.holderOf(sessionId) !== null,
})
const followSubagents = (threadId) => {
  const thread = threads.threads.get(threadId)
  if (thread) subagents.follow(thread.id, thread.sessionId, thread.status === 'running')
}

// Every open UI, and whether it came in over remote access (a phone) or is a window on this PC.
const clients = new Map()
const countClients = (remote) => [...clients.values()].filter((client) => client.remote === remote).length
function broadcast(event, payload, { localOnly = false } = {}) {
  // Serialized for the first socket that gets it: nobody listening costs nothing.
  let frame
  for (const [socket, client] of clients) {
    if (localOnly && client.remote) continue
    if (socket.readyState === socket.OPEN) socket.send(frame ??= JSON.stringify({ event, ...payload }))
  }
}

const login = new ChatGptLogin({
  store: credentials,
  openUrl: openExternal,
  onState: async (state) => {
    broadcast('login', { login: state })
    if (state.phase === 'done') {
      broadcast('accounts', { accounts: await accounts() })
      void refreshCodexModels()
    }
  },
})

threads.on('thread', (thread) => {
  broadcast('thread', { thread })
  followSubagents(thread.id)
})
threads.on('turn', ({ threadId, turn }) => {
  broadcast('turn', { threadId, turn })
  followSubagents(threadId)
})
threads.on('turn-speed', ({ threadId, turnId, speed }) => broadcast('turnSpeed', { threadId, turnId, speed }))
threads.on('removed', ({ threadId }) => {
  broadcast('removed', { threadId })
  subagents.forget(threadId)
})
subagents.on('change', ({ threadId, subagent }) => {
  broadcast('subagent', { threadId, subagent })
  // A team's children have no subagents (their dsh has none: this is the
  // backstop), and a team never bills the Anthropic API: a child that starts a
  // subagent, or a GPT leader that starts a Claude one, is stopped.
  const starting = subagent.status === 'starting' || subagent.status === 'running'
  if (starting && teams.inTeam(threadId) && (subagent.provider === 'anthropic' || teams.isChild(threadId) || teams.isExecution(threadId))) {
    void teams.stopApiUse(threadId).catch((error) => log('team:', error.message))
  }
})
threads.on('catalog', (snapshot) => broadcast('catalog', { catalog: catalogState(snapshot) }))
threads.on('runtime', (status) => broadcast('runtime', { runtime: status }))
// A team's children report to their leader, not to the user.
threads.on('turn-finished', (info) => {
  if (!teams.isChild(info.threadId) && !threads.threads.get(info.threadId)?.ab) broadcast('notify', { kind: 'turn-finished', ...info })
})
terminals.on('terminal', (terminal) => broadcast('terminal', { terminal }))
terminals.on('removed', ({ terminalId }) => broadcast('terminalRemoved', { terminalId }))
terminals.on('turn-finished', ({ terminalId, title, failed }) => {
  if (!teams.isChild(terminalId)) broadcast('notify', { kind: 'turn-finished', terminal: true, threadId: terminalId, title, ...(failed ? { status: 'error' } : {}) })
})
// A Claude child shows its own dialog only once nobody decided in time: then the user is asked.
terminals.on('approval-needed', ({ terminalId, title }) => broadcast('notify', { kind: 'approval-needed', terminal: true, threadId: terminalId, title }))
teams.on('team', (team) => broadcast('team', { team }))
teams.on('removed', ({ teamId }) => broadcast('teamRemoved', { teamId }))
// The leader needs the user (ask_user), or a child's approval waited too long for the leader.
teams.on('ask', ({ leaderId, leaderKind, text }) => broadcast('notify', { kind: 'team-ask', terminal: leaderKind !== 'thread', threadId: leaderId, title: text }))
teams.on('stuck', ({ leaderId, leaderKind, title }) => broadcast('notify', { kind: 'approval-needed', terminal: leaderKind !== 'thread', threadId: leaderId, title }))
terminals.on('turn-finished', () => {
  if (restartPending) void restartRuntimesWhenIdle()
})

// The ChatGPT subscription's remaining allowance (5-hour / weekly windows).
let chatgptUsage = null
const chatgptUsageTracker = new ChatGptUsage(codexApp, usage => {
  chatgptUsage = usage
  broadcast('chatgptUsage', { usage })
})
let usageTimer = null
codexApp.on('login', state => {
  broadcast('codexLogin', { codexLogin: state }, { localOnly: true })
  if (state.phase === 'done') void refreshChatGptUsage()
})
codexApp.on('account', () => { void accounts().then(next => broadcast('accounts', { accounts: next })) })
codexApp.on('rateLimits', body => { chatgptUsageTracker.update(body) })
async function refreshChatGptUsage() {
  return chatgptUsageTracker.refresh()
}
threads.on('turn-finished', ({ threadId }) => {
  // Images may be requested by GPT or Claude; these limits belong to the separate Codex account.
  if (!codexApp.accountState.signedIn) return
  clearTimeout(usageTimer)
  usageTimer = setTimeout(() => void refreshChatGptUsage(), 1500)
})
// Usage across all tasks: local estimates from dsh's logs, and the Claude
// organization's billed cost when a key may read it.
const usageHistory = new UsageHistory({ dshHome: paths.dshHome, file: path.join(paths.home, 'usage-history.json') })
const claudeCost = await new ClaudeCost({
  file: path.join(paths.home, 'claude-cost.json'),
  keys: async () => {
    const refs = (await credentials.read().catch(() => ({ refs: {} }))).refs
    return { admin: refs[ANTHROPIC_ADMIN_REF] ?? null, api: refs[ANTHROPIC_REF] ?? null }
  },
  userAgent: `AgentDesk/${APP_VERSION}`,
}).load()
const usageState = () => ({ local: usageHistory.summary, claude: claudeCost.state })
const broadcastUsage = () => broadcast('usage', { usage: usageState() })
usageHistory.on('summary', broadcastUsage)
claudeCost.on('state', broadcastUsage)
const refreshUsageHistory = () => usageHistory.refresh().catch((error) => log('usage history:', error.message))
const refreshClaudeCost = (options) => claudeCost.refresh(options).catch((error) => log('claude cost:', error.message))
let historyTimer = null
let costTimer = null
threads.on('turn-finished', ({ threadId }) => {
  // dsh may still be appending the turn's last records.
  clearTimeout(historyTimer)
  historyTimer = setTimeout(() => void refreshUsageHistory(), 3000)
  // Billed costs show up in the Admin API a few minutes after the requests.
  if (!(threads.threads.get(threadId)?.model ?? '').includes('"anthropic"')) return
  clearTimeout(costTimer)
  costTimer = setTimeout(() => void refreshClaudeCost(), 6 * 60_000)
})
threads.on('approval-needed', (info) => {
  if (!teams.isChild(info.threadId) && !threads.threads.get(info.threadId)?.ab) broadcast('notify', { kind: 'approval-needed', ...info })
})
// dsh reads the home patch at startup, so a changed patch restarts the
// runtimes once no turn is running. Threads resume their sessions afterwards.
let restartPending = false
async function restartRuntimesWhenIdle() {
  // A dsh update stops the runtimes itself; new ones read the current patch.
  if (pool.paused) return
  if (threads.busy) {
    restartPending = true
    return
  }
  restartPending = false
  await pool.stopAll()
  broadcast('runtime', { runtime: pool.status() })
  if (catalog.stale) threads.warmCatalog().catch((error) => log('model catalog refresh failed:', error.message.split('\n')[0]))
}

let modelCatalogQueue = Promise.resolve()
function updateModelCatalog(options = {}) {
  const task = modelCatalogQueue.then(() => performModelCatalogUpdate(options))
  modelCatalogQueue = task.catch(() => {})
  return task
}
async function performModelCatalogUpdate({ deferRuntimeEffects = false, forceOpenCode = false } = {}) {
  await opencodeGoModels.refresh(await opencodeGoKey(), { maxAgeMs: forceOpenCode ? 0 : 60_000 })
  const result = await syncModelCatalog()
  resetPricing()
  catalog.setSignature(await catalogSignature(result))
  const restartRequired = result.changed || catalog.stale
  // settings.update combines catalog, home-patch and tool changes into one
  // restart. Other callers retain the full catalog refresh behavior.
  if (!deferRuntimeEffects) {
    const patched = await applyHomePatch()
    if (restartRequired || patched) await restartRuntimesWhenIdle()
  }
  broadcast('modelUpdate', { modelUpdate: modelUpdateState() })
  // Which models count as retired follows the setting and the account's list.
  broadcast('catalog', { catalog: catalogState() })
  return { ...result, restartRequired }
}
threads.on('turn-finished', () => {
  if (restartPending) void restartRuntimesWhenIdle()
})
updates.on('state', (state) => broadcast('updates', { updates: state }))
modelUpdater.on('state', () => broadcast('modelUpdate', { modelUpdate: modelUpdateState() }))

async function setAnthropicWorkspace(workspaceId) {
  await settingsService.mutate(candidate => { candidate.anthropicWorkspaceId = workspaceId }, {
    afterCommit: async () => {
      if (await applyHomePatch()) await restartRuntimesWhenIdle()
    },
  })
}

pool.on('exit', ({ mode, code, wasReady }) => {
  if (wasReady && code !== 0) log(`runtime (${mode}) exited with code ${code}`)
})

// Token refreshes by dsh and manual edits change the credential file.
let credentialTimer = null
try {
  fs.mkdirSync(paths.dshHome, { recursive: true })
  fs.watch(paths.dshHome, (_event, name) => {
    if (name && !String(name).startsWith('.credentials.yaml')) return
    clearTimeout(credentialTimer)
    credentialTimer = setTimeout(async () => {
      broadcast('accounts', { accounts: await accounts() })
      // A startup fetch may have used an expired token; retry after dsh renews it.
      void refreshCodexModels()
    }, 300)
  })
} catch {}

/** Remote access as the PC's settings show it; the link carries the token, so phones never get it. */
function remoteState(client) {
  if (client?.remote) return { enabled: true, phase: 'listening', viewer: true }
  return { ...remote.snapshot(), clients: countClients(true) }
}
const broadcastRemote = () => broadcast('remoteAccess', { remoteAccess: remoteState() }, { localOnly: true })

async function fullState(client) {
  return {
    app: {
      version: APP_VERSION, dshVersion: DSH_VERSION, platform: process.platform, dataDir: paths.home, myPc: paths.myPc, uiBuild: UI_BUILD,
      remote: Boolean(client?.remote),
    },
    settings,
    accounts: await accounts(),
    catalog: catalogState(),
    fastModels: currentFastModels(),
    threads: threads.list(),
    terminals: terminals.list(),
    teams: teams.list(),
    ab: ab.list(),
    runtime: pool.status(),
    login: login.state,
    codexLogin: client?.remote ? { phase: 'idle' } : codexApp.login,
    chatgptUsage,
    claudeLimits,
    usage: usageState(),
    openTargets: openTargets(),
    permissionModes: PERMISSION_MODES,
    updates: updates.snapshot(),
    modelUpdate: modelUpdateState(),
    remoteAccess: remoteState(client),
  }
}

// ------------------------------------------------------------------ requests


const settingsService = createSettingsService({
  getSettings: () => settings,
  saveSettings,
  publishSettings: (saved, { notify }) => {
    settings = saved
    if (notify) broadcast('settings', { settings })
  },
  applyHomePatch,
  applyFastMode,
  updateModelCatalog: () => updateModelCatalog({ deferRuntimeEffects: true }),
  restartRuntimesWhenIdle,
  onChannelChange: () => updates.channelChanged(),
  checkModelUpdate: () => modelUpdater.check(),
  onBackgroundError: (error) => log('settings update check:', error.message),
})

// The next server takes over this port and token, as after an update.
const restartApp = createAppRestarter({
  root: projectRoot, home: paths.home, args, shutdown, log,
  handoff: () => ({ port: server.address().port, token, windows: countClients(false) }),
})

const mutateSettings = (...args) => settingsService.mutate(...args)
const handlers = {
  ...createThreadHandlers({ paths, threads, teams, subagents, mutateSettings }),
  ...createWorkspaceHandlers({ paths, getSettings, mutateSettings }),
  ...createAccountHandlers({
    appVersion: APP_VERSION, credentials, login, codexApp, getSettings, broadcast, accounts, setAnthropicWorkspace, refreshClaudeCost,
    updateModelCatalog, refreshChatGptUsage, getChatgptUsage: () => chatgptUsage, refreshUsageHistory, usageState,
    updateSettings: (patch) => settingsService.update(patch),
  }),
  ...createModelHandlers({
    threads, catalog, catalogState, updates, modelUpdater, modelUpdateState,
    updateModelCatalog, refreshCodexModels, checkOpenCodeGoModels,
  }),
  ...createTerminalHandlers({ paths, getSettings, mutateSettings, terminals, teams, agents }),

  ...createAbHandlers(ab),

  'state.get': (_params, client) => fullState(client),

  'settings.update': ({ patch }) => settingsService.update(patch),

  // Builds the UI, then restarts this server whatever it is doing (the tasks stop).
  'app.restart': async () => {
    if (DEV) throw new Error('開発サーバー（npm run dev）では使えません')
    await restartApp()
    return null
  },

  'remote.set': async ({ enabled }) => {
    await mutateSettings(candidate => { candidate.remoteAccess = Boolean(enabled) }, {
      afterCommit: async (saved) => {
        if (saved.remoteAccess) {
          await remote.start()
        } else {
          disconnectRemote()
          await remote.stop()
          scheduleIdleExit()
        }
      },
    })
    return { remoteAccess: remoteState() }
  },
  'remote.rotate': async () => {
    await remote.rotate()
    return { remoteAccess: remoteState() }
  },
  // Asks Tailscale again, e.g. after the user installed or signed in to it.
  'remote.recheck': async () => {
    await remote.recheck()
    return { remoteAccess: remoteState() }
  },
  // Adds a Windows Firewall rule for the phone port (Windows asks for an admin's OK).
  'remote.allowFirewall': async () => {
    const error = await remote.allowFirewall()
    if (error) throw new Error(error)
    return { remoteAccess: remoteState() }
  },
}

// AB workers can only be driven through AB's approval/state machine, not generic task RPCs.
for (const type of ['thread.send', 'thread.steer', 'thread.update', 'thread.remove', 'thread.cancel', 'checkpoint.restore', 'checkpoint.undo']) {
  const handler = handlers[type]
  handlers[type] = (input, ...args) => {
    if (threads.threads.get(input?.threadId)?.ab) throw new Error('AB画面から操作してください')
    return handler(input, ...args)
  }
}

// Settings mutations own their queue in settingsService, including thread.remove.
// Do not wrap whole RPCs on that queue: they may await a settings commit themselves.

// ------------------------------------------------------------------ HTTP

const token = takeover?.token ?? randomBytes(24).toString('hex')

/** The app window's listener, as the request handlers see it. */
function localContext() {
  const port = server.address().port
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  return { remote: false, token, port, hostOk: (host) => hosts.has(host) }
}

const handleRequest = createRequestHandler({
  appVersion: APP_VERSION, codeStamp: CODE_STAMP, busy, countClients, paths, terminals, teams, shutdown,
})

const server = http.createServer((req, res) => void handleRequest(req, res, localContext()))

// ------------------------------------------------------------------ WebSocket

let idleTimer = null

const { handleUpgrade } = createSocketServer({
  dev: DEV, clients, handlers, fullState, terminals, broadcastRemote, scheduleIdleExit,
  cancelIdleExit: () => clearTimeout(idleTimer), isShuttingDown: () => shuttingDown, log,
})
server.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head, localContext()))

/** Closes every phone's connection (remote access turned off, or a new link replaced the old one). */
function disconnectRemote() {
  for (const [socket, client] of clients) if (client.remote) socket.close(4001, 'remote access ended')
}

// Phones reach the same handlers through their own listener (server/remote.js).
// AGENT_DESK_REMOTE_ADDRESSES (comma-separated) replaces Tailscale discovery,
// e.g. 127.0.0.2 to try the phone UI on this PC.
const remoteAddresses = (process.env.AGENT_DESK_REMOTE_ADDRESSES ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)
const remote = await new RemoteAccess({
  file: path.join(paths.home, 'remote.json'),
  port: REMOTE_PORT,
  addresses: remoteAddresses.length ? async () => remoteAddresses : null,
  onRequest: (req, res, ctx) => void handleRequest(req, res, ctx),
  onUpgrade: handleUpgrade,
  log,
}).load()
remote.on('state', broadcastRemote)
remote.on('token', disconnectRemote)

// The app window owns the app's lifetime: once every window has been closed
// for a while and no agent is working, the server exits. With remote access
// on it keeps running, so a phone can still reach it.
function scheduleIdleExit() {
  if (KEEP_ALIVE || settings.remoteAccess || countClients(false) > 0) return
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (KEEP_ALIVE || settings.remoteAccess || countClients(false) > 0) return
    if (busy()) return scheduleIdleExit()
    log('all windows closed; shutting down')
    void shutdown(0)
  }, 30_000)
}

// ------------------------------------------------------------------ lifecycle

let shuttingDown = false
let codexModelsTimer = null
let opencodeGoTimer = null
async function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  login.cancel()
  updates.stop()
  modelUpdater.stop()
  clearInterval(codexModelsTimer)
  clearInterval(opencodeGoTimer)
  // Request cancellation first, then close the transports as well. A stalled
  // ACP cancellation must not keep shutdown waiting forever for its prompt.
  const abDrained = ab.shutdown().catch((error) => log('AB shutdown:', error.message))
  const drained = threads.shutdown().catch((error) => log('thread shutdown:', error.message))
  await pool.pause().catch((error) => log('runtime shutdown:', error.message))
  await drained
  await abDrained
  await abAgents.shutdown().catch((error) => log('AB agents shutdown:', error.message))
  await teams.stop().catch((error) => log('team shutdown:', error.message))
  await terminals.shutdown().catch((error) => log('terminal shutdown:', error.message))
  await agents.shutdown().catch((error) => log('team agents shutdown:', error.message))
  await codexApp.stop().catch(() => {})
  await remote.close().catch(() => {})
  await fsp.rm(serverInfoFile, { force: true }).catch(() => {})
  server.close()
  // Keep ownership through the last shared-state write and discovery cleanup.
  await releaseDataLock()
  process.exit(code)
}
process.on('SIGINT', () => void shutdown(0))
process.on('SIGTERM', () => void shutdown(0))

// A takeover waits briefly for the old instance's port to free up.
const port = await listenWithRetry(server, takeover?.port ?? PREFERRED_PORT, takeover ? 20 : 1)
await writeJson(serverInfoFile, { port, token, pid: process.pid })

const appUrl = `http://127.0.0.1:${port}/?t=${token}`
log(`dsh ${DSH_VERSION} · data: ${paths.home}`)
if (DEV) log(`dev UI: http://127.0.0.1:5173/?t=${token}&port=${port}`)
else log(`open: ${appUrl}`)
// After a takeover the old window reconnects on its own when it was open.
if (OPEN_WINDOW && !(takeover?.windows > 0 && port === takeover.port)) openAppWindow(appUrl, paths.browserProfile)
scheduleIdleExit()
if (settings.remoteAccess) void remote.start().catch((error) => log('remote access:', error.message))
// Now that the port is known: reports that waited while the app was closed go to their leaders.
teams.start()

void refreshChatGptUsage()
void refreshUsageHistory()
void refreshClaudeCost({ maxAgeMs: 30 * 60_000 })
// Codex defaults, larger windows and fast mode all depend on the model list,
// and so do the models it adds and retires: look again every few hours.
void refreshCodexModels()
codexModelsTimer = setInterval(() => void refreshCodexModels(), 6 * 60 * 60 * 1000)
codexModelsTimer.unref()
// OpenCode Go withdraws and renames models too: read its list the same way.
const refreshOpenCodeGoModels = async () => {
  if (!(await accounts()).opencodeGo.configured) return
  await updateModelCatalog().catch((error) => log('OpenCode Go models:', error.message))
}
void refreshOpenCodeGoModels()
opencodeGoTimer = setInterval(() => void refreshOpenCodeGoModels(), 6 * 60 * 60 * 1000)
opencodeGoTimer.unref()

// Boot the default runtime early and learn the model list in the background.
threads.warmCatalog().catch((error) => log('model catalog warm-up failed:', error.message.split('\n')[0]))

updates.start()
modelUpdater.start()
