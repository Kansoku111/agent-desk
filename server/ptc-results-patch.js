// PTC hands a tool's value to the model's program, and whatever the program
// returns or logs stays in history and is resent on every later request. edit,
// write and apply_patch values carry the whole file twice: a one-line edit came
// back as 14,598 characters. The UI keeps its diffs, which are computed from the
// full value before this point, and programs can still read the file.
//
// read keeps its {number, text} lines. Returning unnumbered text was tried on
// 2026-11-06 and did not save money: see docs/gpt-efficiency.md.
const FILE_TOOLS = new Set(['edit', 'write', 'apply_patch'])

// A value has before/after as keys, and its schema has them under `properties`,
// so the same walk serves both and the declaration always matches the value.
function withoutFileText(node) {
  if (Array.isArray(node)) return node.map(withoutFileText)
  if (!node || typeof node !== 'object') return node
  const entries = Object.entries(node).filter(([key]) => !(key === 'before' || key === 'after') || !('before' in node && 'after' in node))
  return Object.fromEntries(entries.map(([key, value]) => [key, withoutFileText(value)]))
}

export const compactPtcResult = (name, value) => FILE_TOOLS.has(name) ? withoutFileText(value) : value

const VALUE = 'value: result.value'
const OUTPUT = 'output: definition.output.schema'

export function patchPtcResultsSource(source) {
  if (source.includes('agentDeskCompactResult') || [VALUE, OUTPUT].some((anchor) => source.split(anchor).length !== 2)
    || !source.includes('const { name } = schema;')) return null
  const imports = 'import { compactPtcResult as agentDeskCompactResult } from ' + JSON.stringify(new URL('./ptc-results-patch.js', import.meta.url).href) + ';\n'
  return imports + source
    .replace(VALUE, 'value: agentDeskCompactResult(name, result.value)')
    .replace(OUTPUT, 'output: agentDeskCompactResult(definition.name, definition.output.schema)')
}
