import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'
import { pickableEfforts } from '../web/src/util.ts'

const source = await fs.readFile(new URL('../web/src/components/TeamSettings.tsx', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source + '\nexport { ChildModels, FreeModels, dshEfforts }', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
})
const jsx = (type, props) => ({ type, props })
const ModelField = () => {}
const nodes = (node, type) => !node || typeof node !== 'object' ? []
  : [...(node.type === type ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap(child => nodes(child, type))]
const value = 'codex:gpt-6-luna'

function setup({ signedIn = true, models = [], levels } = {}) {
  const effects = [], requests = []
  const server = {
    accounts: { codex: { signedIn } }, codexModels: models,
    catalog: { models: [], effortsByModel: levels === undefined ? {} : { [value]: levels.map(value => ({ value })) },
      fallbackEfforts: ['low', 'medium', 'high'].map(value => ({ value })) },
  }
  const modules = {
    react: { useEffect: effect => effects.push(effect) },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '../store': { request: async method => { requests.push(method) } },
    '../util': { pickableEfforts },
    './WorkflowModelField': { ModelField, modelGroups: () => models.length ? [{ id: 'codex', models: models.map(model => ({ value: 'codex:' + model.id, name: model.name })) }] : [] },
  }
  const component = {}
  new Function('require', 'exports', outputText)(name => modules[name] ?? {}, component)
  return { component, server, effects, requests }
}

test('team settings reload Codex models after idle shutdown, but skip known or signed-out catalogs', () => {
  for (const options of [{}, { signedIn: false }, { models: [{ id: 'gpt-6-luna' }] }]) {
    const h = setup(options)
    h.component.ChildModels({ server: h.server, config: { modelMode: 'free' }, onChange() {} })
    h.effects.forEach(effect => effect())
    assert.deepEqual(h.requests, !options.models && options.signedIn !== false ? ['codex.models'] : [])
  }
})

test('saved Codex max/xhigh stay unconfirmed until the Codex catalog arrives, then use its exact levels', () => {
  const config = { freeModels: ['max', 'xhigh'].map(effort => ({ provider: 'codex', model: 'gpt-6-luna', effort })) }
  const before = structuredClone(config)
  const unknown = setup()
  const fields = h => nodes(h.component.FreeModels({ server: h.server, config, onChange: () => assert.fail('must preserve saved choices') }), ModelField).map(node => node.props)
  for (const field of fields(unknown)) {
    assert.equal(field.effortsKnown, false)
    assert.deepEqual(field.efforts, [], 'unknown Codex levels must not use dsh fallback levels')
  }
  const levels = ['low', 'medium', 'high', 'xhigh', 'max']
  const known = setup({ models: [{ id: 'gpt-6-luna', name: 'Luna' }], levels })
  for (const field of fields(known)) {
    assert.equal(field.effortsKnown, true)
    assert.deepEqual(field.efforts, levels)
    assert.equal(field.groups[0].models[0].name, 'Luna')
    assert.ok(field.efforts.includes(field.effort))
  }
  assert.deepEqual(config, before)
  const restricted = setup({ levels: ['low', 'medium', 'high'] })
  assert.equal(fields(restricted)[0].effortsKnown, true)
  assert.equal(fields(restricted)[0].efforts.includes('max'), false, 'actual capability restrictions remain enforced')
})
