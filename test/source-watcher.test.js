import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { watchSource } from '../server/source-watcher.js'

const linux = process.platform === 'linux'

test('Linux source events preserve short-lived file types and Japanese, spaces and newlines', { skip: !linux }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-watch-'))
  const file = '日本語 space\nfile.txt'
  const directory = '日本語 space\ndirectory'
  const events = []
  const complete = Promise.withResolvers()
  const watcher = await watchSource(root, (_event, name, isDirectory) => {
    events.push({ name, isDirectory })
    if (events.some((event) => event.name === file && !event.isDirectory)
      && events.some((event) => event.name === directory && event.isDirectory)) complete.resolve()
  }, complete.reject)
  t.after(async () => { watcher.close(); await fs.rm(root, { recursive: true, force: true }) })
  const timeout = setTimeout(() => complete.reject(new Error('source events were not received')), 5000)
  try {
    await fs.writeFile(path.join(root, file), 'temporary')
    await fs.unlink(path.join(root, file))
    await fs.mkdir(path.join(root, directory))
    await fs.rmdir(path.join(root, directory))
    await complete.promise
  } finally { clearTimeout(timeout) }
})

test('missing inotifywait fails verification before any command runs', { skip: !linux }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-watch-missing-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  const emptyPath = path.join(root, 'empty-path')
  await fs.mkdir(workspace)
  await fs.mkdir(emptyPath)
  const execution = new URL('../server/execution.js', import.meta.url).href
  const code = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { ExecutionVerifier } from ${JSON.stringify(execution)};
    const root = process.argv[1];
    const workspace = path.join(root, 'workspace');
    const verifier = await new ExecutionVerifier({ dir: path.join(root, 'records') }).load();
    const run = await verifier.verify({ id: 'missing', folder: workspace,
      checks: [{ id: 'must-not-run', command: 'printf unexpected > marker.txt' }] });
    await verifier.stop();
    console.log(JSON.stringify({ status: run.status, error: run.error,
      executed: fs.existsSync(path.join(workspace, 'marker.txt')) }));
  `
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code, root], {
    env: { ...process.env, PATH: emptyPath }, encoding: 'utf8', timeout: 15_000,
  }))
  assert.equal(result.status, 'error')
  assert.match(result.error, /inotifywait.*inotify-tools/)
  assert.equal(result.executed, false)
})
