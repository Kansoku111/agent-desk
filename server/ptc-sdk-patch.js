/** Share only byte-identical output types; native argument docs, keys and order stay intact. */
export function shareOutputTypes(entries, indent = '  ') {
  const counts = new Map()
  for (const [, type] of entries) counts.set(type, (counts.get(type) ?? 0) + 1)
  const aliasByType = new Map(), aliases = []
  for (const [type, count] of counts) {
    if (count < 2) continue
    const alias = 'SharedOutput' + (aliases.length + 1)
    // Require a clear size win, including the new declaration and references.
    if ((count - 1) * (type.length - alias.length) <= type.length + alias.length + 11) continue
    aliasByType.set(type, alias)
    aliases.push('type ' + alias + ' = ' + type + ';')
  }
  return { aliases, members: entries.map(([name, type]) => indent + name + ': ' + (aliasByType.get(type) ?? type) + ';') }
}

// Complete argument objects keep data attached to the call, rather than
// teaching only a code fragment that can be copied without its literal input.
export function ptcDataExamples(schemas) {
  const names = new Set(schemas.map(schema => schema.name))
  const calls = []
  if (names.has('edit')) calls.push({
    code: 'return await tools.edit(await input.get());',
    description: 'Edit a file from literal data',
    data: { file_path: 'src/example.txt', old_string: 'old text', new_string: 'new text' },
  })
  if (names.has('write') && names.has('todo_write')) calls.push({
    code: 'const {files,todos} = await input.get(); for (const file of files) await tools.write(file); return await tools.todo_write({todos});',
    description: 'Write files and update the current task list',
    data: {
      files: [{ file_path: 'src/example.cjs', content: "const name = 'world';\nconsole.log(`hello ${name}`);\n" }],
      todos: [{ content: 'Implement changes', status: 'in_progress' }, { content: 'Verify changes', status: 'pending' }],
    },
  })
  if (!calls.length) return ''
  return '\n\nComplete run_code argument objects (not program text). After required inspection, adapt the paths and data; use your complete current task list and only permitted tools:\n'
    + calls.map(call => '```json\n' + JSON.stringify(call, null, 2) + '\n```').join('\n\n')
}

const LOOP = "\tconst outputMembers = [];\n\tfor (const schema of sorted) {\n\t\targsMembers.push(...docLines$1(schema.description, 1));\n\t\targsMembers.push(`${pad$1(1)}${renderKey(schema.name)}: ${jsonSchemaToTs(schema.parameters, 1)};`);\n\t\toutputMembers.push(`${pad$1(1)}${renderKey(schema.name)}: ${jsonSchemaToTs(schema.output, 1)};`);\n\t}"
const SHARED_LOOP = "\tconst outputTypes = [];\n\tfor (const schema of sorted) {\n\t\targsMembers.push(...docLines$1(schema.description, 1));\n\t\targsMembers.push(`${pad$1(1)}${renderKey(schema.name)}: ${jsonSchemaToTs(schema.parameters, 1)};`);\n\t\toutputTypes.push([renderKey(schema.name), jsonSchemaToTs(schema.output, 1)]);\n\t}\n\tconst shared = agentDeskShareOutputs(outputTypes, pad$1(1));"
const OUTPUT = "\t\t`interface ToolOutputMap {${outputMembers.length > 0 ? `\\n${outputMembers.join(\"\\n\")}\\n` : \"\"}}`,"
const SHARED_OUTPUT = "\t\t...(shared.aliases.length > 0 ? [shared.aliases.join(\"\\n\\n\")] : []),\n\t\t`interface ToolOutputMap {${shared.members.length > 0 ? `\\n${shared.members.join(\"\\n\")}\\n` : \"\"}}`,"
// The TypeScript flavor's end of the "Inside the program" list (the Python flavor says asyncio.gather).
const PARALLEL_TAIL = "(safe calls run concurrently; mutating calls run alone, in submission order). Sequence dependent work with \\`await\\`.\n"
const PARALLEL = "- Independent read-only calls MAY overlap under \\`Promise.all\\` " + PARALLEL_TAIL
// The model otherwise spends one run_code per step (read, write, test), and every
// run_code is a model round trip. Given as task text, this line cut run_code calls
// by 40-50% on small tasks (docs/investigations/gpt-siwc-regression-20261107.md),
// and the same as a line in this system prompt on task D; task F saw little change.
const BATCH = [
  '- Every `run_code` call costs a model round trip. Put the reads, the write that depends on them and the check that verifies it in one program (read the files, write, then run the tests) instead of one program per step; split only where you must see an output before choosing the next step.',
  '- Supply `code` and `description` before optional `run_code.data` in the same call. Put file contents and edit `old_string`/`new_string` in `data`, not nested JavaScript strings. Use the complete examples when available. Data is not compiled as program text; normal tool permissions apply. Data is available only in that call: do not split data upload and execution.',
  '- Pass a JSON arguments object to every tools binding, including `{}` when there are no fields. To enter the task directory, call `tools.working_directory({cd: "the assigned directory"})` once and batch the initial inspection with it; do not query the inherited directory and then browse a different project. Combine progress-only `todo_write` updates with actual work instead of spending a separate model response on them.',
].join('\n').replaceAll('`', '\\`') + '\n'
const STATIC_PARAMS = '\t\tparameters: {\n\t\t\tcode: {'
const DYNAMIC_PARAMS = '\t\t\treturn parameterSchemaSpecToJsonSchema({\n\t\t\t\tcode: {'
const STATIC_DATA = '\t\t\t...RUN_CODE_CONTROLS\n'
const DYNAMIC_DATA = '\t\t\t\t...controlParameters(runtime)'
const BINDINGS = '\t\t\t\t\t\t\t}],\n\t\t\t\t\t\t\tsignal: runController.signal,'
const DECLARATION = '\t\t"type ToolName = keyof ToolOutputMap",'
const DESCRIPTION = 'return resolveFlavor(runtime).description + (instructions ?'
const PRESENTATION = 'rawInput: args.code'
const SDK_INSTRUCTIONS = '\tconst instructions = renderSdkInstructions(programFormat);'

export function patchPtcSdkSource(source) {
  const anchors = [LOOP, OUTPUT, PARALLEL, STATIC_PARAMS, DYNAMIC_PARAMS, STATIC_DATA, DYNAMIC_DATA, BINDINGS, DECLARATION, DESCRIPTION, PRESENTATION, SDK_INSTRUCTIONS]
  if (source.includes('agentDeskShareOutputs') || source.split('outputMembers').length !== 5
    || anchors.some(anchor => source.split(anchor).length !== 2)) return null
  const imports = 'import { shareOutputTypes as agentDeskShareOutputs, ptcDataExamples as agentDeskDataExamples } from ' + JSON.stringify(new URL('./ptc-sdk-patch.js', import.meta.url).href) + ';\n'
    + 'import { PTC_DATA_DESCRIPTION as agentDeskDataDescription, PTC_DATA_PARAMETERS as agentDeskDataParameters, ptcDataParameters as agentDeskRuntimeDataParameters, ptcDataBindings as agentDeskDataBindings } from ' + JSON.stringify(new URL('./ptc-data.js', import.meta.url).href) + ';\n'
  return imports + source
    .replace(LOOP, SHARED_LOOP)
    .replace(OUTPUT, SHARED_OUTPUT)
    .replace(PARALLEL, () => PARALLEL + BATCH)
    .replace(SDK_INSTRUCTIONS, '\tconst instructions = renderSdkInstructions(programFormat) + agentDeskDataExamples(sorted);')
    .replace(STATIC_DATA, '\t\t\t...agentDeskDataParameters,\n' + STATIC_DATA)
    .replace(DYNAMIC_DATA, '\t\t\t\t...agentDeskRuntimeDataParameters(runtime),\n' + DYNAMIC_DATA)
    .replace(BINDINGS, '\t\t\t\t\t\t\t}, ...agentDeskDataBindings(args, runtime)],\n\t\t\t\t\t\t\tsignal: runController.signal,')
    .replace(DECLARATION, DECLARATION + '\n\t\t"/** Only bound when run_code.data is supplied. */\\ndeclare const input: { get<T = JsonValue>(args?: Record<string, never> | readonly []): Promise<T> };",')
    .replace(DESCRIPTION, 'return resolveFlavor(runtime).description + (runtime.language === "typescript" ? " " + agentDeskDataDescription : "") + (instructions ?')
    .replace(PRESENTATION, 'rawInput: Object.hasOwn(args, "data") ? { code: args.code, data: args.data } : args.code')
}
