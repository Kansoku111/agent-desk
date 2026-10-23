// Shapes shared with the Agent Desk server (see server/*.js).

export type PermissionMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type ThreadStatus = 'idle' | 'running' | 'error'
export type Theme = 'system' | 'light' | 'dark'

export interface ThreadSummary {
  id: string
  title: string
  workspace: string
  model: string | null
  effort: string
  permissionMode: PermissionMode
  sessionId: string | null
  createdAt: number
  updatedAt: number
  archived: boolean
  usage: { used: number; size: number } | null
  status: ThreadStatus
  pendingApproval: boolean
  /** Set when the task is a child of an agent team (server/teams.js). */
  /** The agent team this task works for: as a child ({ id, childId }), or as a GPT leader ({ id, role: 'leader' }). */
  team?: { id: string; childId?: string; role?: 'leader' }
}

/** A Claude Code task ("CL"): the user's own `claude` CLI in a terminal (server/terminals.js). */
export interface TerminalSummary {
  id: string
  title: string
  workspace: string
  sessionId: string
  createdAt: number
  updatedAt: number
  archived: boolean
  /** `running`: the process is up; `exited`: it ended (its last screen stays); `stopped`: not started since the app started. */
  state: 'running' | 'exited' | 'stopped'
  /** From Claude Code's hooks: working on a prompt, waiting for an approval, or idle. */
  activity: 'idle' | 'running' | 'approval'
  /** Agents or commands that go on in the background after the turn ended; starting Claude Code again would end them. */
  background: number
  /** What each of them is (a command or its description, an agent type) and since when it runs. */
  backgroundWork?: { label: string; since: number }[]
  exitCode: number | null
  /** Chosen in Agent Desk and passed as `claude --model` / `--effort`; null leaves Claude Code's own default. */
  model: string | null
  effort: string | null
  /** What Claude Code reports using (its hooks), also after a `/model` typed in the terminal. */
  modelInUse: string | null
  effortInUse: string | null
  /** An agent team's leader or Claude child (server/teams.js); null for a task of its own. */
  team: { id: string; role: 'leader' | 'child'; childId?: string } | null
}

/** Who a team's children run on (Claude (API), DeepSeek and local: as a dsh task on the user's API key or own server). */
export type TeamProvider = 'gpt' | 'claude' | 'claudeApi' | 'deepseek' | 'local'
/** Who can lead a team. */
export type TeamLeaderProvider = 'gpt' | 'claude'
export type TeamTier = 'low' | 'mid'
/** `removed`: the child's task was deleted on its own. */
export type TeamChildState = 'running' | 'approval' | 'idle' | 'closed' | 'error' | 'stopped' | 'removed' | 'resuming'

/** One child agent of a team: a dsh task (GPT, Claude (API), DeepSeek) or headless Claude Code (Claude). */
export interface TeamChild {
  id: string
  name: string
  /** The job the leader gave it, shown to the user. */
  title: string
  provider: TeamProvider
  tier: TeamTier
  model: string
  modelName: string
  effort: string | null
  /** `agent`: Claude Code run headless; its turns come with team.childTurns and `agentTurn` frames. */
  kind: 'thread' | 'agent'
  taskId: string | null
  state: TeamChildState
  closed: boolean
  /** Working on something the leader sent; its report goes to the leader. */
  awaiting: boolean
  /** Messages from the leader waiting for the child to be free. */
  pending: number
  /** What the user wrote to a Claude child while it worked: sent when its turn ends, or at once with "割り込む". */
  followups: { id: string; text: string }[]
  createdAt: number
  updatedAt: number
  reports: number
  lastReport: { at: number; kind: string; text: string } | null
}

/** Sanitized CLI auth metadata only: no credentials or account identity. */
export interface ClaudeAuthInspection {
  descriptor: {
    version: 1
    mode: 'subscription' | 'api' | 'cloud' | 'unknown' | 'logged-out'
    authMethod: string
    apiProvider: string
  }
  challenge: string | null
  confirmed: boolean
}

export interface ClaudeAuthConfirmation {
  challenge: string
  acknowledgeUnknown?: boolean
}

/** An agent team ("TM"): a Claude Code or GPT leader and its children. */
export interface TeamSummary {
  id: string
  workspace: string
  leaderId: string
  /** `terminal`: Claude Code leads; `thread`: GPT leads, as a dsh task. */
  leaderKind: 'terminal' | 'thread'
  /** The team's own settings: chosen when it started, changed in its panel since. */
  config?: TeamSettings
  createdAt: number
  updatedAt: number
  children: TeamChild[]
  /** Reports waiting to be typed into the leader, oldest first. */
  queue: { id: string; childId: string; kind: string; at: number }[]
  /** `failed`: a report did not reach the leader; `leader-stopped`: reports wait for the leader to run again. */
  delivery: 'idle' | 'delivering' | 'failed' | 'leader-stopped' | 'waiting'
  /** Children stopped at an approval: the leader (or the user) decides. */
  approvals: { id: string; childId: string; tool: string; at: number }[]
  /** Questions the leader asked the user (ask_user) and that are not answered yet. */
  asks: { id: string; at: number; text: string; childId: string | null }[]
}

export interface TeamTierSettings {
  /** false: the leader may not use this tier (older saves lack it: on). */
  enabled?: boolean
  /** null: not set (GPT, DeepSeek), or Claude Code's own default. */
  model: string | null
  effort: string | null
}

/** 設定 → エージェントチーム (server/team-config.js). */
export interface TeamSettings {
  /** Who leads a new team. */
  leaderProvider: TeamLeaderProvider
  /** A Claude Code leader's model. */
  leader: { model: string | null; effort: string | null }
  /** A GPT leader's model (null: the GPT "mid" tier's). */
  gptLeader: { model: string | null; effort: string | null }
  leaderBypass: boolean
  /** Reports that wait while the leader works reach it in one message (older saves lack it: on). */
  batchReports?: boolean
  /** Children start without the browser, desktop and image tools unless the leader asks (older saves lack it: off). */
  leanChildren?: boolean
  gpt: { enabled: boolean; low: TeamTierSettings; mid: TeamTierSettings }
  claude: { enabled: boolean; low: TeamTierSettings; mid: TeamTierSettings }
  /** Older saves lack it (off). */
  claudeApi?: { enabled: boolean; low: TeamTierSettings; mid: TeamTierSettings }
  /** Older saves lack it (off). */
  deepseek?: { enabled: boolean; low: TeamTierSettings; mid: TeamTierSettings }
  /** Older saves lack it (off). */
  local?: { enabled: boolean; low: TeamTierSettings; mid: TeamTierSettings }
  maxChildren: number
  /** The policy a new team's leader reads (TeamPolicy.id); null or missing: none. */
  policy?: string | null
}

/** A named policy a team's leader reads in full (server/team-playbooks.js). */
export type TeamPolicy = {
  id: string
  name: string
  text: string
}

/** A playbook: leaders see its name and description, and open the body when the work calls for it. */
export type TeamPlaybook = {
  id: string
  name: string
  description: string
  body: string
}

export interface ImageRef {
  file: string
  mimeType: string
  name: string
}

export interface PermissionOption {
  optionId: string
  name: string
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
}

export interface ToolItem {
  type: 'tool'
  id: string
  name: string
  kind: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  input?: Record<string, unknown>
  output?: string
  startedAt?: number
  endedAt?: number
  permission?: { requestId: string; options: PermissionOption[] }
  decision?: 'allowed' | 'rejected' | 'cancelled'
}

export interface TextItem {
  type: 'agent' | 'thought'
  id: string
  text: string
}

export interface NoticeItem {
  type: 'notice'
  id: string
  level: 'info' | 'warning'
  text: string
}

export interface PlanItem {
  type: 'plan'
  id: string
  entries: { content: string; status: string; priority?: string }[]
}

/** A message the user added while the turn ran; the agent read it at its next step. */
export interface SteerItem {
  type: 'steer'
  id: string
  text: string
  images: ImageRef[]
  at: number
  /** In a subagent's view: sent by another agent (its parent) rather than given as its task. */
  from?: 'agent'
}

export type TurnItem = ToolItem | TextItem | NoticeItem | PlanItem | SteerItem

export interface Turn {
  id: string
  startedAt: number
  endedAt: number | null
  status: 'running' | 'done' | 'cancelled' | 'error'
  stopReason: string | null
  error: { message: string; detail?: string } | null
  user: { text: string; images: ImageRef[] }
  items: TurnItem[]
  usage?: TurnUsage
  /** Workspace snapshots around the turn; `changed` counts the files the turn changed. */
  checkpoint?: { before?: string; after?: string; changed?: number; error?: string }
  /** Set when the files were put back to before this turn. */
  restore?: { at: number; undo: string; files: number; turns: number }
  /** The turn whose restore undid this turn's file changes. */
  revertedBy?: string
}

export type SubagentStatus = 'starting' | 'running' | 'done' | 'error' | 'cancelled' | 'stopped'

/** A subagent a task started, folded from its dsh log (server/subagents.js). */
export interface SubagentInfo {
  /** The child's dsh session id. */
  id: string
  /** The session that started it: the task's own, or another subagent's. */
  parentId: string | null
  depth: number
  /** The parent's tool call that started it (matches a ToolItem id). */
  callId: string | null
  label: string | null
  mode: 'one-shot' | 'continuable' | null
  title: string | null
  provider: string | null
  model: string | null
  modelName: string | null
  effort: string | null
  status: SubagentStatus
  startedAt: number | null
  updatedAt: number | null
  endedAt: number | null
  /** The task it was given. */
  prompt: string
  items: TurnItem[]
  usage: { requests: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number | null }
}

export type RestoreAction = 'restore' | 'recreate' | 'delete'

/** Tokens a turn consumed; `cost` (USD) only for per-token billed routes. */
export interface TurnUsage {
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  cost: number | null
  models: string[]
}

export interface CatalogModel {
  value: string
  provider: string
  id: string
  name: string
  description: string | null
  /** The ChatGPT account's own model list no longer has this model (OpenAI retired it). */
  retired?: boolean
}

export interface Effort {
  value: string
  name: string
}

export interface Catalog {
  providers: Record<string, string>
  models: CatalogModel[]
  effortsByModel: Record<string, Effort[]>
  fallbackEfforts: Effort[]
}

export interface Accounts {
  chatgpt: { signedIn: boolean; email?: string | null; plan?: string | null; expiresAt?: number | null; official?: boolean; planEnabled?: boolean; needsOfficialLogin?: boolean }
  codex?: { signedIn: boolean; email?: string | null; plan?: string | null }
  claude: { configured: boolean; masked: string | null; workspaceId: string | null }
  deepseek: { configured: boolean; masked: string | null }
  /** configured: a server URL with models; keyed: a key is stored for it. Older servers lack it. */
  localLlm?: { configured: boolean; keyed: boolean; masked: string | null }
  claudeAdmin: { configured: boolean; masked: string | null }
  error: string | null
}

export type FastProvider = 'openai-codex' | 'anthropic'

export interface Settings {
  theme: Theme
  defaultModel: string | null
  defaultEffort: string
  defaultPermissionMode: PermissionMode
  workspaces: string[]
  lastWorkspace: string | null
  notifications: boolean
  anthropicWorkspaceId: string | null
  /** Picker visibility keyed by ACP model value; missing entries are visible. */
  modelVisibility: Record<string, boolean>
  browserTool: boolean
  browserHeadless: boolean
  desktopTool: boolean
  imageTool: boolean
  checkpoints: boolean
  projectNames: Record<string, string>
  /** Sidebar tint of each project: an index into PROJECT_HUES, or -1 for none. */
  projectColors: Record<string, number>
  contextLimits: Record<'openai-codex' | 'anthropic', number | null>
  /** Model of each fixed-model subagent tool; null leaves the tool out. */
  subagentModels: Record<'openai-codex' | 'anthropic', string | null>
  /** Fast mode per provider; applies to the models in `AppState.fastModels`. */
  fastMode: Record<FastProvider, boolean>
  dshUpdateChannel: UpdateChannel
  /** New Claude and GPT models come from the newest pi-ai release by themselves. */
  modelAutoUpdate: boolean
  /** Phones on the same tailnet may use the app. */
  remoteAccess: boolean
  /** Standing instructions the agent reads before every task (設定 → パーソナライズ). */
  customInstructions: string
  /** A local OpenAI-compatible server and the models it listed (older saves lack it). */
  localLlm?: { baseURL: string | null; models: { id: string; contextWindow?: number }[] }
  agentTeams: TeamSettings
  /** Older saves lack them (none). */
  teamPolicies?: TeamPolicy[]
  teamPlaybooks?: TeamPlaybook[]
}

/**
 * Remote access (phones over Tailscale). A phone only learns that it is one
 * (`viewer`); the link with its token is shown on the PC.
 */
export type RemoteAccessState =
  | { enabled: true; phase: 'listening'; viewer: true }
  | {
    enabled: boolean
    phase: 'off' | 'listening' | 'no-tailscale' | 'stopped' | 'error'
    viewer?: undefined
    error: string | null
    port: number
    addresses: string[]
    dnsName: string | null
    /** Whether the Tailscale CLI answered. */
    cli: boolean
    /** The other devices on the tailnet (null without the CLI). */
    peers: { name: string; os: string; online: boolean }[] | null
    /** The Tailscale account this PC is signed in to. */
    login: string | null
    /** Windows Firewall for the phone port; null when unknown or not Windows. */
    firewall: 'allowed' | 'blocked' | 'denied' | null
    url: string | null
    qrSvg: string | null
    /** Phones connected now. */
    clients: number
  }

/** npm dist-tags of dsh, from the most to the least stable. */
export type UpdateChannel = 'latest' | 'next' | 'alpha'

interface ReleaseItem {
  installed: string
  available: string | null
  error: string | null
  /** What to hand an AI agent to do the update; null without an offer or a source checkout. */
  prompt: string | null
}

/** Newer releases of dsh, the bundled Codex and Claude Code. */
export interface Updates {
  checking: boolean
  checkedAt: number | null
  /** Agent Desk runs from a git checkout (an agent can change its code). */
  source: boolean
  dsh: ReleaseItem
  codex: ReleaseItem
  /** `installed` is null when Claude Code is not installed. */
  claude: { installed: string | null; available: string | null; error: string | null; updating: boolean }
}

export interface AddedModel {
  provider: 'openai-codex' | 'anthropic'
  id: string
  name: string
}

/** Models newer than the installed dsh, read from the newest pi-ai release. */
export interface ModelUpdate {
  phase: 'idle' | 'checking'
  checkedAt: number | null
  /** Newest pi-ai release on npm when last checked. */
  latest: string | null
  /** The pi-ai release the added models come from. */
  source: string | null
  error: string | null
  /** The models the last release to bring any added. */
  lastAdded: { at: number; source: string; models: AddedModel[] } | null
  /** Every model Agent Desk adds to dsh's list now. */
  models: (AddedModel & { source: 'bundled' | 'fetched' | 'account' })[]
  /** The ChatGPT account's model list, which Agent Desk follows (adds from it, flags retired models). */
  account: {
    /** 'ok'; 'signed-out' without a ChatGPT sign-in; 'error' when the list could not be read; null before the first try. */
    status: 'ok' | 'signed-out' | 'error' | null
    checkedAt: number | null
    /** Models in the catalog that the account's list no longer has. */
    retired: AddedModel[]
  }
}

export type LoginState =
  | { phase: 'idle' }
  | { phase: 'starting'; method?: 'browser' | 'device' }
  | { phase: 'browser'; method?: 'browser'; url?: string }
  | { phase: 'device'; method?: 'device'; userCode: string; verificationUri: string; expiresAt?: number }
  | { phase: 'done' }
  | { phase: 'error'; message: string }

export interface AppState {
  /** `remote`: this page is a phone using remote access, not a window on the PC. */
  app: { version: string; dshVersion: string; platform: string; dataDir: string; myPc: string; uiBuild: string; remote: boolean }
  settings: Settings
  accounts: Accounts
  catalog: Catalog
  /** Models that offer fast mode, with a short note (e.g. "1.5x speed"), by provider and model id. */
  fastModels: Record<FastProvider, Record<string, string>>
  threads: ThreadSummary[]
  terminals: TerminalSummary[]
  teams: TeamSummary[]
  runtime: Record<PermissionMode, 'stopped' | 'starting' | 'ready' | 'failed'>
  login: LoginState
  codexLogin?: LoginState
  chatgptUsage: ChatGptUsage | null
  claudeLimits: ClaudeLimits | null
  openTargets: { files: boolean; terminal: boolean }
  permissionModes: PermissionMode[]
  updates: Updates
  modelUpdate: ModelUpdate
  usage: UsageState
  remoteAccess: RemoteAccessState
}

/** Tokens summed over many responses; `cost` (USD) only for per-token billed models. */
export interface UsageTotals {
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  cost: number | null
}

/** Usage estimated from dsh's logs, across every task. Days are local. */
export interface LocalUsage {
  today: UsageTotals
  month: UsageTotals
  all: UsageTotals
  since: string | null
  providers: Record<string, { today: UsageTotals; month: UsageTotals; all: UsageTotals }>
  models: { model: string; month: UsageTotals; all: UsageTotals }[]
  daily: { day: string; cost: number; tokens: number }[]
  updatedAt: number
}

/** The Claude organization's billed cost (USD) from the Admin API. Days are UTC. */
export interface ClaudeCostSummary {
  today: number
  month: number
  last30: number
  all: number
  since: string | null
  models: { label: string; month: number; all: number }[]
  months: { month: string; amount: number }[]
}

export interface ClaudeCostState {
  status: 'none' | 'needs-admin' | 'ok' | 'invalid' | 'forbidden' | 'error'
  source: 'admin' | 'api' | null
  fetchedAt: number | null
  message: string | null
  summary: ClaudeCostSummary | null
}

export interface UsageState {
  local: LocalUsage | null
  claude: ClaudeCostState
}

export interface ChatGptUsageWindow {
  label: string
  seconds: number
  usedPercent: number
  resetAt: number | null
}

export type ChatGptUsage =
  | { status: 'ok'; plan: string | null; limitReached: boolean; windows: ChatGptUsageWindow[]; fetchedAt: number }
  | { status: 'signed-out' | 'expired' }
  | { status: 'error'; message: string }

/** The Claude subscription's limits as the team's last `claude -p` run reported them. */
export interface ClaudeLimits {
  status: 'ok'
  windows: ChatGptUsageWindow[]
  fetchedAt: number
}

export interface Attachment extends ImageRef {
  previewUrl: string
}
