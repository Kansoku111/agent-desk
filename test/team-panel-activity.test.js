import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

// Exercise the real JSX views with no chat, terminal or browser dependencies.
const source = await fs.readFile(new URL('../web/src/components/TeamPanel.tsx', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source + '\nexport { ChildCard, TeamDiagram }', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
})
const jsx = (type, props) => ({ type, props })
const modules = {
  react: { memo: (fn) => fn, useState: (value) => [value, () => {}] },
  'react/jsx-runtime': { jsx, jsxs: jsx },
  'lucide-react': { Loader2: 'spinner', CircleDot: 'idle', CheckCircle2: 'closed', ShieldAlert: 'approval', RefreshCw: 'resuming' },
  '../store': { useStore: (select) => select({ teamPanel: true, route: { view: 'thread', id: 'task' }, server: { threads: [] } }) },
}
const panel = {}
new Function('require', 'exports', outputText)((name) => modules[name] ?? {}, panel)

function nodes(node, match) {
  if (!node || typeof node !== 'object') return []
  return [...(match(node) ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap((child) => nodes(child, match))]
}
const withClass = (node, name) => nodes(node, (entry) => entry.props?.className?.split(' ').includes(name))
function text(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node !== 'object') return String(node)
  return [node.props?.children].flat(Infinity).map(text).join('')
}
const child = { id: 'child', name: '子3', taskId: 'task', provider: 'gpt', modelName: 'GPT',
  title: '修正と回帰テスト', createdAt: 1, pending: 0, state: 'idle', lastReport: null }
const team = { id: 'team', leaderId: 'leader', leaderKind: 'thread', execution: {}, children: [], approvals: [], asks: [], queue: [] }

for (const [state, phase, active, label, icon] of [
  ['running', 'working', true, '作業中', 'spinner'],
  ['idle', 'verifying', true, '検証中', 'spinner'],
  ['idle', 'review', false, '判定待ち', 'idle'],
  ['closed', 'accepted', false, '完了', 'closed'],
  ['approval', 'working', true, '承認待ち', 'approval'],
  ['idle', undefined, false, '待機中', 'idle'],
  ['resuming', undefined, false, '再開待ち', 'resuming'],
]) {
  test(`child ${state}/${phase}: counts, card and diagram agree`, () => {
    const current = { ...child, state, ...(phase ? { execution: { phase } } : {}) }
    const summary = { ...team, children: [current] }
    const toggle = panel.TeamToggle({ team: summary })
    assert.equal(text(toggle), active ? 'チーム1 作業中' : 'チーム1')
    const sidebar = panel.TeamPanel({ team: summary })
    assert.equal(text(withClass(sidebar, 'subagent-panel-count')[0]), active ? '作業中 1 / 1' : '1 人')
    const stop = nodes(sidebar, (node) => node.type === 'button' && text(node) === ' 全停止')[0]
    assert.equal(stop.props.disabled, !(active || state === 'resuming'))

    const card = panel.ChildCard({ child: current })
    assert.equal(withClass(card, 'quiet').length > 0, !active)
    assert.equal(text(withClass(card, 'subagent-time')[0]), label)
    const displayState = phase === 'verifying' ? 'running' : state
    assert.equal(withClass(card, `state-${displayState}`).length, 1)
    const cardIcon = nodes(card, (node) => node.type === panel.StateIcon)[0]
    const renderedIcon = panel.StateIcon(cardIcon.props)
    assert.equal(renderedIcon.type, icon)
    assert.equal(renderedIcon.props.className === 'spin', icon === 'spinner')

    const diagram = panel.TeamDiagram({ team: summary, onClose() {} })
    const childNode = withClass(diagram, 'team-node').find((node) => node.type === 'button')
    assert.equal(withClass(childNode, 'live').length > 0, active)
    assert.equal(withClass(childNode, 'quiet').length > 0, !active)
    assert.equal(withClass(childNode, `state-${displayState}`).length, 1)
    assert.ok(text(childNode).endsWith(label))
    const diagramIcon = nodes(childNode, (node) => node.type === panel.StateIcon)[0]
    assert.equal(diagramIcon.props.state, cardIcon.props.state)
    for (const line of withClass(diagram, 'team-line')) {
      assert.equal(withClass(line, 'live').length > 0, active)
    }
    assert.equal(current.state, state, 'display must not change the agent state')
  })
}

test('verification stays visible among finished children and its diagram line is drawn last', () => {
  const verifying = { ...child, execution: { phase: 'verifying' } }
  const finished = { ...child, id: 'finished', createdAt: 2, state: 'closed', execution: { phase: 'accepted' } }
  const summary = { ...team, children: [verifying, finished] }
  const sidebar = panel.TeamPanel({ team: summary })
  assert.equal(text(withClass(sidebar, 'subagent-panel-count')[0]), '作業中 1 / 2')
  assert.equal(nodes(sidebar, (node) => node.type === panel.ChildCard).length, 2)
  const diagram = panel.TeamDiagram({ team: summary, onClose() {} })
  const lines = withClass(diagram, 'team-line')
  assert.equal(withClass(lines.at(-1), 'live').length, 1)
  assert.equal(withClass(lines.at(-2), 'live').length, 0)
})
