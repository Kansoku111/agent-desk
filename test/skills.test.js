import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { listSkills } from '../server/skills.js'
import { createThreadHandlers } from '../server/rpc-handlers-threads.js'

test('skill list uses workspace precedence and human invocation policy', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-skills-'))
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
