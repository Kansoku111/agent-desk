// The user's own words for one side of TM, eco and AB (設定 → エージェントチーム).
// Parent: a TM/eco leader, and AB's judgment, instruction, direct
// implementation and review stages. Child: TM/eco children, and AB's two
// consultants and delegated implementer. Neither reaches ordinary tasks.
// They replace the TM-only 方針 and プレイブック, which are no longer read.

import { HARNESS_MAX } from '../shared/text-limits.js'

export { HARNESS_MAX }
export const HARNESS_KEYS = { parent: 'teamParentHarness', child: 'teamChildHarness' }
const LABEL = { parent: '親ハーネス', child: '子ハーネス' }
const ROLE = {
  parent: 'parent agents (TM and eco leaders, and AB\'s judging leader in every stage)',
  child: 'child agents (TM and eco children, and AB\'s consultants and delegated implementer)',
}

/** A harness as saved; throws on anything invalid. */
export function parseHarness(value, side) {
  if (typeof value !== 'string') throw new Error(`${LABEL[side]}は文字列で指定してください`)
  if (value.length > HARNESS_MAX[side]) throw new Error(`${LABEL[side]}は ${HARNESS_MAX[side].toLocaleString()} 文字までです`)
  return value
}

/** The prompt section for one side; '' when the user wrote nothing. */
export function harnessSection(text, side) {
  const body = typeof text === 'string' ? text.trim() : ''
  if (!body) return ''
  const tag = `${side}_harness`
  return [
    `# The user's ${side} harness`,
    `The user wrote these standing instructions in Agent Desk for ${ROLE[side]}. Follow them in this role. Agent Desk's rules for this mode, this session's permissions and tools, and the user's requests in the conversation take precedence when they conflict.`,
    `<${tag}>\n${body}\n</${tag}>`,
  ].join('\n\n')
}

/** Joins prompt parts, skipping empty ones. */
export const joinPrompt = (...parts) => parts.filter(Boolean).join('\n\n')

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
