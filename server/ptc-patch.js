// All-or-nothing: if either settings or internal history cannot be connected,
// do not advertise PTC. The sender refuses PTC when the option is absent.
export function patchPtcSource(source) {
  const anchors = [
    'return this.modelControl.options(signal);',
    'return this.modelControl.set(configId, value, signal);',
    'this.modelControl.options().then((configOptions) => {',
    'async prompt(params, imageEnabled, requestSignal) {',
    '} else if (event.type === "tool/call") {',
  ]
  if (source.includes('agentDeskSetToolMode') || anchors.some((anchor) => source.split(anchor).length !== 2)
    || !source.includes('function toolCallUpdate(event) {')
    || !source.includes('async function toolResultUpdate(ctx, event) {')) return null
  const imports = `import { withToolMode as agentDeskToolOptions, setToolMode as agentDeskSetToolMode, assertPresentationReady as agentDeskPresentationReady, TOOL_MODE_CONFIG as agentDeskToolModeId, ptcEventUpdate as agentDeskPtcUpdate, ptcResultEvent as agentDeskPtcResult } from ${JSON.stringify(new URL('./ptc-bridge.js', import.meta.url).href)};\n`
  return imports + source
    .replace(anchors[0], 'return this.modelControl.options(signal).then((options) => agentDeskToolOptions(this, options));')
    .replace(anchors[1], `if (configId === agentDeskToolModeId) return agentDeskSetToolMode(this, value).then(() => this.configOptions(signal));
return this.modelControl.set(configId, value, signal).then((options) => agentDeskToolOptions(this, options));`)
    .replace(anchors[2], 'this.configOptions().then((configOptions) => {')
    .replace(anchors[3], `${anchors[3]}\nagentDeskPresentationReady(this);`)
    .replace(anchors[4], `} else if (event.type === "tool/ptc-dispatch-start" || event.type === "tool/ptc-dispatch") {
const delivery = this.outputTail.then(async () => {
  const update = agentDeskPtcUpdate(event);
  if (event.type === "tool/ptc-dispatch") Object.assign(update, await toolResultUpdate(this.ctx, agentDeskPtcResult(event)));
  await this.notify({ sessionId: this.agent.session.id, update });
});
this.outputTail = delivery.catch((error) => {
  if (this.inflight) this.inflight.outputError ??= error;
  this.ctx.logger.warn("acp: PTC update delivery failed: " + error);
});
${anchors[4]}`)
}
