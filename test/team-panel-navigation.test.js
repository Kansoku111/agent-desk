import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

// Render the real view functions without mounting their unrelated chat/terminal dependencies.
async function harness(execution) {
  const team = { id: 'team', leaderId: 'leader', leaderKind: 'thread', execution, approvals: [], asks: [],
    children: [{ id: 'gpt', kind: 'thread', taskId: 'gpt-task' }, { id: 'claude', kind: 'agent', taskId: 'claude-task' }] }
  const state = { route: { view: 'thread', id: 'leader' }, teamPanel: true, subagentPanel: true, turns: {}, agentTurns: {},
    server: { teams: [team], threads: [
      { id: 'leader', title: 'Leader' },
      { id: 'gpt-task', title: 'Child', team: { id: team.id, childId: 'gpt' } },
      { id: 'standalone', title: 'Standalone' },
    ], terminals: [], catalog: { models: [] }, app: {}, settings: {} } }
  const jsx = (type, props) => ({ type, props })
  const react = { memo: (fn) => fn, useState: (value) => [value, () => {}],
    useRef: () => ({ current: null }), useEffect() {}, useLayoutEffect() {} }
  const store = { useStore: (select) => select(state), useRemote: () => false,
    setTeamPanel: (open) => { state.teamPanel = open },
    navigate: (route) => { state.route = route },
    openTeamChild: (child) => { state.route = { view: child.kind, id: child.taskId } },
    teamChildOf: (server, taskId) => {
      const child = team.children.find((entry) => entry.kind === 'agent' && entry.taskId === taskId)
      return child ? { team, child } : null
    } }
  const modules = { react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../store': store,
    '../drafts': { useDraft: () => ['', () => {}], useImeField: () => ({}) },
    '../util': { workspaceLabel: () => 'Workspace', parseModel: () => null },
    './TerminalPickers': { claudeModelName: () => 'Claude' } }
  async function load(name, extra = '') {
    const source = await fs.readFile(new URL('../web/src/components/' + name + '.tsx', import.meta.url), 'utf8')
    const { outputText } = ts.transpileModule(source + extra, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    })
    const exports = {}
    new Function('require', 'exports', outputText)((name) => modules[name] ?? {}, exports)
    return exports
  }
  const panel = await load('TeamPanel', '\nexport { ChildCard }')
  modules['./TeamPanel'] = panel
  const thread = await load('ThreadView', '\nexport { Header }')
  const agent = await load('AgentView')
  function find(node, type) {
    if (!node || typeof node !== 'object') return undefined
    if (node.type === type) return node
    for (const child of [node.props?.children].flat(Infinity)) {
      const found = find(child, type)
      if (found) return found
    }
  }
  return { state, team, panel, thread, agent, find }
}

for (const mode of ['TM', 'eco']) {
  test(mode + ': sidebar follows leader → GPT child → Claude child → sibling without returning to leader', async () => {
    const h = await harness(mode === 'eco' ? {} : undefined)
    for (const id of ['leader', 'gpt-task', 'claude-task', 'gpt-task', 'leader']) {
      const view = id === 'claude-task' ? h.agent.AgentView({ taskId: id }) : h.thread.ThreadView({ threadId: id })
      assert.equal(h.find(view, h.panel.TeamPanel)?.props.team, h.team, id)
      const header = id === 'claude-task' ? view : h.thread.Header({ thread: h.state.server.threads.find((t) => t.id === id) })
      const toggle = h.find(header, h.panel.TeamToggle)
      assert.equal(toggle.props.team, h.team)
      h.panel.TeamToggle(toggle.props).props.onClick()
      assert.equal(h.state.teamPanel, false)
      const closed = id === 'claude-task' ? h.agent.AgentView({ taskId: id }) : h.thread.ThreadView({ threadId: id })
      assert.equal(h.find(closed, h.panel.TeamPanel), undefined)
      h.panel.TeamToggle(toggle.props).props.onClick()
      assert.equal(h.state.teamPanel, true)
    }
  })
  test(mode + ': unrelated tasks do not inherit the previous team sidebar', async () => {
    const h = await harness(mode === 'eco' ? {} : undefined)
    assert.equal(h.find(h.thread.ThreadView({ threadId: 'standalone' }), h.panel.TeamPanel), undefined)
  })
}

function nodes(node, match) {
  if (!node || typeof node !== 'object') return []
  return [...(match(node) ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap((child) => nodes(child, match))]
}

for (const mode of ['TM', 'eco']) {
  for (const kind of ['thread', 'terminal']) {
    test(mode + '/' + kind + ': leader is the first card and sidebar selection follows navigation', async () => {
      const h = await harness(mode === 'eco' ? {} : undefined)
      h.team.leaderKind = kind
      if (kind === 'terminal') h.state.server.terminals.push({ id: 'leader', title: 'Claude leader', activity: 'idle', state: 'running' })
      const cards = () => nodes(h.panel.TeamPanel({ team: h.team }), (node) => node.type === h.panel.ChildCard || node.props?.title === 'リーダーの会話を開く')
      assert.equal(cards().length, 3)
      assert.equal(cards()[0].props.title, 'リーダーの会話を開く')
      for (const child of h.team.children) {
        const card = cards().find((card) => card.props.child === child)
        assert.equal(card.props.selected, false)
        h.panel.ChildCard(card.props).props.onClick()
        assert.deepEqual(h.state.route, { view: child.kind, id: child.taskId })
        assert.equal(h.state.teamPanel, true)
        assert.equal(cards()[0].props['aria-current'], undefined)
        const selected = cards().find((card) => card.props.child === child)
        assert.equal(h.panel.ChildCard(selected.props).props['aria-current'], 'page')
      }
      cards()[0].props.onClick()
      assert.deepEqual(h.state.route, { view: kind, id: 'leader' })
      assert.equal(cards()[0].props['aria-current'], 'page')
      assert.equal(h.state.teamPanel, true)
      assert.ok(cards().slice(1).every((card) => !card.props.selected))
      assert.equal(h.panel.BackToLeader, undefined)
    })
  }
}

for (const mode of ['TM', 'eco']) {
  test(mode + ': panel can be opened and reopened even before any child exists', async () => {
    const h = await harness(mode === 'eco' ? {} : undefined)
    h.team.children = []
    h.state.teamPanel = false
    const header = h.thread.Header({ thread: h.state.server.threads[0] })
    const toggle = h.find(header, h.panel.TeamToggle)
    const button = h.panel.TeamToggle(toggle.props)
    assert.equal(button.props['aria-label'], 'チームのパネルを開く')
    assert.match(button.props.className, /team-toggle/)
    button.props.onClick()
    assert.equal(h.state.teamPanel, true)
    const view = h.thread.ThreadView({ threadId: 'leader' })
    assert.equal(h.find(view, h.panel.TeamPanel).props.team, h.team)
    h.panel.TeamToggle(toggle.props).props.onClick()
    assert.equal(h.state.teamPanel, false)
    h.panel.TeamToggle(toggle.props).props.onClick()
    assert.equal(h.state.teamPanel, true)
    assert.equal(h.panel.TeamToggle({ team: undefined }), null)
  })
}

for (const mode of ['TM', 'eco']) {
  test(mode + ': each child has a separate accessible delete action', async () => {
    const h = await harness(mode === 'eco' ? {} : undefined)
    h.team.children[0].name = '子A'
    h.team.children[1].name = '子B'
    const view = h.panel.TeamPanel({ team: h.team })
    const buttons = nodes(view, (node) => node.type === 'button' && node.props?.['aria-label']?.endsWith('を削除'))
    assert.deepEqual(buttons.map((button) => button.props['aria-label']), ['子Aを削除', '子Bを削除'])
    buttons[0].props.onClick()
    assert.deepEqual(h.state.route, { view: 'thread', id: 'leader' }, 'delete must not open the child')
  })
}
