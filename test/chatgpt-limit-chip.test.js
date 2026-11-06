import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const jsx = (type, props) => ({ type, props })
const nodes = (node, match) => !node || typeof node !== 'object' ? [] : [...(match(node) ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap((child) => nodes(child, match))]
const text = (node) => node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : [node.props?.children].flat(Infinity).map(text).join('')

const state = { server: { chatgptUsage: null } }

async function load() {
  const source = await fs.readFile(new URL('../web/src/components/ChatGptUsage.tsx', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } })
  const exports = {}
  new Function('require', 'exports', outputText)((name) => ({
    react: { useEffect() {}, useState: (value) => [value, () => {}] },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'lucide-react': {},
    '../store': { useStore: (select) => select(state), act: async () => {}, setState() {} },
    '../util': { resetLabel: () => '' },
  })[name] ?? {}, exports)
  return exports
}

const { ChatGptLimitChip, ChatGptLimits } = await load()

const limitWindow = (label, seconds, usedPercent) => ({ label, seconds, usedPercent, resetAt: null })
const usage = (limitReached, windows) => ({ status: 'ok', plan: 'plus', limitReached, windows, fetchedAt: 1_000 })
const chipLabel = (chip) => nodes(chip, (node) => node.type === 'span').map(text).join('')

test('the chip keeps the window number when the limit is reported reached', () => {
  state.server.chatgptUsage = usage(true, [limitWindow('5時間', 18_000, 25), limitWindow('週間', 604_800, 50)])
  const chip = ChatGptLimitChip()
  assert.equal(chipLabel(chip), 'Codex 上限到達 · 週間 残り 50%')
  assert.match(chip.props.title, /週間の上限: 残り 50%/)
  // Reaching the limit stays visible in the chip's colour even while the window still has room.
  assert.match(chip.props.className, /\blow\b/)
})

test('a chip that is not at the limit shows only the window number', () => {
  state.server.chatgptUsage = usage(false, [limitWindow('5時間', 18_000, 25), limitWindow('週間', 604_800, 50)])
  const chip = ChatGptLimitChip()
  assert.equal(chipLabel(chip), 'Codex 週間 残り 50%')
  assert.doesNotMatch(chip.props.className, /\blow\b/)
})

test('a reached limit remains visible when no window is available', () => {
  state.server.chatgptUsage = usage(true, [])
  const chip = ChatGptLimitChip()
  assert.ok(chip)
  assert.equal(chipLabel(chip), 'Codex 上限到達')
  assert.match(chip.props.className, /\blow\b/)

  state.server.chatgptUsage = usage(false, [])
  assert.equal(ChatGptLimitChip(), null)
})

test('the card distinguishes a reached limit from missing window information', () => {
  state.server.chatgptUsage = usage(true, [])
  const card = ChatGptLimits()
  assert.match(text(card), /Codex の上限に達しています。/)
  assert.match(text(card), /残量の情報がありません。/)
  assert.doesNotMatch(text(card), /このプランでは上限の情報がありません。/)
})

test('a limit reached by an exhausted window still shows its 0%', () => {
  state.server.chatgptUsage = usage(true, [limitWindow('5時間', 18_000, 100)])
  const chip = ChatGptLimitChip()
  assert.match(chipLabel(chip), /5時間 残り 0%/)
  assert.match(chipLabel(chip), /上限到達/)
})

test('the account card shows the window numbers, not the limit state, as the meter value', () => {
  state.server.chatgptUsage = usage(true, [limitWindow('週間', 604_800, 50)])
  const card = ChatGptLimits()
  const meters = nodes(card, (node) => node.props?.role === 'meter')
  assert.equal(meters.length, 1)
  assert.equal(meters[0].props['aria-valuenow'], 50)
  assert.match(text(card), /週間残り 50%/)
  assert.match(text(card), /上限に達しています/)
  assert.match(text(card), /SIWC の利用可否を保証しません/)
})
