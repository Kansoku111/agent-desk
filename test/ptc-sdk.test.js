import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import ts from 'typescript'
import { shareOutputTypes, patchPtcSdkSource, ptcDataExamples } from '../server/ptc-sdk-patch.js'

const require = createRequire(import.meta.url)
const mcp = '{ content: JsonValue[]; structuredContent?: JsonValue; }'
const goal = '{ goal: null | { id: string; revision: number; phase: "active" | "complete"; objective: string; roundsStarted: number; maxGoalRounds: number }; activation: "armed" | "disarmed" }'
function entries() {
  return [...Array.from({length:46},(_,i)=>['mcp_call_'+i,mcp]),...['create_goal','get_goal','update_goal'].map(name=>[name,goal]),...Array.from({length:9},(_,i)=>['short_'+i,'JsonValue']),['"odd:key"','{ distinct?: readonly number[] }']]
}
function diagnostics(source) {
  const file = 'ptc-sdk-equivalence.ts'
  const options = { noEmit:true,strict:true,target:ts.ScriptTarget.ES2022,types:[],skipLibCheck:true }
  const host = ts.createCompilerHost(options)
  const get = host.getSourceFile.bind(host)
  host.getSourceFile = (name,language,onError,create) => name.endsWith(file) ? ts.createSourceFile(name,source,language,true) : get(name,language,onError,create)
  return ts.getPreEmitDiagnostics(ts.createProgram([file],options,host))
}
function comparison(list, shared) {
  const before = list.map(([name,type])=>'  '+name+': '+type+';').join('\n')
  const checks = list.map(([name],i)=>{const key=name.startsWith('"')?JSON.parse(name):name;return 'type Check'+i+' = Assert<Eq<Before['+JSON.stringify(key)+'],After['+JSON.stringify(key)+']>>;'}).join('\n')
  return 'type JsonValue = null | boolean | number | string | JsonValue[] | { [key:string]:JsonValue };\n'
    +'interface Before {\n'+before+'\n}\n'+shared.aliases.join('\n\n')+'\ninterface After {\n'+shared.members.join('\n')+'\n}\n'
    +'type Eq<A,B> = (<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2) ? true:false;\ntype Assert<T extends true> = T;\ntype Keys = Assert<Eq<keyof Before,keyof After>>;\n'+checks
}

test('SDK output factoring preserves names, order and type text without expanding small or unique types', () => {
  const list=entries(); const before=structuredClone(list)
  const shared=shareOutputTypes(list)
  assert.equal(shared.aliases.length,2)
  assert.deepEqual(list,before)
  list.forEach(([name],i)=>assert.ok(shared.members[i].startsWith('  '+name+': ')))
  assert.ok(shared.aliases.some(alias=>alias.endsWith(mcp+';')))
  assert.ok(shared.aliases.some(alias=>alias.endsWith(goal+';')))
  assert.ok(shared.members.some(member=>member==='  short_0: JsonValue;'))
  const original=list.map(([name,type])=>'  '+name+': '+type+';').join('\n')
  assert.ok(shared.aliases.join('\n\n').length+shared.members.join('\n').length<original.length)
  assert.deepEqual(shareOutputTypes([]),{aliases:[],members:[]})
  assert.deepEqual(shareOutputTypes([['one','number'],['two','number']]),{aliases:[],members:['  one: number;','  two: number;']})
})

test('TypeScript proves every compacted output and key identical; a required-field negative control fails', () => {
  const list=entries(), shared=shareOutputTypes(list)
  const errors=diagnostics(comparison(list,shared))
  assert.equal(errors.length,0,errors.map(e=>ts.flattenDiagnosticMessageText(e.messageText,'\n')).join('\n'))
  const changed={...shared,aliases:shared.aliases.map(alias=>alias.replace('structuredContent?:','structuredContent:'))}
  assert.ok(diagnostics(comparison(list,changed)).length>=46)
})

test('the real SDK renderer is patched once without altering argument docs or the Python renderer', async () => {
  const source=await fs.readFile(require.resolve('@deepseek-ai/dsh-tool-executor-ptc'),'utf8')
  const patched=patchPtcSdkSource(source)
  assert.ok(patched)
  assert.equal(patchPtcSdkSource(patched),null)
  assert.equal(patchPtcSdkSource(source.replace('const outputMembers = [];','const changedMembers = [];')),null)
  assert.equal(patchPtcSdkSource(source+'\n// outputMembers added by changed upstream'),null)
  for(const line of source.split('\n').filter(line=>line.includes('argsMembers.push'))) assert.ok(patched.includes(line))
  const py=source.indexOf('function renderToolsSdkPy(')
  assert.ok(py>=0)
  assert.equal(patched.slice(patched.indexOf('function renderToolsSdkPy(')),source.slice(py))
})

test('PTC data schema, binding and presentation changes fail closed together on upstream drift', async () => {
  const source = await fs.readFile(require.resolve('@deepseek-ai/dsh-tool-executor-ptc'), 'utf8')
  for (const [before, after] of [
    ['return parameterSchemaSpecToJsonSchema({', 'return changedParameterSchema({'],
    ['rawInput: args.code', 'rawInput: args.changedCode'],
    ['const instructions = renderSdkInstructions(programFormat);', 'const instructions = changedInstructions();'],
    ['signal: runController.signal,', 'signal: changedSignal,'],
  ]) assert.equal(patchPtcSdkSource(source.replace(before, after)), null)
  const patched = patchPtcSdkSource(source)
  assert.match(patched, /agentDeskDataBindings\(args, runtime\)/)
  assert.match(patched, /declare const input/)
  assert.match(patched, /agentDeskDataExamples\(sorted, programFormat\)/)
  assert.match(patched, /Pass a JSON arguments object to every tools binding/)
  assert.match(patched, /Combine progress-only/)
})

test('complete data examples are valid calls, follow available tools, and match the usage guide', async () => {
  const parse = text => [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map(x => JSON.parse(x[1]))
  const examples = parse(ptcDataExamples(['edit', 'write', 'todo_write'].map(name => ({ name }))))
  assert.equal(examples.length, 2)
  assert.equal(ptcDataExamples([{ name: 'edit' }], 'script'), '')
  for (const call of examples) {
    assert.deepEqual(Object.keys(call), ['code', 'description', 'data'])
    assert.ok(call.code && call.description)
    assert.ok(call.code.includes('await input.get()'))
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    assert.doesNotThrow(() => new AsyncFunction('tools', 'input', call.code))
  }
  assert.ok(examples[0].code.includes('tools.edit'))
  assert.ok(examples[1].code.includes('tools.write') && examples[1].code.includes('tools.todo_write'))
  assert.ok(examples[1].data.todos.every(todo => todo.status !== 'completed'))
  assert.equal(ptcDataExamples([{ name: 'read' }, { name: 'glob' }]), '')
  assert.equal(ptcDataExamples([{ name: 'write' }]), '')
  assert.equal(parse(ptcDataExamples([{ name: 'edit' }])).length, 1)
  const doc = await fs.readFile(new URL('../docs/ptc.md', import.meta.url), 'utf8')
  assert.deepEqual(parse(doc), examples)
})

test('the TypeScript run_code instructions gain one batching line after the Promise.all line, and the Python ones do not', async () => {
  const source=await fs.readFile(require.resolve('@deepseek-ai/dsh-tool-executor-ptc'),'utf8')
  const patched=patchPtcSdkSource(source)
  const line=patched.split('\n').find(l=>l.startsWith('- Every \\`run_code\\` call costs a model round trip.'))
  assert.ok(line)
  assert.equal(patched.split(line).length,2)
  assert.ok(patched.indexOf('under \\`Promise.all\\`')<patched.indexOf(line))
  assert.ok(!patched.includes('under \\`asyncio.gather\\` (safe calls run concurrently; mutating calls run alone, in submission order). Sequence dependent work with \\`await\\`.\n- Every'))
  assert.equal(patchPtcSdkSource(source.replace('\\`Promise.all\\`','\\`Promise.allSettled\\`')),null)
})
