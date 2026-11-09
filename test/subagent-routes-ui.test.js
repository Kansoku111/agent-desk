import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'
import * as workflowEffort from '../shared/workflow-effort.js'
import * as routes from '../web/src/subagent-routes.ts'

const jsx = (type, props) => ({ type, props })
const nodes = (node, match) => !node || typeof node !== 'object' ? [] : [
  ...(match(node) ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap(child => nodes(child, match)),
]
const calls = []
const luna = JSON.stringify(['openai-codex', 'gpt-6-luna'])
const state = {
  settings: { subagentsEnabled: true, subagentRoutes: {
    dsh: { target: 'dsh', model: luna, effort: 'high' },
    cl: { target: 'cl', model: null, effort: null },
    gp: { target: 'cl', model: 'claude:haiku', effort: 'low' },
  } },
  catalog: { effortsByModel: { [luna]: [{ value: 'low' }, { value: 'high' }], 'claude:haiku': [] } },
}
const groups = [
  { id: 'claude-code', models: [{ value: 'claude:haiku', name: 'Haiku' }] },
  { id: 'openai-codex', models: [{ value: luna, name: 'GPT-6 Luna' }] },
  { id: 'deepseek-official', models: [{ value: '["deepseek-official","v4"]', name: 'DeepSeek V4' }] },
  { id: 'codex', models: [{ value: 'codex:gpt-6-luna', name: 'Codex Luna' }] },
  { id: 'unknown-provider', models: [{ value: '["unknown-provider","x"]', name: 'X' }] },
]
const source = await fs.readFile(new URL('../web/src/components/settings/ModelsSettings.tsx', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source + '\nexport { Subagents }', { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } })
const modules = {
  'react': { useState: (value) => [value, () => {}] },
  'react/jsx-runtime': { jsx, jsxs: jsx },
  '../../store': { useStore: fn => fn({ server: state }), act: (...args) => calls.push(args) },
  '../../../../shared/workflow-effort.js': workflowEffort,
  '../../subagent-routes': routes,
  '../Popover': { Dropdown: 'Dropdown', MenuItem: 'MenuItem' },
  '../WorkflowModelField': { CLAUDE_CODE: [], ModelField: 'ModelField', modelGroups: (_server, allowCodex) => { assert.equal(allowCodex, true); return groups } },
  '../Pickers': {}, '../../model-selection': {},
}
const result = {}
new Function('require', 'exports', outputText)(name => modules[name] ?? {}, result)
const rows = () => nodes(result.Subagents(), node => /^subagent-route( |$)/.test(node.props?.className ?? ''))
const field = (parent) => nodes(rows()[['dsh', 'cl', 'gp'].indexOf(parent)], node => node.type === 'ModelField')[0].props
const patchOf = () => calls.at(-1)[1].patch.subagentRoutes
const chip = (parent) => {
  const menu = field(parent).labelAction
  return { menu, button: menu.props.trigger({ open: false, toggle() {} }), items: menu.props.children(() => {}) }
}

test('each kind of task has one row, named by the kind, with the models its target kind can run', () => {
  assert.deepEqual(rows().length, 3)
  assert.deepEqual(['dsh', 'cl', 'gp'].map(parent => field(parent).label), ['DSH', 'Claude Code', 'GP'])
  const names = (parent) => field(parent).groups.map(group => group.id)
  // Its own kind can also stay on the task's model; DSH takes any provider that has a subagent tool, but not an unknown one.
  assert.deepEqual(names('dsh'), ['same', 'openai-codex', 'deepseek-official'])
  assert.deepEqual(names('cl'), ['same', 'claude-code'])
  // Another kind has only that kind's models.
  assert.deepEqual(names('gp'), ['claude-code'])
  assert.equal(field('dsh').value, luna)
  assert.equal(field('cl').value, '')
})

test('the level follows the chosen model, and Claude Code\'s own subagents have none to set', () => {
  assert.equal(field('dsh').effort, 'high')
  assert.deepEqual(field('dsh').efforts, ['low', 'high'])
  assert.equal(field('dsh').allowDefaultEffort, true)
  assert.deepEqual(field('cl').efforts, [])
  // A route from another kind to Claude Code can set one: that child is a Claude Code session of its own.
  assert.deepEqual(field('gp').efforts, ['low', 'medium', 'high', 'xhigh', 'max'])
})

test('choosing a model keeps a level it supports and clears one it does not', () => {
  field('dsh').onChange('["deepseek-official","v4"]')
  assert.deepEqual(patchOf(), { dsh: { model: '["deepseek-official","v4"]', effort: null } })
  field('dsh').onChange(luna)
  assert.deepEqual(patchOf(), { dsh: { model: luna, effort: 'high' } })
  field('dsh').onChange('')
  assert.deepEqual(patchOf(), { dsh: { model: null, effort: null } })
  field('dsh').onEffort('low')
  assert.deepEqual(patchOf(), { dsh: { effort: 'low' } })
  field('dsh').onEffort('')
  assert.deepEqual(patchOf(), { dsh: { effort: null } })
})

test('the chip names the target and its menu changes it; the server drops the old kind\'s model', () => {
  const { button, items } = chip('gp')
  assert.match(button.props['aria-label'], /GP.*Claude Code/)
  assert.equal(button.props.draggable, true)
  assert.deepEqual(items.map(item => [item.props.label, item.props.selected]), [['DSH', false], ['Claude Code', true], ['GP', false]])
  items[0].props.onSelect()
  assert.deepEqual(patchOf(), { gp: { target: 'dsh' } })
  const before = calls.length
  items[1].props.onSelect()
  assert.equal(calls.length, before)
})

test('dragging a chip onto a row sends that row\'s subagents to the chip\'s kind', () => {
  const carried = {}
  const event = (type) => {
    const made = { dataTransfer: { types: type ? [type] : [], setData: (name, value) => { carried[name] = value }, getData: name => carried[name] ?? '' }, preventDefault() { made.prevented = true } }
    return made
  }
  const start = event()
  chip('cl').button.props.onDragStart(start)
  assert.deepEqual(carried, { 'application/x-agent-desk-subagent': 'cl' })
  assert.equal(start.dataTransfer.effectAllowed, 'copy')
  const target = rows()[0].props
  // Text or files dropped from elsewhere are ignored.
  const stray = event('text/plain')
  target.onDragOver(stray)
  assert.notEqual(stray.prevented, true)
  const hover = event('application/x-agent-desk-subagent')
  target.onDragOver(hover)
  assert.equal(hover.prevented, true)
  const before = calls.length
  target.onDrop(event('application/x-agent-desk-subagent'))
  assert.equal(calls.length, before + 1)
  assert.deepEqual(patchOf(), { dsh: { target: 'cl' } })
  // Dropping a kind onto the row that already has it changes nothing.
  carried['application/x-agent-desk-subagent'] = 'dsh'
  target.onDrop(event('application/x-agent-desk-subagent'))
  assert.equal(calls.length, before + 1)
})

test('with subagents off no row is shown, and an older save without routes shows each kind on itself', () => {
  state.settings.subagentsEnabled = false
  assert.equal(rows().length, 0)
  assert.equal(nodes(result.Subagents(), node => node.type === 'input')[0].props.checked, false)
  state.settings.subagentsEnabled = true
  delete state.settings.subagentRoutes
  assert.deepEqual(['dsh', 'cl', 'gp'].map(parent => chip(parent).button.props['aria-label'].split(': ')[1]), ['DSH', 'Claude Code', 'GP'])
  assert.equal(routes.usesClaudeApi(state.settings), false)
  assert.equal(routes.usesClaudeApi({ subagentsEnabled: true, subagentRoutes: { dsh: { target: 'dsh', model: '["anthropic","claude-haiku-5-5"]', effort: null } } }), true)
  assert.equal(routes.usesClaudeApi({ subagentsEnabled: false, subagentRoutes: { dsh: { target: 'dsh', model: '["anthropic","claude-haiku-5-5"]', effort: null } } }), false)
})
