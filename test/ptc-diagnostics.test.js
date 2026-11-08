import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import { stripPtcTypes, ptcSyntaxMessage } from '../server/ptc-program-error.js'
import { patchPtcRuntimeSource, patchPtcWorkerSource } from '../server/ptc-runtime-patch.js'

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

test('a long program still marks the syntax error when Unicode occurs only after it', () => {
  const program = 'const before = 1; '.repeat(45) + 'const broken = {x: 1); ' + 'const todo = "確認する"; '.repeat(30)
  assert.throws(() => stripPtcTypes(PREFIX + program + SUFFIX, program, 1), error => {
    assert.match(error.message, /line 1, column/)
    assert.ok(error.message.length < 240)
    const [source, caret] = error.message.split('\n').slice(-2)
    assert.equal(source[caret.indexOf('^')], ')')
    assert.ok(source.includes('const broken = {x: 1)'))
    return true
  })
})

test('Japanese before a long-line syntax error retains its exact source column', () => {
  const program = 'const label = "確認日本語"; ' + 'const before = 1; '.repeat(45) + 'const broken = {x: 1); ' + 'const after = 2; '.repeat(30)
  assert.throws(() => stripPtcTypes(PREFIX + program + SUFFIX, program, 1), error => {
    assert.match(error.message, new RegExp('line 1, column ' + (program.indexOf(');') + 1)))
    const [source, caret] = error.message.split('\n').slice(-2)
    assert.equal(source[caret.indexOf('^')], ')')
    assert.ok(error.message.length < 240)
    return true
  })
})

test('a caret following visible Japanese uses display width', () => {
  const program = 'const label = "確認"; const broken = {x: 1)'
  assert.throws(() => stripPtcTypes(PREFIX + program + SUFFIX, program, 1), error => {
    assert.match(error.message, new RegExp('column ' + (program.indexOf(')') + 1)))
    const [source, caret] = error.message.split('\n').slice(-2)
    assert.equal(caret.indexOf('^'), source.indexOf(')') + 2)
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
        const position = source.indexOf(')')
        const wide = [...source.slice(0, position)].filter(char => char.charCodeAt(0) > 0x7e).length
        assert.equal(caret.indexOf('^'), position + wide)
      }
      return true
    })
  }
})

test('unsupported display widths before the error never claim a column', () => {
  for (const prefix of ['😀', '👩‍💻', 'e\u0301', '🇯🇵', '\t']) {
    const program = (prefix === '\t' ? '\tconst prefix = 1' : 'const prefix = ' + JSON.stringify(prefix)) + '; const broken = {x: 1); ' + ' '.repeat(80)
    assert.throws(() => stripPtcTypes(PREFIX + program + SUFFIX, program, 1), error => {
      assert.match(error.message, /line 1/)
      assert.doesNotMatch(error.message, /column|\n *\^/)
      return true
    })
  }
})

test('standalone carriage-return line breaks retain the error line', () => {
  const program = 'const a=1;\rconst broken={x:1)'
  assert.throws(() => stripPtcTypes(PREFIX + program + SUFFIX, program, 1), error => {
    assert.match(error.message, /line 2/)
    assert.doesNotMatch(error.message, /end of program/)
    return true
  })
})

test('zero-width characters at the caret boundary never produce a false column', () => {
  const program = 'const x={a:e\u0301)'
  assert.throws(() => stripPtcTypes(PREFIX + program + SUFFIX, program, 1), error => {
    assert.match(error.message, /line 1/)
    assert.doesNotMatch(error.message, /column|\n *\^/)
    return true
  })
})

test('diagnostic excerpts are well-formed and exclude terminal control characters', () => {
  for (const tail of ['a'.repeat(21) + '😀tail', '\x1b[31m\0\u202emore']) {
    const program = 'const broken = {x: 1);' + tail
    assert.throws(() => stripPtcTypes(PREFIX + program + SUFFIX, program, 1), error => {
      assert.ok(error.message.isWellFormed())
      assert.doesNotMatch(error.message, /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e]/)
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

test('only input.get gains default arguments at the installed worker JSON boundary', async () => {
  const source = await fs.readFile(new URL('./process.js', import.meta.resolve('@deepseek-ai/dsh-ptc-runtime-node')), 'utf8')
  const patched = patchPtcWorkerSource(source)
  assert.ok(patched)
  assert.ok(patched.includes('args = global === "input" && name === "get" ? {} : void 0'))
  assert.ok(patched.includes('binding arguments must be lossless JSON'))
  assert.equal(patchPtcWorkerSource(patched), null)
  assert.equal(patchPtcWorkerSource(source.replace('value: async (args) => {', 'value: async (changed) => {')), null)
  assert.equal(patchPtcWorkerSource(source.replace('return data.namespaces.map(({ global, names }) => {', 'return changedNamespaces(data);')), null)
})

test('the installed runtime wraps every execution mode once and refuses changed upstream anchors', async () => {
  const source = await fs.readFile(require.resolve('@deepseek-ai/dsh-ptc-runtime-node'), 'utf8')
  const patched = patchPtcRuntimeSource(source)
  assert.ok(patched)
  // per-call wraps the program in one function line; persistent-in-memory and vm-script strip it directly.
  assert.equal(patched.split('agentDeskStripPtc(STRIP_PREFIX + program + STRIP_SUFFIX, program, 1)').length, 2)
  assert.equal(patched.split('stripTypes: agentDeskStripPtc').length, 3)
  assert.ok(!patched.includes('stripTypes: stripTypeScriptTypes'))
  assert.ok(patched.includes('["--import", pathToFileURL(mapped(fileURLToPath('))
  assert.equal(patchPtcRuntimeSource(source.replace('mapped(fileURLToPath(new URL("./process.js", import.meta.url)))', 'changedWorkerBootstrap()')), null)
  assert.equal(patchPtcRuntimeSource(patched), null)
  assert.equal(patchPtcRuntimeSource(source.replace('stripTypeScriptTypes(STRIP_PREFIX + program + STRIP_SUFFIX)', 'changed(STRIP_PREFIX + program + STRIP_SUFFIX)')), null)
  assert.equal(patchPtcRuntimeSource(source.replace('stripTypes: stripTypeScriptTypes', 'stripTypes: changed')), null)
  assert.equal(patchPtcRuntimeSource(source + '\nconst another = { stripTypes: stripTypeScriptTypes }'), null)
  assert.equal(patchPtcRuntimeSource(source.replace('const STRIP_PREFIX =', 'const CHANGED_PREFIX =')), null)
})
