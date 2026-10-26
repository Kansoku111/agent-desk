// The Harness-home patch layer Agent Desk owns. It is applied after the shipped
// `acp` profile, so it only needs the rows Agent Desk changes.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { writeText } from './json-file.js'
import { ANTHROPIC_REF, OPENCODE_GO_REF } from './credentials.js'
import { LOCAL_PROVIDER } from './local-llm.js'
import { isModelId } from './model-catalog.js'
import { SIWC_KEY_REF, SIWC_RESOURCE } from './siwc-client.js'
import { childPrompt } from './teams-prompts.js'

const WORKSPACE_ID = /^wrkspc_[A-Za-z0-9]+$/

export function isWorkspaceId(value) {
  return typeof value === 'string' && WORKSPACE_ID.test(value)
}

/**
 * pi-ai's own OpenCode Go provider: a catalog route, so its models, wire
 * protocols and the `x-opencode-session` header come from pi-ai.
 */
export const OPENCODE_GO_PROVIDER = 'opencode-go'

/** Context sizes the settings screen offers, in tokens. */
export const CONTEXT_CHOICES = [64_000, 128_000, 200_000, 272_000, 400_000, 500_000, 1_000_000]

/** Providers whose context size can be capped (pi-ai catalog routes). */
export const CONTEXT_PROVIDERS = ['openai-codex', 'anthropic']

/**
 * Per-model overrides that set the context window of a provider's models to
 * the chosen size, within what each model allows.
 *
 * With no size selected, use defaultContextWindow from the backend when
 * available, otherwise the catalog's contextWindow. The original catalog
 * window is kept so an updated default still produces a dsh override.
 * A larger choice raises the window up to the model's maxContextWindow.
 *
 * dsh compacts a conversation at 80% of the window minus the tokens reserved
 * for the reply (the model's maxTokens, 128K on current models). A smaller
 * window therefore also gets a smaller reply budget — a fifth of the window,
 * at least 8K — or nothing would be left for the conversation itself.
 * @param {Record<string, number | null>} limits - chosen size per provider; null uses its default.
 * @param {Record<string, Record<string, { contextWindow: number, maxTokens: number, defaultContextWindow?: number, maxContextWindow?: number }>>} models
 */
export function contextOverrides(limits, models) {
  const overrides = {}
  for (const provider of CONTEXT_PROVIDERS) {
    const chosen = limits?.[provider]
    if (chosen != null && (!Number.isInteger(chosen) || chosen <= 0)) continue
    for (const [id, model] of Object.entries(models?.[provider] ?? {})) {
      const defaultWindow = model.defaultContextWindow ?? model.contextWindow
      const ceiling = model.maxContextWindow ?? defaultWindow
      const target = Math.min(chosen ?? defaultWindow, ceiling)
      const maxTokens = target < Math.max(defaultWindow, model.contextWindow)
        ? Math.min(model.maxTokens, Math.max(8192, Math.floor(target / 5)))
        : model.maxTokens
      if (target === model.contextWindow && maxTokens === model.maxTokens) continue
      overrides[provider] ??= {}
      overrides[provider][id] = {
        contextWindow: target,
        ...(maxTokens === model.maxTokens ? {} : { maxTokens }),
      }
    }
  }
  return overrides
}

/**
 * Delegation tools pinned to one provider, so a GPT task can hand work to
 * Claude and the other way round. dsh's own `subagent` and `subagent_fork`
 * always run children on the parent's model.
 */
export const SUBAGENT_TOOLS = {
  anthropic: { toolName: 'subagent_claude', family: 'Claude', billing: 'billed per token to the user\'s Anthropic API key' },
  'openai-codex': { toolName: 'subagent_gpt', family: 'GPT', billing: 'covered by the user\'s ChatGPT subscription' },
}

/**
 * The deployment persona the shipped `acp` profile sets. A patch row replaces
 * a plugin's whole config, so a row that extends the persona starts from it.
 */
export async function shippedPersona() {
  try {
    const file = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-acp-app/cordis.patch.yml'))
    const rows = YAML.parse(await fs.readFile(file, 'utf8'))
    const config = rows.find((row) => row?.id === 'system-prompt')?.config ?? {}
    return { personaPrefix: config.personaPrefix ?? '', personaSuffix: config.personaSuffix ?? '' }
  } catch {
    return { personaPrefix: 'You are a coding agent powered by the {{model}} model.', personaSuffix: 'Your working directory is {{cwd}}.' }
  }
}

/** The dsh plugin that searches the web on the ChatGPT subscription. */
export const WEB_SEARCH_PLUGIN = new URL('./web-search-plugin.js', import.meta.url).href
// Its PROVIDER_ID; not imported, so the server does not load dsh's web module.
const WEB_SEARCH_PROVIDER = 'agent-desk-chatgpt'

/** The dsh plugin that adds the user's custom instructions to the system prompt. */
export const INSTRUCTIONS_PLUGIN = new URL('./instructions-plugin.js', import.meta.url).href

/** The dsh plugin that gives a team's child its standing instructions as a system prompt section. */
export const TEAM_CHILD_PLUGIN = new URL('./team-child-plugin.js', import.meta.url).href

/** Longest custom instructions the settings accept, in characters. */
export const INSTRUCTIONS_MAX = 10_000

/**
 * The prompt paragraph that tells the agent which model each pinned tool runs.
 * A model that sees `subagent` next to a pinned tool takes the plain one, which
 * runs on its own model, so the paragraph steers it to its family's pinned tool.
 */
function subagentGuidance(subagents) {
  const tools = subagents.map(({ provider, model, name }) => ({ ...SUBAGENT_TOOLS[provider], label: name || model }))
  return [
    'Subagents on a fixed model:',
    ...tools.map(({ toolName, label, billing }) => `- \`${toolName}\`: ${label}; ${billing}.`),
    `The user chose these. Delegate with your own family's tool (${tools.map(({ toolName, family }) => `\`${toolName}\` for ${family}`).join(', ')}), else \`subagent\`; use another family's only for a second opinion or when asked. \`subagent\` and \`subagent_fork\` run on your own model; use \`subagent_fork\` only when the child must see this conversation.`,
    'Subagents do not get this session\'s MCP tools (`mcp__…`: image generation, browser, desktop). Call those yourself; `mcp__imagegen__generate_image` already has GPT draw the image, so image requests need no subagent.',
  ].join('\n')
}

const CODEX_RETRY_POLICY = {
  mode: 'normal',
  maxRetries: 8,
  backoff: { initialDelayMs: 1000, maxDelayMs: 30_000, jitterRatio: 0.2 },
}

const HEADER = `# Managed by Agent Desk: this file is rewritten on every start.
# Model routes: official SIWC (records/agent-desk/chatgpt-siwc). The historical
# openai-codex provider key now dispatches standard openai-responses to api.openai.com.
# Claude uses an Anthropic API key
# (refs/${ANTHROPIC_REF}). DeepSeek stays available through the shipped route.
# OpenCode Go (pi-ai's catalog route) is added while refs/${OPENCODE_GO_REF} is set.
# The ACP bridge decides once, at startup and from its default model, whether
# prompts may carry images; the shipped default (deepseek-v4-flash) is text
# only, so it is set to an image-capable model. Tasks still pick their own.
# web_search runs on the ChatGPT subscription (server/web-search-plugin.js)
# instead of DeepSeek's search, which fails without a DeepSeek API key.
# The workflow tool is off: one call fans out many subagents, which defeats a
# limit on subagent use the user sets in a request or the custom instructions.
`

/**
 * @param {object} [options]
 * @param {string | null} [options.anthropicWorkspaceId] - the workspace an
 *   unscoped Claude personal or service account key acts in.
 * @param {Record<string, Record<string, object>>} [options.modelOverrides] -
 *   per provider and model id, from {@link contextOverrides}.
 * @param {{ provider: string, model: string, name?: string | null }[]} [options.subagents] -
 *   the fixed-model delegation tools to add, one per {@link SUBAGENT_TOOLS} provider.
 * @param {boolean} [options.subagentsEnabled] - false omits all delegation tools and their generated guidance.
 * @param {string | null} [options.settingsFile] - saved settings read by the live execution gate.
 * @param {{ personaPrefix: string, personaSuffix: string }} [options.persona] -
 *   the shipped persona ({@link shippedPersona}); the tools' guidance follows it.
 * @param {{ plugin: string, credentials: string } | null} [options.webSearch] -
 *   the search plugin's module URL ({@link WEB_SEARCH_PLUGIN}) and dsh's
 *   credential file; web_search keeps DeepSeek's search without it.
 * @param {string} [options.instructions] - the user's custom instructions,
 *   added to every system prompt by {@link INSTRUCTIONS_PLUGIN}.
 * @param {object | null} [options.localRoute] - the local server's route
 *   (local-llm.js `localRoute`), or null when none is set up.
 * @param {boolean} [options.opencodeGo] - whether an OpenCode Go key is saved.
 * @param {string[] | null} [options.opencodeGoModels] - the catalog models OpenCode still
 *   serves (opencode-go-models.js); null serves the whole catalog.
 */
export function homePatch({
  anthropicWorkspaceId = null, modelOverrides = {}, catalogModels = {},
  subagents = [], subagentsEnabled = true, settingsFile = null, persona = null, webSearch = null, instructions = '', localRoute = null, opencodeGo = false, opencodeGoModels = null,
} = {}) {
  // dsh's default (5 tries, 10 s at most) gives up within about 15 s, shorter
  // than the minute-long upstream hiccups ChatGPT's backend has.
  // Historical provider key only; actual wire protocol, URL and credential are official SIWC.
  const codex = {
    api: 'openai-responses',
    baseURL: SIWC_RESOURCE,
    apiKeyEnv: SIWC_KEY_REF,
    displayName: 'ChatGPT (official SIWC)',
    retryPolicy: CODEX_RETRY_POLICY,
  }
  const anthropic = { apiKeyEnv: ANTHROPIC_REF }
  if (isWorkspaceId(anthropicWorkspaceId)) anthropic.headers = { 'anthropic-workspace-id': anthropicWorkspaceId }
  if (Object.keys(modelOverrides['openai-codex'] ?? {}).length) codex.modelOverrides = modelOverrides['openai-codex']
  if (Object.keys(modelOverrides.anthropic ?? {}).length) anthropic.modelOverrides = modelOverrides.anthropic
  for (const [provider, profile] of [['openai-codex', codex], ['anthropic', anthropic]]) {
    const models = catalogModels[provider]
    if (models?.length) {
      profile.models = models.map(model => ({ ...model, ...modelOverrides[provider]?.[model.id] }))
      delete profile.modelOverrides
    }
  }
  const codexModels = Array.isArray(catalogModels['openai-codex']) ? catalogModels['openai-codex'] : []
  let acpModel = 'gpt-6.1-sol'
  if (codexModels.length) {
    const selectable = codexModels.filter((model) =>
      model && isModelId(model.id) && (model.visibility === undefined || model.visibility === 'list'))
    // Match the UI's preferred Codex models before following the account list.
    acpModel = ['gpt-6.1-sol', 'gpt-5.5'].find((id) => selectable.some((model) => model.id === id))
      ?? selectable[0]?.id
      ?? null
  }
  const rows = [
    {
      id: 'llm-pi-ai',
      config: {
        providers: {
          'openai-codex': codex,
          anthropic,
          ...(opencodeGo ? { [OPENCODE_GO_PROVIDER]: {
            apiKeyEnv: OPENCODE_GO_REF,
            ...(opencodeGoModels?.length ? { models: opencodeGoModels.map((id) => ({ id })) } : {}),
          } } : {}),
          ...(localRoute ? { [LOCAL_PROVIDER]: localRoute } : {}),
        },
      },
    },
    // The model pickers prefer the same one (web/src/components/Pickers.tsx).
    ...(acpModel ? [{ id: 'acp', config: { provider: 'openai-codex', model: acpModel } }] : []),
    // Its tool and prompt section go together; delegation is configured below.
    { id: 'tool-workflow', disabled: true },
  ]
  if (settingsFile) rows.push({ insert: [{
    id: 'agent-desk-subagent-policy',
    name: new URL('./subagent-policy-plugin.js', import.meta.url).href,
    config: { settingsFile },
  }] })
  if (!subagentsEnabled) rows.push(...BASE_SUBAGENT_TOOLS.map((id) => ({ id, disabled: true })))
  const pinned = subagentsEnabled ? subagents.filter(({ provider, model }) => SUBAGENT_TOOLS[provider] && isModelId(model)) : []
  if (pinned.length) {
    // Same shape as dsh-base's `subagent` row: fresh in-process children that
    // keep running in the background and accept `send_message`.
    rows.push({
      insert: pinned.map(({ provider, model }) => ({
        id: `agent-desk-${SUBAGENT_TOOLS[provider].toolName.replaceAll('_', '-')}`,
        name: '@deepseek-ai/dsh-tool-subagent',
        config: {
          provider: 'spawn',
          toolName: SUBAGENT_TOOLS[provider].toolName,
          backgroundMode: 'continuable',
          agentOptions: { provider, model },
        },
      })),
    })
    const { personaPrefix = '', personaSuffix = '' } = persona ?? {}
    rows.push({
      id: 'system-prompt',
      config: { personaPrefix, personaSuffix: [personaSuffix, subagentGuidance(pinned)].filter(Boolean).join('\n\n') },
    })
  }
  if (webSearch) {
    // A patch row replaces the plugin's whole config, so fetch is restated.
    rows.push({ id: 'web', config: { searchProvider: WEB_SEARCH_PROVIDER, fetchProvider: 'http' } })
    rows.push({ insert: [{ id: 'agent-desk-web-search', name: webSearch.plugin, config: { credentials: webSearch.credentials } }] })
  }
  const text = typeof instructions === 'string' ? instructions.trim() : ''
  if (text) rows.push({ insert: [{ id: 'agent-desk-instructions', name: INSTRUCTIONS_PLUGIN, config: { text } }] })
  return HEADER + YAML.stringify(rows)
}

/** dsh-base's delegation tools (`subagent`, `subagent_fork`, `send_message`, `list_agents`). */
const BASE_SUBAGENT_TOOLS = ['tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-subagent-list-agents']

/**
 * The extra layer (`dsh --patch`) of the runtimes that run agent teams'
 * children: no subagent tools, so a child does its own work and the team's
 * size stays what the user set. Applied after {@link homePatch}, so it also
 * removes the fixed-model tools that patch adds, with their prompt section.
 * Same options as homePatch (`subagents`, `persona`). The child's standing
 * instructions go in the system prompt ({@link TEAM_CHILD_PLUGIN}), where
 * compaction leaves them be.
 */
export function teamChildPatch({ subagents = [], persona = null } = {}) {
  const pinned = subagents.filter(({ provider, model }) => SUBAGENT_TOOLS[provider] && isModelId(model))
  const rows = [
    ...BASE_SUBAGENT_TOOLS.map((id) => ({ id, disabled: true })),
    ...pinned.map(({ provider }) => ({ id: `agent-desk-${SUBAGENT_TOOLS[provider].toolName.replaceAll('_', '-')}`, disabled: true })),
  ]
  if (pinned.length) {
    const { personaPrefix = '', personaSuffix = '' } = persona ?? {}
    rows.push({ id: 'system-prompt', config: { personaPrefix, personaSuffix } })
  }
  rows.push({ insert: [{ id: 'agent-desk-team-child', name: TEAM_CHILD_PLUGIN, config: { text: childPrompt() } }] })
  return `# Managed by Agent Desk: this file is rewritten on every start.
# Applied after cordis.patch.yml in the runtimes of agent teams' children:
# children have no subagent tools, and have their standing instructions.
${YAML.stringify(rows)}`
}

/**
 * The extra layer of the headless dsh that a Claude Code task's `subagent_gpt`
 * runs (gpt-subagent-mcp.js): the user's GPT subagent model, and no subagent
 * tools of its own, like a team's child. Same options as homePatch, plus the
 * model; null when no GPT subagent model is set.
 */
export function gptSubagentPatch({ subagents = [], subagentsEnabled = true, persona = null } = {}) {
  if (!subagentsEnabled) return null
  const gpt = subagents.find(({ provider, model }) => provider === 'openai-codex' && isModelId(model))
  if (!gpt) return null
  const pinned = subagents.filter(({ provider, model }) => SUBAGENT_TOOLS[provider] && isModelId(model))
  const rows = [
    { id: 'agent-default-model', config: { provider: gpt.provider, model: gpt.model } },
    ...BASE_SUBAGENT_TOOLS.map((id) => ({ id, disabled: true })),
    ...pinned.map(({ provider }) => ({ id: `agent-desk-${SUBAGENT_TOOLS[provider].toolName.replaceAll('_', '-')}`, disabled: true })),
  ]
  const { personaPrefix = '', personaSuffix = '' } = persona ?? {}
  rows.push({ id: 'system-prompt', config: { personaPrefix, personaSuffix } })
  return `# Managed by Agent Desk: this file is rewritten on every start.
# Applied after cordis.patch.yml in the headless dsh behind a Claude Code
# task's subagent_gpt: the user's GPT subagent model, without subagent tools.
${YAML.stringify(rows)}`
}

/** Writes the GPT subagent's layer ({@link gptSubagentPatch}), or removes it; true when the file changed. */
export async function writeGptSubagentPatch(file, options) {
  const next = gptSubagentPatch(options)
  if (next) return writePatch(file, next)
  try {
    await fs.rm(file)
    return true
  } catch {
    return false
  }
}

/** Writes the patch; returns true when the file changed. */
export async function writeHomePatch(file, options) {
  return writePatch(file, homePatch(options))
}

export function abPatch({ subagents = [], persona = null, writable = false, lean = true } = {}) {
  const disabled = [...BASE_SUBAGENT_TOOLS, 'tool-workflow', 'tool-goal', 'tool-plugin-manager', 'tool-ask-user',
    ...subagents.filter(({ provider }) => SUBAGENT_TOOLS[provider]).map(({ provider }) => `agent-desk-${SUBAGENT_TOOLS[provider].toolName.replaceAll('_', '-')}`),
    ...(!writable ? ['tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-skill'] : []),
    ...(!writable && lean ? ['tool-web'] : [])]
  return YAML.stringify([
    ...disabled.map((id) => ({ id, disabled: true })),
    // Remove the home layer's fixed-model delegation advice with its tools,
    // preserving the shipped persona just as teamChildPatch does.
    ...(subagents.some(({ provider, model }) => SUBAGENT_TOOLS[provider] && isModelId(model))
      ? [{ id: 'system-prompt', config: { personaPrefix: persona?.personaPrefix ?? '', personaSuffix: persona?.personaSuffix ?? '' } }] : []),
    ...(!writable ? [{ id: 'tool-fs', config: { write: false, edit: false } }] : []),
    { insert: [{ id: 'agent-desk-ab-policy', name: new URL('./ab-policy-plugin.js', import.meta.url).href, config: { writable } }] },
  ])
}
export async function writeAbPatches(paths, options) {
  const results = await Promise.all([
    writePatch(paths.abLeanPatch, abPatch({ ...options, lean: true })),
    writePatch(paths.abResearchPatch, abPatch({ ...options, lean: false })),
    writePatch(paths.abWritePatch, abPatch({ ...options, writable: true })),
  ])
  return results.some(Boolean)
}

/** Writes the children's layer ({@link teamChildPatch}); returns true when the file changed. */
export async function writeTeamChildPatch(file, options) {
  return writePatch(file, teamChildPatch(options))
}

async function writePatch(file, next) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  let current = null
  try {
    current = await fs.readFile(file, 'utf8')
  } catch {}
  if (current === next) return false
  await writeText(file, next, 0o600)
  return true
}
