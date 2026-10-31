import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { listSkillOverview, listSkills } from '../server/skills.js'
import { createThreadHandlers } from '../server/rpc-handlers-threads.js'
import { AgentDeskSkillProvider, apply } from '../server/skill-filesystem-plugin.js'
import { homePatch } from '../server/dsh-config.js'
import YAML from 'yaml'

test('skill list uses workspace precedence and human invocation policy', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-skills-'))
  t.mock.method(os, 'homedir', () => root)
  const previous = process.env.DSH_AGENTS_HOME
  process.env.DSH_AGENTS_HOME = path.join(root, 'agents-home')
  const workspace = path.join(root, 'project')
  const dshHome = path.join(root, 'dsh-home')
  const skill = async (dir, name, description, extra = '') => {
    const folder = path.join(dir, name)
    await fs.mkdir(folder, { recursive: true })
    await fs.writeFile(path.join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n${extra}---\nInstructions\n`)
  }
  try {
    await fs.mkdir(path.join(workspace, '.git'), { recursive: true })
    await skill(path.join(dshHome, 'skills'), 'shared', 'User skill')
    await skill(path.join(workspace, '.agents', 'skills'), 'shared', 'Project skill')
    await skill(path.join(workspace, '.dsh', 'skills'), 'private', 'Not user invocable', 'user-invocable: false\n')
    await skill(path.join(process.env.DSH_AGENTS_HOME, 'skills'), 'another', 'Another skill')
    assert.deepEqual(await listSkills(workspace, dshHome), [
      { name: 'another', description: 'Another skill' },
      { name: 'shared', description: 'Project skill' },
    ])
    const handlers = createThreadHandlers({ paths: { dshHome }, threads: { get: async () => ({ thread: { workspace } }) } })
    assert.deepEqual(await handlers['skills.list']({ threadId: 'thread', workspace: 'ignored' }), { skills: await listSkills(workspace, dshHome) })
    await assert.rejects(handlers['skills.list']({ workspace: 'relative' }), /ワークスペース/)
  } finally {
    if (previous === undefined) delete process.env.DSH_AGENTS_HOME
    else process.env.DSH_AGENTS_HOME = previous
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('Codex and Claude roots preserve precedence, metadata and safe discovery boundaries', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-skill-roots-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  t.mock.method(os, 'homedir', () => path.join(root, 'user'))
  const workspace = path.join(root, 'project')
  await fs.mkdir(path.join(workspace, '.git'), { recursive: true })
  const nested = path.join(workspace, 'src', 'nested')
  await fs.mkdir(nested, { recursive: true })
  const config = { dshHome: path.join(root, 'dsh'), agentsHome: path.join(root, 'agents'), watch: false }
  const provider = new AgentDeskSkillProvider({ get: () => undefined, logger: console },
    { signal: new AbortController().signal, invalidate() {} }, config)
  t.after(() => provider.dispose())
  const put = async (base, folder, name, extra = '') => {
    const dir = path.join(base, folder)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'SKILL.md'), ['---', 'name: ' + name, 'description: ' + folder, extra, '---', 'Fixture body'].join('\n'))
    return dir
  }
  const codex = path.join(workspace, '.codex', 'skills')
  const claude = path.join(workspace, '.claude', 'skills')
  const userCodex = path.join(os.homedir(), '.codex', 'skills')
  const userClaude = path.join(os.homedir(), '.claude', 'skills')
  const codexDir = await put(codex, 'project-codex', 'project-codex')
  await put(claude, 'agent-desk-bug-triage', 'agent-desk-bug-triage')
  await put(userCodex, 'user-codex', 'user-codex')
  await put(userClaude, 'user-claude', 'user-claude')
  await put(path.join(userCodex, '.system'), 'system-only', 'system-only')
  await put(path.join(userCodex, '.archive'), 'archived', 'archived')
  await put(codex, 'model-only', 'model-only', 'user-invocable: false')
  await put(claude, 'manual-only', 'manual-only', 'disable-model-invocation: true')
  await put(claude, 'invalid', 'invalid', 'user-invocable: not-a-boolean')
  await fs.writeFile(path.join(codex, 'flat.md'), '---\nname: flat\ndescription: flat\n---\nFlat body')
  await put(userClaude, 'user-shared', 'shared')
  await put(userCodex, 'codex-shared', 'shared')
  await put(claude, 'claude-shared', 'shared')
  await put(codex, 'project-shared', 'shared')
  let candidates = await provider.list({ cwd: nested })
  const names = candidates.map((skill) => skill.name)
  for (const name of ['project-codex', 'agent-desk-bug-triage', 'user-codex', 'user-claude', 'flat']) assert.ok(names.includes(name), name)
  for (const name of ['system-only', 'archived', 'invalid']) assert.ok(!names.includes(name), name)
  const winner = () => candidates.filter((s) => s.name === 'shared').sort((a, b) => a.rank - b.rank)[0]
  assert.equal(winner().description, 'project-shared')
  await put(path.join(workspace, '.agents', 'skills'), 'agents-shared', 'shared')
  candidates = await provider.list({ cwd: nested })
  assert.equal(winner().description, 'agents-shared')
  await put(path.join(workspace, '.dsh', 'skills'), 'dsh-shared', 'shared')
  candidates = await provider.list({ cwd: nested })
  assert.equal(winner().description, 'dsh-shared')
  const candidate = candidates.find((s) => s.name === 'project-codex')
  const loaded = await provider.get(candidate, { cwd: nested })
  assert.equal(loaded.content, 'Fixture body')
  assert.equal(loaded.resourceBase.path, await fs.realpath(codexDir))
  assert.equal(candidates.find((s) => s.name === 'model-only').invocation.userInvocable, false)
  assert.equal(candidates.find((s) => s.name === 'manual-only').invocation.modelInvocable, false)
  const isolated = new AgentDeskSkillProvider({ get: () => undefined, logger: console },
    { signal: new AbortController().signal, invalidate() {} }, { ...config, includeDefaultRoots: false })
  t.after(() => isolated.dispose())
  assert.deepEqual(await isolated.list({ cwd: nested }), [])
  // The UI uses exactly the same provider, with human-only filtering.
  const previous = process.env.DSH_AGENTS_HOME
  process.env.DSH_AGENTS_HOME = config.agentsHome
  try {
    const ui = await listSkills(nested, config.dshHome)
    assert.ok(ui.some((s) => s.name === 'agent-desk-bug-triage'))
    assert.ok(ui.some((s) => s.name === 'manual-only'))
    assert.ok(!ui.some((s) => s.name === 'model-only'))
    assert.equal(ui.find((s) => s.name === 'shared').description, winner().description)
  } finally {
    if (previous === undefined) delete process.env.DSH_AGENTS_HOME
    else process.env.DSH_AGENTS_HOME = previous
  }
})

test('home patch installs the shared provider and preserves watcher disposal and mutation invalidation', async (t) => {
  const rows = YAML.parse(homePatch())
  assert.equal(rows.find((row) => row.id === 'skill-filesystem').disabled, true)
  const row = rows.flatMap((row) => row.insert ?? []).find((row) => row.id === 'agent-desk-skill-filesystem')
  assert.ok(row.name.endsWith('/server/skill-filesystem-plugin.js'))
  let provider, cleanup, observed
  const events = {}
  const ctx = {
    get: () => undefined, logger: console,
    skills: { registerProvider: (factory) => { provider = factory({ signal: new AbortController().signal, invalidate() {} }) } },
    effect: (factory) => { cleanup = factory().next().value },
    on: (name, fn) => { events[name] = fn },
  }
  apply(ctx, { watch: false })
  assert.ok(provider instanceof AgentDeskSkillProvider)
  const dispose = t.mock.method(provider, 'dispose', async () => {})
  t.mock.method(provider, 'observeHostMutation', (path) => { observed = path })
  events['fs/observed']({ displayPath: 'skill' }, {}, { name: 'read' })
  assert.equal(observed, undefined)
  events['fs/observed']({ displayPath: 'skill' }, {}, { name: 'edit' })
  assert.equal(observed, 'skill')
  await cleanup()
  assert.equal(dispose.mock.callCount(), 1)
})

test('skill overview keeps skills that lose a name clash and reports scope, root and invocation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-skill-overview-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  t.mock.method(os, 'homedir', () => path.join(root, 'user'))
  const previous = process.env.DSH_AGENTS_HOME
  process.env.DSH_AGENTS_HOME = path.join(root, 'agents')
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_AGENTS_HOME
    else process.env.DSH_AGENTS_HOME = previous
  })
  const workspace = path.join(root, 'project')
  const dshHome = path.join(root, 'dsh')
  await fs.mkdir(path.join(workspace, '.git'), { recursive: true })
  const put = async (base, name, description, extra = '') => {
    await fs.mkdir(path.join(base, name), { recursive: true })
    await fs.writeFile(path.join(base, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n${extra}---\nBody\n`)
  }
  await put(path.join(workspace, '.claude', 'skills'), 'shared', 'project copy')
  await put(path.join(os.homedir(), '.codex', 'skills'), 'shared', 'user copy')
  await put(path.join(dshHome, 'skills'), 'manual', 'manual only', 'disable-model-invocation: true\n')
  await put(path.join(workspace, '.dsh', 'skills'), 'auto', 'model only', 'user-invocable: false\n')
  const overview = await listSkillOverview(workspace, dshHome)
  const find = (name, description) => overview.find((skill) => skill.name === name && (!description || skill.description === description))
  assert.deepEqual(
    [find('shared', 'project copy'), find('shared', 'user copy')].map(({ scope, root, active }) => ({ scope, root, active })),
    [{ scope: 'project', root: '.claude/skills', active: true }, { scope: 'user', root: '.codex/skills', active: false }],
  )
  assert.equal(find('shared', 'project copy').file, path.join(workspace, '.claude', 'skills', 'shared', 'SKILL.md'))
  assert.deepEqual({ scope: find('manual').scope, modelInvocable: find('manual').modelInvocable, userInvocable: find('manual').userInvocable },
    { scope: 'user', modelInvocable: false, userInvocable: true })
  assert.equal(find('auto').userInvocable, false)
  // The picker list is unchanged: winners the user can invoke.
  assert.deepEqual((await listSkills(workspace, dshHome)).map((skill) => skill.name), ['manual', 'shared'])

  const handlers = createThreadHandlers({ paths: { dshHome }, threads: { get: async () => ({ thread: { workspace } }) } })
  assert.deepEqual(await handlers['skills.overview']({ threadId: 'thread' }), { skills: overview })
  await assert.rejects(handlers['skills.overview']({ workspace: 'relative' }), /ワークスペース/)
})
