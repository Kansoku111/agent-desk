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
const appState = { teamPanel: true, route: { view: 'thread', id: 'task' }, server: { threads: [], catalog: { models: [], providers: {} } } }
const modules = {
  react: { memo: (fn) => fn, useState: (value) => [value, () => {}] },
  'react/jsx-runtime': { jsx, jsxs: jsx },
  'lucide-react': { Loader2: 'spinner', CircleDot: 'idle', CheckCircle2: 'closed', ShieldAlert: 'approval', RefreshCw: 'resuming' },
  '../store': { useStore: (select) => select(appState) },
  '../util': { parseModel: (value) => { if (!value) return null; const [provider, id] = JSON.parse(value); return { provider, id } } },
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

function renderedChildCard(current, planImplement) {
  const sidebar = panel.TeamPanel({ team: { ...team, execution: { planImplement }, children: [current] } })
  const card = nodes(sidebar, (node) => node.type === panel.ChildCard)[0]
  assert.equal(card.props.planImplement, planImplement === true)
  return panel.ChildCard(card.props)
}

for (const [status, label] of [['passed', '成功'], ['unverified', '未実行'], ['failed', '失敗']]) {
  test(`completed final repair shows parent review separately from ${status} verification`, () => {
    const current = { ...child, state: 'closed', execution: { phase: 'accepted', outcome: 'completed_unreviewed', repairs: 0, verification: { status } } }
    const card = renderedChildCard(current, true)
    const activity = withClass(card, 'subagent-card-activity').map(text)
    assert.equal(text(withClass(card, 'subagent-time')[0]), '完了')
    assert.deepEqual(activity, ['GPT', `検証: ${label} · 差し戻し 0回`, '最終修正は親レビュー未実施'])
  })
}

test('final repair awaiting a decision shows the unreviewed status separately from verification', () => {
  const current = { ...child, lastReport: { kind: 'report' }, execution: {
    phase: 'review', repairs: 0, parentReview: { instruction: '最終修正' }, verification: { status: 'passed' },
  } }
  const card = renderedChildCard(current, true)
  assert.equal(text(withClass(card, 'subagent-time')[0]), '判定待ち')
  assert.deepEqual(withClass(card, 'subagent-card-activity').map(text), ['GPT', '検証: 成功 · 差し戻し 0回', '最終修正は親レビュー未実施'])
})

test('unreviewed outcome is still visible when verification or saved team mode is missing', () => {
  const current = { ...child, state: 'closed', execution: { phase: 'accepted', outcome: 'completed_unreviewed' } }
  const card = renderedChildCard(current, undefined)
  assert.deepEqual(withClass(card, 'subagent-card-activity').map(text), ['GPT', '最終修正は親レビュー未実施'])
})

test('ordinary, accepted, abandoned, unfinished and failed work are not marked as completed final repairs', () => {
  const instruction = { instruction: '最終修正' }
  const cases = [
    { name: 'normal eco without plan mode', plan: false, lastReport: { kind: 'report' }, execution: { phase: 'review', parentReview: instruction } },
    { name: 'older eco without plan mode', plan: undefined, lastReport: { kind: 'report' }, execution: { phase: 'review', parentReview: instruction } },
    { name: 'first review', plan: true, lastReport: { kind: 'report' }, execution: { phase: 'review' } },
    { name: 'parent accepted without final repair', plan: true, state: 'closed', execution: { phase: 'accepted', outcome: 'accepted', parentReview: {} } },
    { name: 'abandoned final repair', plan: true, state: 'closed', execution: { phase: 'accepted', outcome: 'abandoned', parentReview: instruction } },
    { name: 'legacy closed work', plan: undefined, state: 'closed', execution: { phase: 'accepted' } },
    { name: 'final repair still working', plan: true, state: 'running', execution: { phase: 'working', parentReview: instruction } },
    { name: 'final repair still verifying', plan: true, execution: { phase: 'verifying', parentReview: instruction } },
    { name: 'final repair failed', plan: true, lastReport: { kind: 'error' }, execution: { phase: 'review', parentReview: instruction } },
    { name: 'final repair cancelled', plan: true, lastReport: { kind: 'cancelled' }, execution: { phase: 'review', parentReview: instruction } },
  ]
  for (const item of cases) {
    const current = { ...child, state: item.state ?? 'idle', lastReport: item.lastReport ?? null, execution: item.execution }
    const card = renderedChildCard(current, item.plan)
    assert.doesNotMatch(text(card), /最終修正は親レビュー未実施/, item.name)
    if (item.execution.outcome === 'abandoned') assert.equal(text(withClass(card, 'subagent-time')[0]), '中止')
  }
})

test('diagram distinguishes unreviewed final repair without changing normal outcomes', () => {
  const instruction = { instruction: '最終修正' }
  for (const [current, planImplement, label, unreviewed] of [
    [{ ...child, state: 'closed', execution: { phase: 'accepted', outcome: 'completed_unreviewed' } }, true, '完了・未レビュー', true],
    [{ ...child, lastReport: { kind: 'report' }, execution: { phase: 'review', parentReview: instruction } }, true, '判定待ち・未レビュー', true],
    [{ ...child, state: 'closed', execution: { phase: 'accepted', outcome: 'accepted' } }, true, '完了', false],
    [{ ...child, state: 'closed', execution: { phase: 'accepted', outcome: 'abandoned', parentReview: instruction } }, true, '中止', false],
    [{ ...child, lastReport: { kind: 'report' }, execution: { phase: 'review', parentReview: instruction } }, false, '判定待ち', false],
  ]) {
    const diagram = panel.TeamDiagram({ team: { ...team, execution: { planImplement }, children: [current] }, onClose() {} })
    const node = withClass(diagram, 'team-node').find((entry) => entry.type === 'button')
    assert.equal(text(withClass(node, 'team-node-foot')[0]), `子3${label}`)
    assert.equal(node.props.title.includes('最終修正は親レビュー未実施'), unreviewed)
  }
})

test('the diagram names the leader model and its real provider', (t) => {
  const value = JSON.stringify(['deepseek-official', 'deepseek-v4-flash'])
  appState.server.threads = [{ id: 'leader', title: 'Leader', model: value, status: 'idle' }]
  appState.server.catalog = { models: [{ value, name: 'DeepSeek V4 Flash' }], providers: { 'deepseek-official': 'DeepSeek' } }
  t.after(() => { appState.server.threads = []; appState.server.catalog = { models: [], providers: {} } })
  const diagram = panel.TeamDiagram({ team, onClose() {} })
  const leader = withClass(diagram, 'team-node').find((node) => node.type === 'div')
  assert.match(text(leader), /DeepSeek V4 Flash/)
  assert.match(text(leader), /DeepSeek/)
  assert.doesNotMatch(text(leader), /GPT/)
})

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
