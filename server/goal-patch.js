// How goal-hook.js changes dsh-acp, kept apart so tests can check the patch
// without registering the hook.
//
// A goal (`create_goal`) keeps a dsh session working on its own: whenever the
// agent goes idle with an active, armed goal, dsh's goal-round driver queues
// the next `<goal_round>` prompt. dsh-acp settles a `session/prompt` as soon
// as the agent first goes idle, though, so the prompt answered `end_turn`
// while the rounds kept running unseen: the task looked finished, its stop
// button was gone, and a "busy" check let the server be replaced mid-round.
//
// The patch keeps the prompt in flight while the goal continues: after the
// agent goes idle it waits for the driver to start the next round, and only
// settles once the goal stops (complete, paused, blocked, disarmed, out of
// rounds), a team leader is parked for external work, or no round starts in time. The prompt's stop reason then comes from
// the last turn. Cancelling the prompt also disarms the goal, so a round the
// driver was about to queue does not run with no prompt waiting for it.

const WAIT_IMPORT = `import { GOAL_WAIT_CONFIG as agentDeskGoalWaitConfig, setGoalWaiting as agentDeskSetGoalWaiting, isGoalWaiting as agentDeskGoalWaiting } from ${JSON.stringify(new URL('./goal-wait.js', import.meta.url).href)};\n`

/** Longest wait for the driver to start the next round once the agent is idle. */
export const ROUND_START_TIMEOUT_MS = 30_000
const POLL_MS = 100

/** Marks the in-flight prompt as following goal rounds, so later turn ends count. */
const FOLLOWING = 'agentDeskFollowingGoal'

/**
 * Patched-in method: resolves true once the next goal round is running, false
 * when the goal will not continue (or the prompt was cancelled).
 */
const WAIT_FOR_ROUND = `async agentDeskNextGoalRound(inflight) {
		const goals = this.ctx.get("goals");
		if (goals === void 0) return false;
		const drivable = () => {
			let goal;
			try {
				goal = goals.get(this.agent);
			} catch {
				return false;
			}
			return goal !== void 0 && goal.phase === "active" && goal.activation === "armed" && goal.roundsStarted < goal.maxGoalRounds;
		};
		const cancelled = () => inflight.cancelRequested === true || inflight.admissionController?.signal.aborted === true;
		const deadline = Date.now() + ${ROUND_START_TIMEOUT_MS};
		while (!cancelled()) {
			// Already-started work must finish even when it consumed the last
			// round, completed the goal, or disarmed it while still running.
			if (this.agent.status === "running") return true;
			if (agentDeskGoalWaiting(this.agent) || !drivable() || Date.now() >= deadline) return false;
			await new Promise((resolve) => setTimeout(resolve, ${POLL_MS}));
		}
		if (cancelled()) {
			try {
				goals.disarm(this.agent);
			} catch {}
			if (this.agent.status === "running") this.agent.cancel({ kind: "user" });
		}
		return false;
	}
	settleAfterQuiescence(inflight) {`

/** dsh-acp's source with goal rounds kept inside the prompt, or null when it does not look as expected. */
export function patchGoalSource(source) {
  const config = '\tsetConfig(configId, value, signal) {\n\t\tthis.assertActive();'
  if (source.includes('agentDeskGoalWaitConfig') || source.split(config).length !== 2) return null
  const patched = patchGoalSettlement(source)
  if (!patched) return null
  return WAIT_IMPORT + patched.replace(config, config + '\n\t\tif (configId === agentDeskGoalWaitConfig) return Promise.resolve(agentDeskSetGoalWaiting(this, value));')
    .replace('\tcancel() {\n\t\tconst inflight = this.inflight;', '\tcancel() {\n\t\tif (agentDeskGoalWaiting(this.agent)) this.ctx.get("goals")?.disarm(this.agent);\n\t\tconst inflight = this.inflight;')
}

function patchGoalSettlement(source) {
  // 0.2.1 drains child agents and uses AbortController for cancellation. Keep
  // that settlement loop intact and re-enter it for every automatic goal round.
  if (source.includes('const cancelled = inflight.cancellationDone.promise;')) return patchGoalSource021(source)
  const settle = /\n\tsettleAfterQuiescence\(inflight\) \{/
  const quiesce = /(\t+)if \(inflight\.messageQueued\) \{\n\t+await this\.agent\.whenIdle\(\);\n\t+await this\.outputTail;\n/
  const turnEnd = 'if (inflight !== void 0 && event.type === "turn/end" && inflight.turn === event.data.turn) inflight.endReason = event.data.reason;'
  const settleAt = source.search(settle)
  const quiesceMatch = quiesce.exec(source)
  if (settleAt === -1 || !quiesceMatch || quiesceMatch.index < settleAt) return null
  if (source.indexOf(turnEnd) === -1 || source.indexOf(turnEnd) !== source.lastIndexOf(turnEnd)) return null
  const indent = quiesceMatch[1]
  const follow = [
    `${indent}\twhile (await this.agentDeskNextGoalRound(inflight)) {`,
    `${indent}\t\tinflight.${FOLLOWING} = true;`,
    `${indent}\t\tawait this.agent.whenIdle();`,
    `${indent}\t\tawait this.outputTail;`,
    `${indent}\t}`,
  ].join('\n')
  let patched = source.replace(quiesceMatch[0], () => `${quiesceMatch[0]}${follow}\n`)
  patched = patched.replace(settle, () => `\n\t${WAIT_FOR_ROUND}`)
  return patched.replace(turnEnd, () => turnEnd.replace(
    'inflight.turn === event.data.turn',
    `(inflight.turn === event.data.turn || inflight.${FOLLOWING} === true)`,
  ))
}


/** Gate reservations and their pre-step rechecks; normal agents never enter this wait set. */
export function patchGoalDriverSource(source) {
  const anchors = ['function apply(ctx) {', 'function readyToDrive(state) {', 'function validReservation(state, content, source) {']
  if (source.includes('agentDeskGoalWaiting') || anchors.some((anchor) => source.split(anchor).length !== 2)) return null
  const imports = 'import { isGoalWaiting as agentDeskGoalWaiting, goalWaitDriverReady as agentDeskGoalWaitDriverReady } from ' + JSON.stringify(new URL('./goal-wait.js', import.meta.url).href) + ';\n'
  return imports + source
    .replace(anchors[0], anchors[0] + '\n\tagentDeskGoalWaitDriverReady();')
    .replace(anchors[1], anchors[1] + '\n\t\tif (agentDeskGoalWaiting(state.agent)) return false;')
    .replace(anchors[2], anchors[2] + '\n\t\t\tif (agentDeskGoalWaiting(state.agent)) return false;')
}

function patchGoalSource021(source) {
  const settle = '\n\tsettleAfterQuiescence(inflight) {'
  const idle = '\t\t\t\t\tawait this.outputTail;\n\t\t\t\t\tif (isCancelled() || idleAt(idleSeq)) break;'
  const cancel = '\t\tinflight.admissionController.abort(new Error(detail));'
  const turnStart = 'if (event.type === "turn/start" && this.inflight?.turn !== void 0) {'
  const turnEnd = 'if (inflight !== void 0 && event.type === "turn/end" && inflight.turn === event.data.turn) {\n\t\t\t\tinflight.endReason = event.data.reason;\n\t\t\t\tinflight.agentError = void 0;\n\t\t\t}'
  for (const anchor of [settle, idle, cancel, turnStart, turnEnd]) {
    if (!source.includes(anchor) || source.indexOf(anchor) !== source.lastIndexOf(anchor)) return null
  }
  if (source.indexOf(idle) < source.indexOf(settle)) return null
  return source.replace(settle, () => `\n\t${WAIT_FOR_ROUND}`)
    .replace(idle, () => [
      '\t\t\t\t\tawait this.outputTail;',
      '\t\t\t\t\tif (isCancelled()) break;',
      '\t\t\t\t\tif (!idleAt(idleSeq)) continue;',
      '\t\t\t\t\tif (await this.agentDeskNextGoalRound(inflight)) {',
      `\t\t\t\t\t\tinflight.${FOLLOWING} = true;`,
      '\t\t\t\t\t\tcontinue;',
      '\t\t\t\t\t}',
      '\t\t\t\t\tif (isCancelled() || idleAt(idleSeq)) break;',
    ].join('\n'))
    // Disarm before aborting, including cancellation during a running round or
    // while waiting for children, when the next-round helper is not running.
    .replace(cancel, () => `\t\ttry { this.ctx.get("goals")?.disarm(this.agent); } catch {}\n${cancel}`)
}
