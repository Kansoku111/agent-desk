// Both execution modes must keep their existing compiler and failure contract.
export function patchPtcRuntimeSource(source) {
  const direct = 'stripTypeScriptTypes(spec.program)'
  const wrapped = 'stripTypeScriptTypes(STRIP_PREFIX + spec.program + STRIP_SUFFIX)'
  const prefix = 'const STRIP_PREFIX = ' + JSON.stringify('async function __dsh_program__() {' + String.fromCharCode(10)) + ';'
  if (source.includes('agentDeskStripPtc') || [direct, wrapped, prefix].some(anchor => source.split(anchor).length !== 2)) return null
  const imports = 'import { stripPtcTypes as agentDeskStripPtc } from ' + JSON.stringify(new URL('./ptc-program-error.js', import.meta.url).href) + ';\n'
  return imports + source.replace(direct, 'agentDeskStripPtc(spec.program)')
    .replace(wrapped, 'agentDeskStripPtc(STRIP_PREFIX + spec.program + STRIP_SUFFIX, spec.program, 1)')
}
