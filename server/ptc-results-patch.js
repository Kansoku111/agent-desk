// PTC hands a tool's value to the model's program, and whatever the program
// returns or logs stays in history and is resent on every later request. edit,
// write and apply_patch values carry the whole file twice: a one-line edit came
// back as 14,598 characters. The UI keeps its diffs, which are computed from the
// full value before this point, and programs can still read the file.
//
// read keeps its {number, text} lines for programs. Returning unnumbered text was
// tried on 2026-11-06 and did not save money: see docs/gpt-efficiency.md. Only the
// printed form is shortened, in compactPrintedLines below.
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

const LINE_ENTRY = /\{\s*["']?number["']?:\s*(\d+),\s*["']?text["']?:\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)\s*\}/g

/**
 * Printed read lines cost 20-34% of all tool-result text in the 2026-11-06 Terra/high
 * logs. console.log and JSON.stringify happen in the program's own process, where
 * no hook can reach, so the text is shortened here. A run of three consecutive line
 * numbers is required so file content that merely looks like one entry stays as it is.
 */
export function compactPrintedLines(text) {
  if (!text.includes('number')) return text
  const hits = [...text.matchAll(LINE_ENTRY)]
  let out = '', at = 0, i = 0
  while (i < hits.length) {
    let j = i
    while (j + 1 < hits.length && Number(hits[j + 1][1]) === Number(hits[j][1]) + 1
      && /^,\s*$/.test(text.slice(hits[j].index + hits[j][0].length, hits[j + 1].index))) j++
    if (j - i >= 2) {
      out += text.slice(at, hits[i].index) + hits.slice(i, j + 1).map((hit) => `${hit[1]} ${hit[2]}`).join(',\n')
      at = hits[j].index + hits[j][0].length
    }
    i = j + 1
  }
  return out + text.slice(at)
}

const VALUE = 'value: result.value'
const OUTPUT = 'output: definition.output.schema'
const PARTS = 'const parts = [value.logs.join("\\n"), rendered].filter((part) => part.length > 0);'

export function patchPtcResultsSource(source) {
  if (source.includes('agentDeskCompactResult') || [VALUE, OUTPUT, PARTS].some((anchor) => source.split(anchor).length !== 2)
    || !source.includes('const { name } = schema;')) return null
  const imports = 'import { compactPtcResult as agentDeskCompactResult, compactPrintedLines as agentDeskCompactPrinted } from ' + JSON.stringify(new URL('./ptc-results-patch.js', import.meta.url).href) + ';\n'
  return imports + source
    .replace(VALUE, 'value: agentDeskCompactResult(name, result.value)')
    .replace(OUTPUT, 'output: agentDeskCompactResult(definition.name, definition.output.schema)')
    .replace(PARTS, () => 'const parts = [agentDeskCompactPrinted(value.logs.join("\\n")), agentDeskCompactPrinted(rendered)].filter((part) => part.length > 0);')
}
