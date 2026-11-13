import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CODE_MODE_ENV, claudeConfigFile, codeModeConsented } from '../server/claude-code-mode.js'
import { DEFAULT_SETTINGS } from '../server/settings.js'
import { TerminalManager } from '../server/terminals.js'

function fakePty() {
  const spawned = []
  return {
    spawned,
    spawn(file, args, options) {
      const exits = []
      const proc = {
        file, args, options, written: [],
        onData: () => {}, onExit: (fn) => exits.push(fn), write: (text) => proc.written.push(text), resize: () => {},
        kill: () => exits.forEach((fn) => fn({ exitCode: 0 })),
      }
      spawned.push(proc)
      return proc
    },
  }
}

async function setup(codeMode, extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-code-mode-'))
  const workspace = path.join(dir, 'project')
  await fs.mkdir(workspace)
  const pty = fakePty()
  const manager = await new TerminalManager({
    file: path.join(dir, 'terminals.json'),
    settingsFile: path.join(dir, 'claude-terminal-settings.json'),
    hookUrl: () => 'http://127.0.0.1:47130/api/terminal-hook',
    send: () => {},
    pty,
    findClaude: () => 'C:\Tools\claude.exe',
    claudeHome: path.join(dir, 'claude'),
    codeMode,
    ...extra,
  }).load()
  return { dir, workspace, pty, manager }
}

test('Code Mode is off by default and a task of that setting carries no switch', async () => {
  assert.equal(DEFAULT_SETTINGS.claudeCodeMode, false)
  const { manager, workspace, pty } = await setup(() => false)
  await manager.create({ workspace })
  assert.equal(pty.spawned[0].options.env[CODE_MODE_ENV], undefined)
  assert.equal(manager.records.values().next().value.codeMode, undefined)
})

test('a task created while Code Mode is on starts with it and keeps it on every restart', async () => {
  let on = true
  const { manager, workspace, pty } = await setup(() => on)
  const created = await manager.create({ workspace })
  assert.equal(pty.spawned[0].options.env[CODE_MODE_ENV], '1')
  assert.equal(manager.records.get(created.id).codeMode, true)
  // Turning the setting off later must not strand a session that Claude Code resumes only in Code Mode.
  on = false
  await manager.configure(created.id, null, { model: 'haiku', effort: 'low' })
  assert.equal(pty.spawned.at(-1).options.env[CODE_MODE_ENV], '1')
  // A task created after that is an ordinary one.
  await manager.create({ workspace })
  assert.equal(pty.spawned.at(-1).options.env[CODE_MODE_ENV], undefined)
})

test('an older task is not switched into Code Mode when the setting is turned on', async () => {
  let on = false
  const { manager, workspace, pty } = await setup(() => on)
  const older = await manager.create({ workspace })
  on = true
  await manager.configure(older.id, null, { model: 'haiku', effort: 'low' })
  assert.equal(pty.spawned.at(-1).options.env[CODE_MODE_ENV], undefined)
})

test('a team leader never starts in Code Mode', async () => {
  const { manager, workspace, pty } = await setup(() => true, { launch: () => ({ args: [] }), preflight: () => null })
  const record = await manager.create({ workspace, team: { id: 'team-1', role: 'leader' } })
  assert.equal(manager.records.get(record.id).codeMode, undefined)
  assert.equal(pty.spawned.at(-1).options.env[CODE_MODE_ENV], undefined)
})

test('consent comes only from the flag Claude Code itself wrote', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-consent-'))
  const file = path.join(dir, '.claude.json')
  assert.equal(codeModeConsented(file), false)
  await fs.writeFile(file, '{ broken')
  assert.equal(codeModeConsented(file), false)
  await fs.writeFile(file, JSON.stringify({ numStartups: 3 }))
  assert.equal(codeModeConsented(file), false)
  await fs.writeFile(file, JSON.stringify({ codeModeCaveatsAcceptedV1: 'true' }))
  assert.equal(codeModeConsented(file), false)
  await fs.writeFile(file, JSON.stringify({ numStartups: 4, codeModeCaveatsAcceptedV1: true }))
  assert.equal(codeModeConsented(file), true)
  assert.equal(claudeConfigFile({ CLAUDE_CONFIG_DIR: dir }, 'C:\Users\me'), file)
  assert.equal(claudeConfigFile({}, 'C:\Users\me'), path.join('C:\Users\me', '.claude.json'))
})
