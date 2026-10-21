import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { patchMcpTimeoutSource, TIMEOUT_ENV } from '../server/mcp-timeout-patch.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The dsh-acp module the installed dsh loads. */
function installedSource() {
  const acpApp = createRequire(path.join(root, 'node_modules/@deepseek-ai/dsh/package.json')).resolve('@deepseek-ai/dsh-acp-app/package.json')
  return fs.readFileSync(createRequire(acpApp).resolve('@deepseek-ai/dsh-acp'), 'utf8')
}

/** dsh-acp's resolveMcpConfigs from a module source, with the helpers it calls. */
function resolver(source) {
  const pick = (name) => {
    const start = source.indexOf(`function ${name}(`)
    return source.slice(start, source.indexOf('\n}', start) + 2)
  }
  const body = ['resolveMcpConfigs', 'entriesToRecord', 'normalizeServerName', 'validateClientConfig'].map(pick).join('\n')
  return new Function('McpClient', 'isAbsolute', 'AcpMcpConfigError', 'VALID_SERVER_NAME', `${body} return resolveMcpConfigs`)(
    McpClient, path.isAbsolute, Error, /^[A-Za-z0-9_-]{1,32}$/,
  )
}

const server = (env) => ({ name: 'imagegen', command: process.execPath, args: [], env })

test('the installed dsh-acp takes the timeout patch, and still parses', () => {
  const patched = patchMcpTimeoutSource(installedSource())
  assert.ok(patched, 'dsh-acp no longer matches mcp-timeout-patch.js; update the patch for this dsh')
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desk-mcp-timeout-')), 'index.mjs')
  try {
    fs.writeFileSync(file, patched)
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  }
})

test('a stdio server sets its tool-call timeout through the environment entry', () => {
  const before = resolver(installedSource())
  const after = resolver(patchMcpTimeoutSource(installedSource()))
  const entry = [{ name: TIMEOUT_ENV, value: '360000' }]
  assert.equal(before([server(entry)], '/tmp')[0].toolCallTimeoutMs, 60_000)
  assert.equal(after([server(entry)], '/tmp')[0].toolCallTimeoutMs, 360_000)
  // Servers without the entry, or with a bad value, keep dsh's default.
  assert.equal(after([server([])], '/tmp')[0].toolCallTimeoutMs, 60_000)
  assert.equal(after([server([{ name: TIMEOUT_ENV, value: 'soon' }])], '/tmp')[0].toolCallTimeoutMs, 60_000)
})

test('leaves an unexpected dsh-acp alone', () => {
  assert.equal(patchMcpTimeoutSource('export const x = 1'), null)
})
