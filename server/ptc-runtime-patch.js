// Every execution mode must keep its existing compiler and failure contract.
// The runtime strips types in resolveMode(): per-call wraps the program in a
// function (one wrapper line), while persistent-in-memory and vm-script hand
// Node's compiler over as-is. A fourth mode, or any other change to those
// three sites, must fail the match so a human reviews it.
export function patchPtcRuntimeSource(source) {
  const wrapped = 'stripTypeScriptTypes(STRIP_PREFIX + program + STRIP_SUFFIX)'
  const direct = 'stripTypes: stripTypeScriptTypes'
  const prefix = 'const STRIP_PREFIX = ' + JSON.stringify('async function __dsh_program__() {' + String.fromCharCode(10)) + ';'
  const bootstrap = 'if (!new URL(import.meta.url).pathname.endsWith(".ts")) return [mapped(fileURLToPath(new URL("./process.js", import.meta.url))), String(maxMessageBytes)];'
  if (source.includes('agentDeskStripPtc') || source.split(wrapped).length !== 2 || source.split(direct).length !== 3 || source.split(prefix).length !== 2 || source.split(bootstrap).length !== 2) return null
  const imports = 'import { stripPtcTypes as agentDeskStripPtc } from ' + JSON.stringify(new URL('./ptc-program-error.js', import.meta.url).href) + ';\n'
  // The worker does not inherit the host's loaders. Pass only this known hook,
  // mapped into its execution world, before confinement is applied to argv.
  const hook = JSON.stringify(new URL('./ptc-errors-hook.js', import.meta.url).href)
  return imports + source.replace(wrapped, 'agentDeskStripPtc(STRIP_PREFIX + program + STRIP_SUFFIX, program, 1)')
    .replaceAll(direct, 'stripTypes: agentDeskStripPtc')
    .replace(bootstrap, 'if (!new URL(import.meta.url).pathname.endsWith(".ts")) return ["--import", pathToFileURL(mapped(fileURLToPath(' + hook + '))).href, mapped(fileURLToPath(new URL("./process.js", import.meta.url))), String(maxMessageBytes)];')
}

// Only the data accessor has no meaningful arguments. Do not normalize native
// tool arguments, rewrite user programs, or weaken the lossless-JSON boundary.
export function patchPtcWorkerSource(source) {
  const namespace = 'return data.namespaces.map(({ global, names }) => {'
  const binding = '\t\t\tvalue: async (args) => {\n\t\t\t\tconst errorClass = errorClasses.get(global);'
  if (source.includes('args = global === "input"') || source.split(namespace).length !== 2 || source.split(binding).length !== 2) return null
  return source.replace(binding, '\t\t\tvalue: async (args = global === "input" && name === "get" ? {} : void 0) => {\n\t\t\t\tconst errorClass = errorClasses.get(global);')
}
