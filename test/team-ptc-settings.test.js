import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'
import { teamConfig } from '../server/team-config.js'

const source = await fs.readFile(new URL('../web/src/components/TeamSettings.tsx', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
})
const jsx = (type, props) => ({ type, props })
const PtcToggle = function PtcToggle() {}
function nodes(node, match) {
  if (!node || typeof node !== 'object') return []
  return [...(match(node) ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap((child) => nodes(child, match))]
}

// Invoke the real dialog callbacks with React state, without a model or server.
function harness({ mode = 'ptc', busy = false, result = true } = {}) {
  const slots = [], calls = []
  let cursor = 0, closed = 0
  const config = teamConfig({ toolMode: mode, gpt: { enabled: true } })
  const team = { id: 'team', leaderId: 'leader', leaderKind: 'thread', children: [], config, toolModeBusy: busy }
  const server = { threads: [], terminals: [], catalog: { providers: {} } }
  const dependencies = {
    react: { useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    } },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '../store': { useStore: (select) => select({ server }), act: async (name, args) => {
      calls.push({ name, args })
      const response = await result
      if (response) team.config = { ...team.config, ...args.patch }
      return response
    } },
    '../util': { parseModel: () => null },
    '../team-auth-consent': { needsClaudeAuth: () => false },
    './PtcToggle': { PtcToggle },
  }
  const component = {}
  new Function('require', 'exports', outputText)((name) => dependencies[name] ?? {}, component)
  const render = () => { cursor = 0; return component.TeamConfigDialog({ team, onClose: () => closed++ }) }
  const find = (match) => nodes(render(), match)[0].props
  return {
    team, calls, get closed() { return closed },
    toggle: () => find((node) => node.type === PtcToggle),
    save: () => find((node) => node.type === 'button' && node.props.children === '保存'),
    cancel: () => find((node) => node.type === 'button' && node.props.children === 'キャンセル'),
    reopen() { slots.length = 0 },
  }
}

test('existing team settings turn PTC off, save the team choice and restore it on reopen', async () => {
  const h = harness()
  assert.equal(h.toggle().mode, 'ptc')
  h.toggle().onChange('native')
  assert.equal(h.toggle().mode, 'native')
  assert.equal(h.calls.length, 0, 'changing the draft waits for Save')
  h.save().onClick()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(h.calls[0].name, 'team.update')
  assert.equal(h.calls[0].args.teamId, 'team')
  assert.equal(h.calls[0].args.patch.toolMode, 'native')
  assert.equal(h.closed, 1)
  h.reopen()
  assert.equal(h.toggle().mode, 'native')
  h.toggle().onChange('ptc')
  h.save().onClick()
  assert.equal(h.calls[1].args.patch.toolMode, 'ptc')
})

test('canceling a PTC draft leaves the saved team choice unchanged', () => {
  const h = harness()
  h.toggle().onChange('native')
  h.cancel().onClick()
  h.reopen()
  assert.equal(h.toggle().mode, 'ptc')
  assert.equal(h.calls.length, 0)
})

test('running teams disable PTC but still allow unchanged PTC settings to be saved', () => {
  const h = harness({ busy: true })
  assert.equal(h.toggle().disabled, true)
  assert.equal(h.save().disabled, false)
  h.save().onClick()
  assert.equal(h.calls[0].args.patch.toolMode, 'ptc')
})

test('a team starting after a PTC edit blocks saving until it is idle again', () => {
  const h = harness()
  h.toggle().onChange('native')
  h.team.toolModeBusy = true
  assert.equal(h.toggle().disabled, true)
  assert.equal(h.save().disabled, true)
  h.save().onClick()
  assert.equal(h.calls.length, 0)
  h.team.toolModeBusy = false
  assert.equal(h.save().disabled, false)
  h.save().onClick()
  assert.equal(h.calls[0].args.patch.toolMode, 'native')
})

test('saving disables the PTC control and a failed save keeps the draft open', async () => {
  let finish
  const h = harness({ result: new Promise((resolve) => { finish = resolve }) })
  h.toggle().onChange('native')
  h.save().onClick()
  assert.equal(h.toggle().disabled, true)
  assert.equal(h.save().disabled, true)
  finish(false)
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(h.closed, 0)
  assert.equal(h.toggle().disabled, false)
  assert.equal(h.toggle().mode, 'native')
  assert.equal(h.team.config.toolMode, 'ptc')
})
