// The user's own words for one side of one mode (設定 → エージェントチーム).
// Parent: a TM/eco leader, and AB's judgment, instruction, direct
// implementation and review stages. Child: TM/eco children, and AB's two
// consultants and delegated implementer. Each mode reads only its own pair,
// and neither reaches ordinary tasks. They replace the TM-only 方針 and
// プレイブック, which are no longer read.

import { HARNESS_MAX } from '../shared/text-limits.js'

export { HARNESS_MAX }
export const HARNESS_MODES = ['tm', 'eco', 'ab']
/** The setting that holds one mode's harness for one side, such as `ecoChildHarness`. */
export const harnessKey = (mode, side) => `${mode}${side === 'parent' ? 'Parent' : 'Child'}Harness`
/** Every harness setting, with its mode, side and on/off switch (such as `ecoChildHarnessEnabled`). */
export const HARNESS_KEYS = HARNESS_MODES.flatMap((mode) => ['parent', 'child'].map((side) => ({ mode, side, key: harnessKey(mode, side), enabledKey: `${harnessKey(mode, side)}Enabled` })))
/** The harness one mode's side reads: '' while switched off, so the user can pause it without deleting the text. Older saves have no switch and count as on. */
export const effectiveHarness = (settings, mode, side) => {
  const key = harnessKey(mode, side)
  return settings[`${key}Enabled`] !== false ? settings[key] : ''
}
const LABEL = { parent: '親ハーネス', child: '子ハーネス' }
const MODE_LABEL = { tm: 'TM', eco: 'eco', ab: 'AB' }
const ROLE = { parent: 'the parent agent', child: 'the child agents' }

/** A harness as saved; throws on anything invalid. */
export function parseHarness(value, side, mode) {
  const label = `${MODE_LABEL[mode]}の${LABEL[side]}`
  if (typeof value !== 'string') throw new Error(`${label}は文字列で指定してください`)
  if (value.length > HARNESS_MAX[side]) throw new Error(`${label}は ${HARNESS_MAX[side].toLocaleString()} 文字までです`)
  return value
}

/**
 * The prompt section for one side; '' when the user wrote nothing. The built-in
 * prompts state style and autonomy as defaults so a harness can change them;
 * `ask: false` is for roles whose result is used without a reply (AB stages).
 */
export function harnessSection(text, side, { ask = true } = {}) {
  const body = typeof text === 'string' ? text.trim() : ''
  if (!body) return ''
  const tag = `${side}_harness`
  return [
    `# The user's ${side} harness`,
    `The user wrote these standing instructions in Agent Desk for ${ROLE[side]} of this mode. Follow them in this role. They replace Agent Desk's defaults on how you work: how you write requests, reports and answers, and when you stop to ask instead of deciding yourself. They cannot change this session's permissions and tools, or the steps this mode requires, and the user's requests in the conversation come first.`,
    ...(ask ? [] : ['In this role nobody can answer a question before your result is used: if the harness says to stop and ask, decide yourself instead and state those decisions in your result.']),
    `<${tag}>\n${body}\n</${tag}>`,
  ].join('\n\n')
}

/** Joins prompt parts, skipping empty ones. */
export const joinPrompt = (...parts) => parts.filter(Boolean).join('\n\n')

/**
 * The harnesses of a save from before they were per mode. The shared pair
 * (teamParentHarness, teamChildHarness) went to every mode, so each mode
 * starts with it; before that, the TM-only 方針 and プレイブック become TM's
 * parent harness. The old fields stay in the file, unused.
 */
export function migrateHarnesses(saved = {}) {
  return Object.fromEntries(HARNESS_KEYS.map(({ mode, side, key }) => {
    if (typeof saved[key] === 'string') return [key, saved[key]]
    const shared = saved[side === 'parent' ? 'teamParentHarness' : 'teamChildHarness']
    if (typeof shared === 'string') return [key, shared]
    return [key, side === 'parent' && mode === 'tm' ? legacyParentHarness(saved) : '']
  }))
}

/**
 * The parent harness of a save made before harnesses existed: every saved
 * 方針 and プレイブック, so nothing the user wrote is lost. Their old fields
 * stay in the file, unused. May exceed HARNESS_MAX; the user trims it to save.
 */
export function legacyParentHarness(saved = {}) {
  const policies = Array.isArray(saved.teamPolicies) ? saved.teamPolicies.filter((entry) => entry?.text?.trim()) : []
  const playbooks = Array.isArray(saved.teamPlaybooks) ? saved.teamPlaybooks.filter((entry) => entry?.body?.trim()) : []
  if (policies.length === 1 && !playbooks.length) return policies[0].text.trim()
  return [
    ...policies.map((entry) => `## ${entry.name}\n${entry.text.trim()}`),
    ...playbooks.map((entry) => `## ${entry.name}${entry.description?.trim() ? `（${entry.description.trim()}）` : ''}\n${entry.body.trim()}`),
  ].join('\n\n')
}
