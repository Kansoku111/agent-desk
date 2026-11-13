// Complete argument objects keep data attached to the call, rather than
// teaching only a code fragment that can be copied without its literal input.
export function ptcDataExamples(schemas, programFormat = 'function-body') {
  if (programFormat !== 'function-body') return ''
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

// Prompt prose is ours, not a patch to dsh's SDK renderer. Keep execution and
// schemas delegated to its public ToolExecutor contract.
const BATCH = [
  '- Every `run_code` call costs a model round trip. Put the reads, the write that depends on them and the check that verifies it in one program (read the files, write, then run the tests) instead of one program per step; split only where you must see an output before choosing the next step.',
  '- Supply `code` and `description` before optional `run_code.data` in the same call. Put file contents and edit `old_string`/`new_string` in `data`, not nested JavaScript strings. Use the complete examples when available. Data is not compiled as program text; normal tool permissions apply. Data is available only in that call: do not split data upload and execution.',
  '- Pass a JSON arguments object to every tools binding, including `{}` when there are no fields. Programs start in the session\'s working directory. Only when the request gives a path to a different directory, call `tools.working_directory({cd: "<that path>"})` once and batch the initial inspection with it; do not query the inherited directory and then browse a different project. Combine progress-only `todo_write` updates with actual work instead of spending a separate model response on them.',
].join('\n') + '\n'

// Programs write grep patterns as JavaScript string literals, where `'f\('` loses its
// backslash and ripgrep rejects the bare `(`. In measured runs about 1 in 7 programs
// failed this way, taking the other results of a Promise.all down with them; a bracket
// class needs no backslash (docs/investigations/dsh-vs-codex-harness-20261112.md).
const GREP = '- `grep` patterns are ripgrep regexes inside JavaScript strings, where a single backslash is dropped (`\'f\\(\'` is just `f(`). Match a literal regex character with a bracket class instead: `[(]`, `[)]`, `[.]`, `[?]`, `[|]` (for example `pattern: \'setOption[(]\'`).\n'

export const PTC_GUIDANCE_SECTION = 'agent-desk:ptc-guidance'

export function ptcGuidance(tools, runtime) {
  if (runtime.language !== 'typescript') return ''
  return BATCH + (tools.some(tool => tool.name === 'grep') ? GREP : '') + ptcDataExamples(tools, runtime.programFormat)
}

// Bind guidance to the selected executor, not a global persona: switching off
// disposes it, and each step supplies its own scope's admitted capabilities.
/** Add only a section; retain the upstream executor's schemas and execution. */
export function withPtcGuidance(executor, ctx) {
  return {
    sections: [...executor.sections, {
      name: PTC_GUIDANCE_SECTION,
      order: ctx.systemPrompt.getSectionOrder('TOOLS_SDK') + 1,
      interpolate: false,
      text: tools => ptcGuidance(tools, ctx.get('ptcRuntime')),
    }],
    describe: tools => executor.describe(tools),
    execute: input => executor.execute(input),
  }
}
