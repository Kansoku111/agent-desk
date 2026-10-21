// How steer-hook.js changes dsh-acp, kept apart so Agent Desk's own process can
// use the names and tests can check the patch without registering the hook.
export const STEER_META = 'agentDesk/steer'
export const STEERED_META = 'agentDesk/steered'

/**
 * dsh-acp's source with steering added, or null when it does not look as expected.
 * Names come from the built source, as the bundler may rename them.
 */
export function patchAcpSource(source) {
  const busy = /if \(this\.inflight !== void 0\) throw ([\w$]+)\("a prompt is already in flight for this session"\);/.exec(source)
  const admit = /const content = await ([\w$]+)\(this\.ctx, promptSelection, params\.prompt, imageEnabled, admissionController\.signal\);/.exec(source)
  const message = /const message = ([\w$]+)\(\{\s*content,\s*source: \{ kind: "user" \}\s*\}\);/.exec(source)
  if (!busy || !admit || !message || source.indexOf(busy[0]) !== source.lastIndexOf(busy[0])) return null
  const [, invalidParams] = busy
  const unavailable = `${invalidParams}("agent-desk/steer-unavailable: the current turn no longer accepts messages")`
  // Accepted only while the turn still runs: a message steered into an idle
  // agent would start a turn no prompt waits for.
  const open = (inflight) => `this.inflight === ${inflight} && !${inflight}.cancelRequested && !${inflight}.admissionController?.signal.aborted && this.agent.status === "running"`
  const steer = [
    `if (this.inflight !== void 0 && params._meta?.[${JSON.stringify(STEER_META)}] === true) {`,
    'const steerInflight = this.inflight;',
    `if (!(${open('steerInflight')})) throw ${unavailable};`,
    `const steerContent = await ${admit[1]}(this.ctx, this.modelControl.snapshot(), params.prompt, imageEnabled, requestSignal ?? new AbortController().signal);`,
    `if (!(${open('steerInflight')})) throw ${unavailable};`,
    `this.agent.steer(${message[1]}({ content: steerContent, source: { kind: "user" } }));`,
    `return { stopReason: "end_turn", _meta: { ${JSON.stringify(STEERED_META)}: true } };`,
    '}',
  ].join(' ')
  return source.replace(busy[0], () => `${steer} ${busy[0]}`)
}

