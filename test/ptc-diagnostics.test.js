import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import { stripPtcTypes, ptcSyntaxMessage } from '../server/ptc-program-error.js'
import { patchPtcRuntimeSource } from '../server/ptc-runtime-patch.js'

const require = createRequire(import.meta.url)
const PREFIX = 'async function __dsh_program__() {\n'
const SUFFIX = '\n}'
function failed(source) { try { stripTypeScriptTypes(source) } catch (error) { return error }; assert.fail('Expected invalid TypeScript') }

test('PTC syntax failures retain the program line and caret without a compiler wrapper offset', () => {
  const program = 'const a = 1\nconst b = {x: 1)'
  const bare = failed(program)
  const expected = bare.stack.split('\n').find(value => value.trim().startsWith('^')).indexOf('^') + 1
  for (const wrapped of [false, true]) {
    assert.throws(() => stripPtcTypes(wrapped ? PREFIX + program + SUFFIX : program, program, wrapped ? 1 : 0), error => {
      assert.equal(error.code, 'ERR_INVALID_TYPESCRIPT_SYNTAX')
      assert.match(error.message, new RegExp('line 2, column ' + expected))
      assert.ok(error.message.includes('const b = {x: 1)\n'))
      const [source, caret] = error.message.split('\n').slice(-2)
      assert.equal(source[caret.indexOf('^')], ')')
      assert.doesNotMatch(error.message, /node:internal|__dsh_program__/)
      return true
    })
  }
})

test('long single-line program errors expose only a bounded window around the parser location', () => {
  const program = 'const hidden = "SECRET_OTHER_LINE";\n' + ' '.repeat(900) + 'const b = {x: 1)'
  assert.throws(() => stripPtcTypes(PREFIX + program + SUFFIX, program, 1), error => {
    assert.match(error.message, /line 2, column/)
    assert.doesNotMatch(error.message, /SECRET_OTHER_LINE/)
    assert.ok(error.message.length < 240)
    assert.ok(error.message.includes('const b = {x: 1)'))
    return true
  })
})

test('caret-like text in a program is not mistaken for the parser marker', () => {
  const program = 'const text = '+ String.fromCharCode(96) +'first\n^^^\nlast'+String.fromCharCode(96)+';\nconst broken = {x: 1)'
  assert.throws(() => stripPtcTypes(PREFIX + program + SUFFIX, program, 1), error => {
    assert.match(error.message, /line 4, column/)
    const [source, caret] = error.message.split('\n').slice(-2)
    assert.equal(source[caret.indexOf('^')], ')')
    return true
  })
})

test('tabs, Unicode and CRLF keep a useful program location', () => {
  for (const program of ['\tconst broken = {x: 1)', 'const text = "日本😀"; const broken = {x: 1)', 'const a=1\r\nconst broken = {x: 1)', '\tconst broken = {x: 1); ' + ' '.repeat(80), 'const text = "日本語"; const broken = {x: 1); ' + ' '.repeat(80)]) {
    assert.throws(() => stripPtcTypes(PREFIX + program + SUFFIX, program, 1), error => {
      assert.match(error.message, /line [12]/)
      assert.match(error.message, /const broken/)
      if(error.message.includes('column')) {
        const [source, caret] = error.message.split('\n').slice(-2)
        assert.equal(source[caret.indexOf('^')], ')')
      }
      return true
    })
  }
})

test('valid TypeScript is unchanged and unsupported syntax or unknown stack formats keep the original failure', () => {
  const source = PREFIX + 'const values: number[] = [1,2]; return values.map(n => n + 1)' + SUFFIX
  assert.equal(stripPtcTypes(source), stripTypeScriptTypes(source))
  const other = { code: 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX', message: 'original', stack: ':1\nx\n^' }
  assert.equal(ptcSyntaxMessage(other, 'x'), 'original')
  assert.equal(ptcSyntaxMessage({ ...other, code: 'ERR_INVALID_TYPESCRIPT_SYNTAX', stack: 'unknown future frame' }, 'x'), 'original')
  const eof = failed(PREFIX + 'const value = {' + SUFFIX)
  assert.match(ptcSyntaxMessage(eof, 'const value = {', 1), /end of program|line/)
})

test('the installed runtime receives both parse wrappers once and refuses changed upstream anchors', async () => {
  const source = await fs.readFile(require.resolve('@deepseek-ai/dsh-ptc-runtime-node'), 'utf8')
  const patched = patchPtcRuntimeSource(source)
  assert.ok(patched)
  assert.ok(patched.includes('agentDeskStripPtc(spec.program)'))
  assert.ok(patched.includes('agentDeskStripPtc(STRIP_PREFIX + spec.program + STRIP_SUFFIX, spec.program, 1)'))
  assert.equal(patchPtcRuntimeSource(patched), null)
  assert.equal(patchPtcRuntimeSource(source.replace('stripTypeScriptTypes(spec.program)', 'changed(spec.program)')), null)
  assert.equal(patchPtcRuntimeSource(source.replace('const STRIP_PREFIX =', 'const CHANGED_PREFIX =')), null)
})
