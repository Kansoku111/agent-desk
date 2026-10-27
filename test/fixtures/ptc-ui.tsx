// Browser regression fixture: no real model, app data, or processes are used.
import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../web/src/styles.css'

const model = '["openai-codex","fixture"]'
const workspace = 'C:\\fixture'
const requests: any[] = []
let fail = '', delay = '', release: (() => void) | undefined
const config: any = { a: model, b: model, leader: model, implementer: model, efforts: { a: 'medium', b: 'medium', leader: 'medium', implementer: 'medium' }, lean: true, delegate: true, review: true, toolMode: 'native' }
const provider = (enabled = false) => ({ enabled, low: { enabled: true, model: 'fixture', effort: 'medium' }, mid: { enabled: true, model: 'fixture', effort: 'medium' } })
const teamConfig: any = { leaderProvider: 'gpt', gptLeader: { model: 'fixture', effort: 'medium' }, leader: { model: 'opus', effort: null },
  leaderBypass: true, batchReports: true, leanChildren: false, maxChildren: 6, policy: null, toolMode: 'native',
  gpt: provider(true), claude: provider(), claudeApi: provider(), deepseek: provider(), opencodeGo: provider(), local: provider() }
let savedModels: any = { leader: model, provider: 'gpt', model: 'fixture', leaderEffort: 'medium', childEffort: 'medium', toolMode: 'native' }
const run: any = { id: 'run', workspace, title: 'PTC fixture', text: 'original request', config: { ...config }, phase: 'completed', jobs: [], messages: [], revision: 1, createdAt: 1, updatedAt: 1 }
const team: any = { id: 'team', workspace, leaderId: 'leader', leaderKind: 'thread', config: { ...teamConfig }, toolModeBusy: false,
  children: [], queue: [], asks: [], approvals: [], delivery: 'idle', createdAt: 1, updatedAt: 1 }
let socket: Socket
class Socket {
  static CLOSING = 2
  readyState = 1
  onmessage?: (event: any) => void
  onopen?: () => void
  constructor() { socket = this; queueMicrotask(() => this.onopen?.()) }
  send(body: string) {
    const input = JSON.parse(body); requests.push(input)
    const reply = () => {
      let result: any = {}
      if (fail !== input.type) {
        if (input.type === 'ab.config') result = { config }
        if (input.type === 'ab.configure') Object.assign(config, input.config)
        if (input.type === 'ab.update') { run.config = { ...run.config, toolMode: input.toolMode }; this.event({ type: 'ab', run }) }
        if (input.type === 'team.update') { team.config = { ...team.config, ...input.patch }; this.event({ type: 'team', team }) }
        if (input.type === 'team.create') result = { team: { ...team, config: input.choices } }
        if (input.type === 'execution.models') result = { models: savedModels }
        if (input.type === 'execution.setModels') { savedModels = input.models; result = { models: savedModels } }
        if (input.type === 'execution.checks') result = { checks: [] }
      }
      this.onmessage?.({ data: JSON.stringify({ id: input.id, ok: fail !== input.type, result, error: 'fixture failure' }) })
    }
    if (delay === input.type) release = reply
    else setTimeout(reply, 0)
  }
  event(frame: any) { this.onmessage?.({ data: JSON.stringify({ ...frame, event: frame.type }) }) }
}
Object.assign(window, { WebSocket: Socket })
sessionStorage.setItem('agent-desk-token', 'fixture')
const store = await import('../../web/src/store')
const { AbStartDialog, AbView } = await import('../../web/src/components/Ab')
const { TeamStartDialog, TeamConfigDialog } = await import('../../web/src/components/TeamSettings')
const { TeamPanel } = await import('../../web/src/components/TeamPanel')
const { ExecutionStartDialog } = await import('../../web/src/components/ExecutionSettings')
const server: any = { app: { remote: false, myPc: workspace }, openTargets: {}, settings: { agentTeams: teamConfig, modelVisibility: {}, projectNames: {} },
  accounts: { chatgpt: { signedIn: true }, claude: { configured: false }, deepseek: { configured: false } },
  catalog: { models: [{ value: model, id: 'fixture', provider: 'openai-codex', name: 'Fixture GPT' }], providers: {},
    fallbackEfforts: [], effortsByModel: { [model]: [{ value: 'medium', name: 'Medium' }] } }, ab: [run], teams: [team], threads: [] }
store.setState({ server })
store.connect()
function TeamFixture({ eco }: { eco: boolean }) {
  const current = store.useStore((state) => state.server!.teams!.find((entry) => entry.id === team.id))!
  return <TeamPanel team={{ ...current, execution: eco ? { stopped: false, metrics: { childTurns: 0, parentReports: 0, verifications: 0, repairs: 0 } } : undefined }} />
}
const root = createRoot(document.getElementById('root')!)
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 50))
const check = (value: unknown, message: string) => { if (!value) throw new Error(message) }
let generation = 0
const render = async (kind: string) => {
  const key = ++generation
  root.render(kind === 'ab-start' ? <AbStartDialog key={key} workspace={workspace} /> : kind === 'tm-start' ? <TeamStartDialog key={key} workspace={workspace} />
    : kind === 'tm-config' ? <TeamConfigDialog key={key} team={team} onClose={() => {}} />
    : kind === 'eco-start' ? <ExecutionStartDialog key={key} workspace={workspace} /> : kind === 'ab' ? <AbView key={key} id="run" /> : <TeamFixture key={key} eco={kind === 'eco'} />)
  await tick()
}
const toggle = () => document.querySelector<HTMLButtonElement>('button[aria-label="PTC"]')!
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label)!
const api = {
  requests, render,
  async setupTeamFree() {
    Object.assign(teamConfig, { defaultModelMode: 'free', modelMode: 'free', freeModels: [{ provider: 'gpt', model: 'fixture', effort: 'medium' }] })
    team.config = { ...teamConfig }
    server.catalog.effortsByModel[model] = ['low', 'medium', 'high', 'max'].map((value) => ({ value, name: value }))
    await render('tm-start')
  },
  async runTeamFree() {
    await this.setupTeamFree()
    const duplicate = (index: number) => document.querySelector<HTMLButtonElement>(`button[aria-label="モデル ${index}を別の推論レベルで追加"]`)!
    const effort = (index: number) => document.querySelector<HTMLButtonElement>(`button[aria-label^="モデル ${index}の推論レベル:"]`)!
    check(duplicate(1)?.parentElement?.textContent?.trim().startsWith('モデル 1'), 'plus follows the model label')
    duplicate(1).click(); await tick()
    duplicate(2).click(); await tick()
    check(effort(1).textContent?.includes('中') && effort(2).textContent?.includes('高') && effort(3).textContent?.includes('最大'), 'separate medium/high/max choices')
    effort(1).click(); await tick()
    const options = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    check(!options.some((item) => ['高', '最大'].includes(item.textContent?.trim() ?? '')), 'other selected efforts are not offered')
    options.find((item) => item.textContent?.trim() === '低')!.click(); await tick()
    check(document.activeElement === effort(1), 'focus returns to the effort selector')
    button('始める').click(); await tick(); await tick()
    const created = requests.filter((item) => item.type === 'team.create').at(-1)?.choices.freeModels
    check(JSON.stringify(created?.map((entry: any) => entry.effort)) === JSON.stringify(['low', 'high', 'max']), 'start sends each level')
    team.config = { ...teamConfig, freeModels: created }
    await render('tm-config')
    check(effort(2).textContent?.includes('高') && effort(3).textContent?.includes('最大'), 'running team retains the levels')
    duplicate(1).click(); await tick()
    check(effort(2).textContent?.includes('中') && duplicate(1).disabled, 'remaining level is added and plus is disabled')
    button('保存').click(); await tick(); await tick()
    const saved = requests.filter((item) => item.type === 'team.update').at(-1)?.patch.freeModels
    check(JSON.stringify(saved?.map((entry: any) => entry.effort)) === JSON.stringify(['low', 'medium', 'high', 'max']), 'update sends each level')
    await render('tm-config')
    check(document.querySelectorAll('.team-free-model-row').length === 4, 'saved variants reopen')
    effort(1).click(); await tick()
    const defaultChoice = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === '既定')!
    defaultChoice.click(); await tick()
    duplicate(1).click(); await tick()
    check(effort(1).textContent?.includes('既定') && effort(2).textContent?.includes('低'), 'default remains visible when all explicit levels are used')
    const rect = duplicate(1).getBoundingClientRect()
    check(rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth, 'plus fits viewport')
    button('モデルを選択').click(); await tick()
    document.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"][aria-checked="true"]')!.click(); await tick()
    check(document.querySelectorAll('.team-free-model-row').length === 0, 'unchecking removes all variants')
    return ['label / distinct efforts / focus', 'start and update payload / reopen', 'viewport / uncheck all variants']
  },
  async run() {
    const passed: string[] = []
    for (const kind of ['ab-start', 'tm-start', 'eco-start']) {
      await render(kind)
      check(toggle()?.textContent === 'PTC OFF', kind + ' defaults off')
      toggle().click(); await tick()
      check(toggle().getAttribute('aria-pressed') === 'true', kind + ' switches on')
      if (kind === 'ab-start') {
        check(requests.filter((item) => item.type === 'ab.configure').at(-1)?.config.toolMode === 'ptc', 'AB config is saved')
        await render(kind); check(toggle().textContent === 'PTC ON', 'AB reopen preserves selection')
      } else {
        button('始める').click(); await tick(); await tick()
        const input = requests.filter((item) => item.type === 'team.create').at(-1)
        check(input?.choices.toolMode === 'ptc', kind + ' passes mode to team creation')
        if (kind === 'eco-start') {
          check(savedModels.toolMode === 'ptc', 'eco preference is saved')
          await render(kind); check(toggle().textContent === 'PTC ON', 'eco reopen preserves selection')
        }
      }
      passed.push(kind + ': selection / payload / preference')
    }
    for (const kind of ['ab', 'tm', 'eco']) {
      run.phase = 'completed'; run.config.toolMode = 'native'; team.toolModeBusy = false; team.config.toolMode = 'native'
      socket.event({ type: 'ab', run }); socket.event({ type: 'team', team })
      await render(kind)
      const method = kind === 'ab' ? 'ab.update' : 'team.update'
      fail = method; toggle().click(); await tick()
      check(toggle().textContent === 'PTC OFF', kind + ' failed save is not shown as applied'); fail = ''
      delay = method
      const before = requests.filter((item) => item.type === method).length
      toggle().click(); await tick(); check(toggle().disabled, kind + ' saving disables duplicate input')
      toggle().click(); await tick(); check(requests.filter((item) => item.type === method).length === before + 1, kind + ' no duplicate save')
      delay = ''; release?.(); await tick()
      check(toggle().textContent === 'PTC ON', kind + ' acknowledged update is displayed')
      if (kind === 'ab') run.phase = 'consulting'
      else team.toolModeBusy = true
      socket.event({ type: 'ab', run }); socket.event({ type: 'team', team })
      await render(kind); check(toggle().disabled, kind + ' running disables mode changes')
      passed.push(kind + ': save failure / busy / acknowledgment')
    }
    team.toolModeBusy = false
    socket.event({ type: 'team', team })
    await render('eco')
    const rect = toggle().getBoundingClientRect()
    check(rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth, 'PTC control fits viewport')
    return passed
  },
}
Object.assign(window, { ptcTest: api })
await render('ab-start')
