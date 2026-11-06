import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCodexHandlers } from '../server/rpc-handlers-codex.js'

function setup() {
  const calls = []
  const records = new Map([
    ['independent', { id: 'independent', workspace: '/project' }],
    ['leader', { id: 'leader', team: { id: 'team', role: 'leader' } }],
    ['child', { id: 'child', team: { id: 'team', childId: 'member' } }],
    ['ab', { id: 'ab', ab: { id: 'comparison' } }],
  ])
  const settings = { workspaces: [] }
  const codex = {
    get: id => records.get(id),
    running: () => false,
    turns: id => [{ id: `turn-${id}` }],
    pendingPermissions: id => [{ requestId: `request-${id}` }],
    models: async options => { calls.push(['models', options]); return [{ id: 'model' }] },
    create: async options => { calls.push(['create', options]); return { id: 'new', workspace: options.workspace } },
    send: async (id, options) => { calls.push(['send', id, options]) },
    stop: async id => { calls.push(['stop', id]); return records.get(id) },
    update: async (id, options) => { calls.push(['update', id, options]); return records.get(id) },
    remove: async id => { calls.push(['remove', id]) },
    respondPermission: (id, requestId, decision) => { calls.push(['respond', id, requestId, decision]) },
  }
  const teams = {
    guardExecution: options => { calls.push(['guard', options]); if (options.workspace === '/blocked') throw new Error('blocked workspace') },
    refreshCodexLeader: async id => { calls.push(['refresh', id]) },
    removeTeam: async id => { calls.push(['removeTeam', id]) },
  }
  const handlers = createCodexHandlers({ codex, teams, paths: { myPc: '/my-pc' }, mutateSettings: async fn => fn(settings) })
  return { handlers, calls, settings, codex }
}

test('create guards workspace, forwards only allowed options, and adds workspace once', async () => {
  const { handlers: h, calls, settings } = setup()
  const args = { workspace: '/project', model: 'model', effort: 'low', permissionMode: 'read-only', instructions: 'injected', mcpServers: { evil: {} }, permissionPolicy: 'bypass', team: { id: 'other' }, ab: {} }
  assert.deepEqual(await h['codex.task.create'](args), { task: { id: 'new', workspace: '/project' } })
  assert.deepEqual(calls, [
    ['guard', { workspace: '/project' }],
    ['create', { workspace: '/project', model: 'model', effort: 'low', permissionMode: 'read-only' }],
  ])
  await h['codex.task.create'](args)
  assert.deepEqual(settings.workspaces, ['/project'])
  await h['codex.task.create']({ workspace: '/my-pc' })
  assert.deepEqual(settings.workspaces, ['/project'])
  await assert.rejects(h['codex.task.create']({ workspace: '/blocked' }), /blocked workspace/)
  assert.equal(calls.filter(call => call[0] === 'create').length, 3)
})

test('independent task send, update and remove are limited to public options', async () => {
  const { handlers: h, calls } = setup()
  assert.deepEqual(await h['codex.task.send']({ taskId: 'independent', text: 'hello', images: ['image'], permissionMode: 'danger-full-access' }), { sent: true })
  const patch = { taskId: 'independent', title: 'title', archived: true, pinned: false, model: 'model', effort: 'low', permissionMode: 'read-only', instructions: 'injected', mcpServers: { evil: {} }, permissionPolicy: 'bypass', team: {}, ab: {} }
  await h['codex.task.update'](patch)
  assert.deepEqual(await h['codex.task.remove']({ taskId: 'independent' }), { removed: true })
  assert.deepEqual(calls, [
    ['send', 'independent', { text: 'hello', images: ['image'] }],
    ['update', 'independent', { title: 'title', archived: true, pinned: false, model: 'model', effort: 'low', permissionMode: 'read-only' }],
    ['remove', 'independent'],
  ])
})

test('leader sends refresh only when idle and removes its team', async () => {
  const { handlers: h, calls, codex } = setup()
  assert.deepEqual(await h['codex.task.send']({ taskId: 'leader', text: 'start' }), { sent: true })
  assert.deepEqual(calls, [['refresh', 'leader'], ['send', 'leader', { text: 'start', images: undefined }]])
  calls.length = 0
  codex.running = id => id === 'leader'
  assert.deepEqual(await h['codex.task.send']({ taskId: 'leader', text: 'steer' }), { sent: true })
  assert.deepEqual(calls, [['send', 'leader', { text: 'steer', images: undefined }]])
  calls.length = 0
  assert.deepEqual(await h['codex.task.remove']({ taskId: 'leader' }), { removed: true })
  assert.deepEqual(calls, [['removeTeam', 'team']])
})

test('leader allows presentation updates but rejects execution setting changes', async () => {
  const { handlers: h, calls } = setup()
  await h['codex.task.update']({ taskId: 'leader', title: 'title', pinned: true, archived: false })
  assert.deepEqual(calls, [['update', 'leader', { title: 'title', archived: false, pinned: true, model: undefined, effort: undefined, permissionMode: undefined }]])
  calls.length = 0
  for (const patch of [{ model: 'model' }, { effort: 'low' }, { permissionMode: 'read-only' }]) {
    await assert.rejects(h['codex.task.update']({ taskId: 'leader', ...patch }), /チーム設定/)
  }
  assert.deepEqual(calls, [])
})

test('team child and AB tasks cannot be sent, updated, removed or stopped directly', async () => {
  const { handlers: h, calls } = setup()
  for (const taskId of ['child', 'ab']) {
    for (const method of ['send', 'update', 'remove', 'stop']) {
      await assert.rejects(h[`codex.task.${method}`]({ taskId, text: 'hello' }), /AB|チーム/)
    }
  }
  assert.deepEqual(calls, [])
})

test('independent task can be stopped and queried; missing ids do not reach operations', async () => {
  const { handlers: h, calls } = setup()
  assert.deepEqual(h['codex.task.get']({ taskId: 'independent' }), { task: { id: 'independent', workspace: '/project' }, turns: [{ id: 'turn-independent' }], permissions: [{ requestId: 'request-independent' }] })
  assert.deepEqual(h['codex.task.permissions']({ taskId: 'independent' }), { permissions: [{ requestId: 'request-independent' }] })
  assert.deepEqual(await h['codex.task.stop']({ taskId: 'independent' }), { task: { id: 'independent', workspace: '/project' } })
  for (const method of ['send', 'update', 'remove', 'stop']) await assert.rejects(h[`codex.task.${method}`]({ taskId: 'missing' }), /見つかりません/)
  for (const method of ['get', 'permissions', 'respond']) assert.throws(() => h[`codex.task.${method}`]({ taskId: 'missing' }), /見つかりません/)
  assert.deepEqual(calls, [['stop', 'independent']])
})

test('models refresh and approval decisions are delegated without changing task identity', async () => {
  const { handlers: h, calls } = setup()
  assert.deepEqual(await h['codex.models'](), { models: [{ id: 'model' }] })
  assert.deepEqual(h['codex.task.respond']({ taskId: 'child', requestId: 'request-child', decision: 'decline' }), { accepted: true })
  assert.deepEqual(calls, [['models', { refresh: true }], ['respond', 'child', 'request-child', 'decline']])
})

test('RPC propagates validation and permission errors from the runner', async () => {
  const { handlers: h, codex } = setup()
  codex.create = async () => { throw new Error('権限モードが不正です') }
  codex.send = async () => { throw new Error('メッセージが空か形式が不正です') }
  codex.update = async () => { throw new Error('タイトルが空です') }
  codex.respondPermission = () => { throw new Error('承認の選択が不正です') }
  await assert.rejects(h['codex.task.create']({ workspace: '/project', permissionMode: 'invalid' }), /不正/)
  await assert.rejects(h['codex.task.send']({ taskId: 'independent', text: '', images: 'invalid' }), /不正/)
  await assert.rejects(h['codex.task.update']({ taskId: 'independent', title: '' }), /空/)
  assert.throws(() => h['codex.task.respond']({ taskId: 'independent', requestId: 'x', decision: 'invalid' }), /不正/)
})
