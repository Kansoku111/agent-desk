import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

// Render the real view functions without mounting their unrelated chat/terminal dependencies.
async function harness(execution) {
  const team = { id: 'team', leaderId: 'leader', leaderKind: 'thread', execution, approvals: [], asks: [],
    children: [{ id: 'gpt', kind: 'thread', taskId: 'gpt-task' }, { id: 'claude', kind: 'agent', taskId: 'claude-task' }] }
  const state = { teamPanel: true, subagentPanel: true, turns: {}, agentTurns: {},
    server: { teams: [team], threads: [
      { id: 'leader', title: 'Leader' },
      { id: 'gpt-task', title: 'Child', team: { id: team.id, childId: 'gpt' } },
      { id: 'standalone', title: 'Standalone' },
    ], app: {}, settings: {} } }
  const jsx = (type, props) => ({ type, props })
  const react = { memo: (fn) => fn, useState: (value) => [value, () => {}],
    useRef: () => ({ current: null }), useEffect() {}, useLayoutEffect() {} }
  const store = { useStore: (select) => select(state), useRemote: () => false,
    setTeamPanel: (open) => { state.teamPanel = open },
    teamChildOf: (server, taskId) => {
      const child = team.children.find((entry) => entry.kind === 'agent' && entry.taskId === taskId)
      return child ? { team, child } : null
    } }
  const modules = { react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../store': store,
    '../drafts': { useDraft: () => ['', () => {}], useImeField: () => ({}) },
    '../util': { workspaceLabel: () => 'Workspace' } }
  async function load(name, extra = '') {
    const source = await fs.readFile(new URL('../web/src/components/' + name + '.tsx', import.meta.url), 'utf8')
    const { outputText } = ts.transpileModule(source + extra, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    })
    const exports = {}
    new Function('require', 'exports', outputText)((name) => modules[name] ?? {}, exports)
    return exports
  }
  const panel = await load('TeamPanel')
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
