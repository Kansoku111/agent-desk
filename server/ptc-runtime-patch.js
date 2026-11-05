// Every execution mode must keep its existing compiler and failure contract.
// The runtime strips types in resolveMode(): per-call wraps the program in a
// function (one wrapper line), while persistent-in-memory and vm-script hand
// Node's compiler over as-is. A fourth mode, or any other change to those
// three sites, must fail the match so a human reviews it.
export function patchPtcRuntimeSource(source) {
  const wrapped = 'stripTypeScriptTypes(STRIP_PREFIX + program + STRIP_SUFFIX)'
  const direct = 'stripTypes: stripTypeScriptTypes'
  const prefix = 'const STRIP_PREFIX = ' + JSON.stringify('async function __dsh_program__() {' + String.fromCharCode(10)) + ';'
  if (source.includes('agentDeskStripPtc') || source.split(wrapped).length !== 2 || source.split(direct).length !== 3 || source.split(prefix).length !== 2) return null
  const imports = 'import { stripPtcTypes as agentDeskStripPtc } from ' + JSON.stringify(new URL('./ptc-program-error.js', import.meta.url).href) + ';\n'
  return imports + source.replace(wrapped, 'agentDeskStripPtc(STRIP_PREFIX + program + STRIP_SUFFIX, program, 1)')
    .replaceAll(direct, 'stripTypes: agentDeskStripPtc')
}
