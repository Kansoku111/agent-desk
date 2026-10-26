// Process-local scheduling only. A team wait never pauses, completes or rearms a goal.
export const GOAL_WAIT_CONFIG = 'agent_desk_goal_wait'
export const GOAL_WAIT_AFTER_STEER = 'agentDesk/goalWaitAfterSteer'
const waiting = new WeakSet()
let driverReady = false

export function goalWaitDriverReady() { driverReady = true }
export function isGoalWaiting(agent) { return waiting.has(agent) }

/** Internal ACP option, deliberately not advertised as a user/model setting. */
export function setGoalWaiting(record, value) {
  record.assertActive()
  if (!driverReady) throw new Error('team goal-wait driver is unavailable; restart Agent Desk after updating dsh')
  if (!['waiting', 'ready', 'cancelled'].includes(value)) throw new Error('unknown team goal-wait state')
  if (value === 'ready') waiting.delete(record.agent)
  else waiting.add(record.agent)
  // A request/response acknowledgement avoids reopening the gate before a cancel notification lands.
  if (value === 'cancelled') record.cancel()
  return [{ id: GOAL_WAIT_CONFIG, name: 'Team wait', type: 'select', currentValue: value, options: [
    { value: 'waiting', name: 'Waiting' }, { value: 'ready', name: 'Ready' }, { value: 'cancelled', name: 'Cancelled' },
  ] }]
}
