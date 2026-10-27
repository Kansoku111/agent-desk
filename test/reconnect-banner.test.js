import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const source = await fs.readFile(new URL('../web/src/App.tsx', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } })
const jsx = (type, props) => ({ type, props })
const state = { connection: 'open', server: { settings: {} }, route: { view: 'home' } }
const modules = {
  react: { useEffect() {}, Suspense: 'suspense' },
  'react/jsx-runtime': { jsx, jsxs: jsx },
  'lucide-react': { Loader2: 'loader', WifiOff: 'wifi-off' },
  './store': { useStore: (select) => select(state), remoteHost: false },
  './lazy-chunk': { lazyChunk: () => 'lazy' },
  './sidebarSwipe': { useSidebarSwipe() {} },
}
const app = {}
new Function('require', 'exports', outputText)((name) => modules[name] ?? {}, app)
function text(node) {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node !== 'object') return String(node)
  return [node.props?.children].flat(Infinity).map(text).join('')
}

test('reconnection remains visible while a previous team snapshot is displayed', () => {
  for (const connection of ['closed', 'connecting']) {
    state.connection = connection
    assert.match(text(app.App()), /再接続しています/)
  }
  state.connection = 'open'
  assert.doesNotMatch(text(app.App()), /再接続しています/)
})
