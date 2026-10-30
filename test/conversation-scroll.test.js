import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await fs.readFile(new URL('../web/src/components/useConversationScroll.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } })

function mount() {
  const slots = [], deps = [], cleanups = []
  let cursor = 0, effects = [], observer
  const element = { scrollTop: 0, scrollHeight: 1000, clientHeight: 200, firstElementChild: {} }
  const react = {
    useRef(value) { const i = cursor++; return slots[i] ??= { current: value } },
    useState(value) { const i = cursor++; if (!(i in slots)) slots[i] = value; return [slots[i], (next) => { slots[i] = next }] },
    useLayoutEffect(callback, dependencies) {
      const i = cursor++
      if (!deps[i] || dependencies.some((value, n) => !Object.is(value, deps[i][n]))) {
        deps[i] = dependencies; effects.push(() => { cleanups[i]?.(); cleanups[i] = callback() })
      }
    },
  }
  class ResizeObserver {
    constructor(callback) { this.callback = callback; this.observed = []; observer = this }
    observe(target) { this.observed.push(target) }
    disconnect() { this.disconnected = true }
  }
  const exports = {}
  new Function('require', 'exports', 'ResizeObserver', outputText)((name) => {
    assert.equal(name, 'react'); return react
  }, exports, ResizeObserver)
  const render = (id, ready, content) => {
    cursor = 0
    const result = exports.useConversationScroll(id, ready, content)
    result.scroller.current = ready ? element : null
    for (const effect of effects.splice(0)) effect()
    return result
  }
  return { element, render, resize: () => observer.callback(), observer: () => observer }
}

test('switching sessions resets a previous manual scroll before following cached content', () => {
  const ui = mount(), content = []
  let view = ui.render('a', true, content)
  assert.equal(ui.element.scrollTop, 1000)
  ui.element.scrollTop = 100
  view.onScroll({ currentTarget: ui.element })
  assert.equal(ui.render('a', true, content).showJump, true)
  const previous = ui.observer()
  view = ui.render('b', true, content)
  assert.equal(ui.element.scrollTop, 1000)
  assert.equal(previous.disconnected, true)
  assert.equal(ui.render('b', true, content).showJump, false)
})

test('late view and size changes follow only while the reader remains at the bottom', () => {
  const ui = mount(), content = []
  ui.render('a', false, content)
  const view = ui.render('a', true, content)
  assert.equal(ui.element.scrollTop, 1000)
  assert.deepEqual(ui.observer().observed, [ui.element, ui.element.firstElementChild])
  ui.element.scrollHeight = 1600
  ui.resize()
  assert.equal(ui.element.scrollTop, 1600)
  ui.element.scrollTop = 200
  view.onScroll({ currentTarget: ui.element })
  ui.element.scrollHeight = 2000
  ui.resize()
  ui.render('a', true, ['new output'])
  assert.equal(ui.element.scrollTop, 200)
  ui.render('b', true, undefined)
  ui.element.scrollHeight = 2400
  ui.render('b', true, ['loaded'])
  assert.equal(ui.element.scrollTop, 2400)
})
