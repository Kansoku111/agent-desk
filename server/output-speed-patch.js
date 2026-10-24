// A narrow in-memory ACP extension. Source drift disables only the readout at
// normal launch and is rejected by the existing update compatibility gate.
export function patchOutputSpeedSource(source) {
  if (source.includes('agentDeskBeginSpeed')) return null
  const begin = 'this.inflight = inflight;'
  const finish = 'requestSignal?.removeEventListener("abort", onRequestAbort);'
  const events = 'ctx.on("agent/error", ({ agent, error }) => {'
  if ([begin, finish, events].some((anchor) => source.split(anchor).length !== 2)
    || !source.includes('const ownedRecord = (agent) => {')) return null
  const imports = `import { beginOutputSpeed as agentDeskBeginSpeed, observeOutputSpeed as agentDeskObserveSpeed, finishOutputSpeed as agentDeskFinishSpeed } from ${JSON.stringify(new URL('./output-speed-bridge.js', import.meta.url).href)};\n`
  return imports + source
    .replace(begin, `${begin}\nagentDeskBeginSpeed(this);`)
    .replace(finish, `${finish}\nawait agentDeskFinishSpeed(this);`)
    .replace(events, `ctx.on("agent/assistant-stream", ({ agent, frame }) => { agentDeskObserveSpeed(ownedRecord(agent), frame); });\n${events}`)
}
