import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// Run the listener in a child: an uncaught request callback exception must not
// kill the test runner, and the parent owns temporary credential cleanup.
test('ChatGPT callback rejects a malformed request URL without crashing or consuming sign-in', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-login-http-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const source = `
    import assert from 'node:assert/strict'
    import http from 'node:http'
    import { ChatGptLogin } from ${JSON.stringify(new URL('../server/chatgpt-login.js', import.meta.url).href)}
    import { CredentialStore } from ${JSON.stringify(new URL('../server/credentials.js', import.meta.url).href)}
    const login = new ChatGptLogin({
      store: new CredentialStore(${JSON.stringify(path.join(dir, '.credentials.yaml'))}),
      onState() {},
      async openUrl(authorize) {
        const auth = new URL(authorize)
        const callback = new URL(auth.searchParams.get('redirect_uri'))
        const status = await new Promise((resolve, reject) => {
          const req = http.request({ hostname: '127.0.0.1', port: callback.port, path: 'http://[', method: 'GET' }, res => {
            res.resume()
            res.on('end', () => resolve(res.statusCode))
          })
          req.on('error', reject)
          req.end()
        })
        assert.equal(status, 400)
        callback.search = new URLSearchParams({ state: auth.searchParams.get('state'), code: 'code', client_id: 'issued-client' })
        assert.equal((await fetch(callback)).status, 200)
      },
      fetch: async () => Response.json({ access_token: 'access', refresh_token: 'refresh', id_token: 'id', token_type: 'Bearer', expires_in: 3600 }),
      verify: async () => ({ iss: 'https://auth.openai.com', sub: 'user' }),
    })
    await login.start()
    assert.equal(login.state.phase, 'done')
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 15000 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
})
