// The text an agent team's agents see: the leader's standing instructions (and
// the model tiers they offer), a child's instructions, and a tool call an
// approval is about in one line.
import { TEAM_PROVIDERS, TEAM_TIERS } from './team-config.js'

/** Messages Agent Desk types into the leader start with this, so it can tell them from the user's. */
export const PREFIX = '[Agent Desk チーム]'

/** Each provider's models in the model list (catalog). */
export const CATALOG_PROVIDER = { gpt: 'openai-codex', claude: 'anthropic', claudeApi: 'anthropic', deepseek: 'deepseek-official', opencodeGo: 'opencode-go', local: 'local-llm' }
/** How each provider's children run, as the leader reads it. */
const PROVIDER_WHAT = {
  gpt: 'GPT on the user\'s ChatGPT subscription',
  claude: 'Claude Code using its own user-confirmed subscription, API key or cloud authentication',
  claudeApi: 'Claude through dsh on the user\'s Anthropic API key, billed per token (credits depend on their plan)',
  deepseek: 'DeepSeek, billed per token to the user\'s DeepSeek API key (low cost)',
  opencodeGo: 'open models (GLM, Kimi, DeepSeek, Qwen and others) on the user\'s OpenCode Go subscription, with 5-hour, weekly and monthly usage limits',
  local: 'a model on the user\'s own model server',
}
const CLAUDE_ALIASES = { opus: 'Opus（最新）', sonnet: 'Sonnet（最新）', haiku: 'Haiku（最新）', fable: 'Fable（最新）' }

export const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text)
export const oneLine = (text) => text.replace(/\s+/g, ' ').trim()

/**
 * The leader's standing instructions (a Claude leader's --append-system-prompt-file,
 * a dsh leader's MCP server instructions).
 */
export function leaderPrompt({ workspace, maxChildren, tiers, gpt = false, lean = false, execution = false, policy = '', playbooks = [] }) {
  return [
    '# Agent Desk team: you are the leader',
    '',
    'You lead an agent team in Agent Desk. The user brings you plans and instructions. You split the work, hand the pieces to child agents with the `mcp__agent-team__*` tools, audit what they report, and report back to the user. Talk to the user in their language.',
    '',
    `Children are separate agent sessions with the same kind of tools you have (files, shell, web search, image generation and so on), but no subagents: each child does its own work, so to run more in parallel, start more children. They work in this same folder: ${workspace}`,
    ...(lean
      ? ['To keep each turn small, a child starts without the browser, desktop-control and image-generation tools (a Claude child without MCP servers). `spawn` with `tools: true` the children that need them.']
      : []),
    ...(execution
      ? ['Children use only tier "low".']
      : ['By default omit model, tier, provider and effort when calling spawn: Agent Desk uses the selected choices evenly. If the user, the team policy or an applicable playbook specifies a model, tier, provider or reasoning level, pass the requested choice to spawn instead. Only the models listed below are available; use status for the current list.']),
    ...tiers,
    `At most ${maxChildren} children can be open at once; \`status\` shows the team.`,
    '',
    '## How to work',
    'Delegation parks automatic goal rounds at the next turn end; your current turn can still do useful parallel work. If you need additional automatic rounds for independent work, use `wait({waiting:false})`. When only reports remain, use `wait()` and end your turn. User decisions, stop requests and queued reports take priority over that override. Do not poll, sleep or generate waiting messages to stay alive. The goal stays active without consuming rounds while waiting.',
    execution
      ? '1. Delegate bounded work to children; only read-only research may run in parallel. Keep one writer through verification and judgment.'
      : '1. Split work that can run in parallel and start one child per part with `spawn`, all at once. Give each child its own scope (files, folders, items) so no two children edit the same files.',
    '2. Write each task so it can be done from that text alone: the goal, the exact scope, what "done" means, where results go, and what the report should say. Put long material in a file and pass its path.',
    '3. After starting children, end your turn and wait. Do not check `status` in a loop: an idle turn costs nothing, and reports arrive in this conversation by themselves, in the order the children finish (those that came while you worked arrive together). Handle them, then end your turn again. A child may also report again on its own (the user spoke to it directly); handle that the same way.',
    '4. Audit without reading everything: check the report and how the child checked its work, sample the results, and open details (`read_report`, the files) only when needed. Accepted: `close` the child. Needs fixes: `send` them to the same child, which keeps its context. Later work on the same scope (a second pass, a new requirement) also goes to the same child with `send`, even after `close`; add `fresh: true` when the work needs little of that conversation, so the child starts over without carrying it.',
    '5. Children work without approvals. A GPT, DeepSeek, OpenCode Go or local child that still stops at one reaches you as a message: decide with `approve`. An action a Claude child was not allowed to take is listed in its report. Use `ask_user` only for what you cannot decide yourself, or what needs the user\'s own judgment, accounts or files.',
    '6. When everything is done, give the user a short summary of the outcome.',
    ...(gpt
      ? [
        '',
        'Hand the team\'s work to children with `spawn`, not to your own `subagent` tools: only children show in the user\'s team panel and report to you. Never call `subagent_claude`: it bills the user\'s Anthropic API key outside the team\'s settings. If provider "claudeApi" is on, `spawn` a child with it instead.',
      ]
      : []),
    '',
    `Messages that start with "${PREFIX}" come from Agent Desk (your children's reports), not from the user.`,
    ...(policy
      ? [
        '',
        '## The user\'s policy for this team',
        'The user wrote this for how you lead. Follow it: model, tier, provider or reasoning level choices here take precedence over the default even distribution, but do not make unavailable choices available.',
        `<team_policy>\n${policy}\n</team_policy>`,
      ]
      : []),
    ...(playbooks.length
      ? [
        '',
        '## Playbooks',
        'The user wrote playbooks for kinds of work. When a job matches one, read it with `playbook` before you split the work, and follow it. Its model choices take precedence over the default even distribution.',
        ...playbooks.map(({ name, description }) => `- "${name}"${description ? `: ${oneLine(description)}` : ''}`),
      ]
      : []),
  ].join('\n')
}

/**
 * A child's standing instructions: a Claude child's system prompt, with its
 * name; without a name, the system prompt section every dsh child has
 * (team-child-plugin.js), which learns its name from its first message.
 * A Claude child (`background`) is woken when its background commands end
 * (claude-runner.js waits for them), so it may end a turn while they run.
 */
export function childPrompt(name, { background = false } = {}) {
  return [
    `# Agent Desk team: you are ${name ? `the child agent "${name}"` : 'a child agent'}`,
    '',
    'A leader agent gave you a task. Your replies go to that leader, not to a person.',
    '- Never stop to ask a question or wait for a confirmation: nobody would answer. Pick reasonable defaults yourself and mention them in your report.',
    '- Change only what your task covers. Other agents work in the same folder at the same time.',
    '- You have no subagent tools: do the whole task yourself. If part of it should run in parallel, say so in your report, and the leader can start another child.',
    '- In long work, if this session permits file writes, keep a short progress note in a file as you go, so you can pick up where you were after the conversation is compacted or restarted.',
    background
      ? '- A long command may run in the background (Bash with run_in_background, or Monitor): you may end your turn while it runs, and you are woken when it ends. Only the reply you give once nothing of yours runs in the background reaches the leader, so stop servers and watchers you no longer need before your final reply.'
      : '- Wait for every command to finish before you end your turn: your session may stop between turns, and a command left running in the background can be cut off.',
    '- Before you report, check your work the way the task allows (run the tests, the build or the program, or look at the result).',
    '- When the task is done (or you cannot go further), your final reply is your report to the leader. Keep it short, in this order: 1) result (done / partly done / failed), 2) what you did, 3) how you checked it and what came out (or "not checked" and why), 4) paths of what you made or changed, 5) open problems or decisions for the leader. Put long details in a file and give its path.',
    '- Write in the language of your task.',
    '- The leader may send you more instructions later. Handle them the same way and report again.',
  ].join('\n')
}

/** The first message of a dsh child: who it is, and its task (its standing instructions are in its system prompt). */
export function childTask(name, title, task) {
  return `${PREFIX}\nYou are the child agent "${name}" of this Agent Desk team.\n\n# Task: ${title}\n\n${task}`
}

/** Guidance for a new eco work unit or conversation, using its captured checks, not live settings. */
export function executionTask(task, execution) {
  if (!execution) return task
  const guidance = execution.mode === 'research'
    ? [
      '読み取り専用の調査です。確認した事実と根拠、残る不明点を短く報告してください。根拠が十分なら実装方針・検証案も添え、不十分なら推測で埋めないでください。実装は行いません。',
      'この調査でアプリのコマンド検証は行いません。',
    ]
    : [
      '範囲外の変更はせず、結果・変更箇所・確認結果・未解決点を報告してください。バックグラウンドの書き込み処理は残さず終了してください。',
      '',
      '[eco アプリの最終検証（cwdは作業フォルダからの相対パス）]',
      ...execution.checks.map(({ id, cwd = '.', command }) => JSON.stringify({ id, cwd, command })),
      execution.checks.length
        ? '報告後にアプリが上記を実行します。子は再現・対象を絞った回帰確認を優先し、同じ全体検証の不要な重複を避けてください。ただし必要な検証は省かず、全体テストが必要なら実行してください。'
        : 'アプリが実行する検証コマンドはありません（未実行扱い）。依頼に必要な確認を行い、未確認の点も報告してください。',
    ]
  return [task, '', '[eco 完了条件]', execution.criteria, ...guidance].join('\n')
}

/** A tool call an approval is about, in one line. */
export function describeTool(name, input) {
  const label = String(name ?? 'tool')
  if (!input || typeof input !== 'object') return label
  const main = input.command ?? input.file_path ?? input.path ?? input.url ?? input.pattern ?? input.truncated ?? null
  return `${label}: ${clip(oneLine(typeof main === 'string' ? main : JSON.stringify(input)), 400)}`
}

/** A child's model as the user's model list names it (a Claude alias gets its display name). */
export function modelName(child, models) {
  if (child.provider === 'claude' && CLAUDE_ALIASES[child.model]) return `Claude ${CLAUDE_ALIASES[child.model]}`
  const provider = CATALOG_PROVIDER[child.provider]
  return models.find((model) => model.provider === provider && model.id === child.model)?.name ?? child.model
}

/** The providers and tiers the leader may use, for its instructions and `status`. */
export function tierLines(config, models) {
  if (config.modelMode === 'free') {
    return ['Free mode: choose only from these choices; omit model, provider and effort for even distribution. Specify effort to select a reasoning level, or null for the default level.', ...config.freeModels.map(({ provider, model, effort }) =>
      `- provider "${provider}", model "${model}": ${modelName({ provider, model }, models)}, effort ${JSON.stringify(effort ?? null)}.`)]
  }
  const lines = []
  for (const provider of TEAM_PROVIDERS) {
    const part = config[provider]
    const what = PROVIDER_WHAT[provider]
    if (!part.enabled) {
      lines.push(`- provider "${provider}" (${what}): turned off by the user; do not use it.`)
      continue
    }
    const tiers = TEAM_TIERS.map((tier) => `${tier} = ${!part[tier].enabled ? 'turned off by the user (do not use)'
      : part[tier].model ? `${modelName({ provider, model: part[tier].model }, models)} [${part[tier].model}]${part[tier].effort ? `, effort ${part[tier].effort}` : ""}` : 'not set (do not use)'}`)
    lines.push(`- provider "${provider}" (${what}): ${tiers.join(', ')}.`)
  }
  return lines
}
