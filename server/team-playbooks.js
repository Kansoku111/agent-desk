// The user's own words for team leaders (設定 → エージェントチーム): named
// policies, one of which a team starts with and its leader reads in full in
// its standing instructions, and playbooks, of which the leader's
// instructions list only the name and when to use them; it opens one with
// the `playbook` tool when the work calls for it. Children see neither.
import { randomUUID } from 'node:crypto'

export const POLICY_MAX = 2_000
export const PLAYBOOK_MAX = 20_000
export const DESCRIPTION_MAX = 200
export const NAME_MAX = 40
export const ENTRIES_MAX = 30

/** An entry's id: the client's, or one made here. */
export const ENTRY_ID = /^[A-Za-z0-9-]{1,64}$/

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

function text(value, max, label, required = false) {
  if (typeof value !== 'string') throw new Error(`${label}は文字列で指定してください`)
  const trimmed = value.trim()
  if (required && !trimmed) throw new Error(`${label}を入力してください`)
  if (trimmed.length > max) throw new Error(`${label}は ${max.toLocaleString()} 文字までです`)
  return trimmed
}

/** Entries with a unique name and an id each; throws on anything invalid. */
function entries(list, kind, fields) {
  if (!Array.isArray(list)) throw new Error(`${kind}は配列で指定してください`)
  if (list.length > ENTRIES_MAX) throw new Error(`${kind}は ${ENTRIES_MAX} 件までです`)
  const names = new Set()
  return list.map((entry) => {
    if (!isRecord(entry)) throw new Error(`${kind}の項目はオブジェクトで指定してください`)
    const name = text(entry.name ?? '', NAME_MAX, `${kind}の名前`, true)
    const key = name.toLowerCase()
    if (names.has(key)) throw new Error(`${kind}「${name}」が重複しています`)
    names.add(key)
    const id = typeof entry.id === 'string' && ENTRY_ID.test(entry.id) ? entry.id : randomUUID()
    return { id, name, ...Object.fromEntries(fields.map(([field, max, label]) => [field, text(entry[field] ?? '', max, `「${name}」の${label}`)])) }
  })
}

/** 方針: { id, name, text }[]. */
export const parsePolicies = (list) => entries(list, '方針', [['text', POLICY_MAX, '本文']])

/** プレイブック: { id, name, description, body }[]. */
export const parsePlaybooks = (list) => entries(list, 'プレイブック', [['description', DESCRIPTION_MAX, '説明'], ['body', PLAYBOOK_MAX, '本文']])

/** What a team's leader reads of them: its policy in full, the playbooks by name. */
export function leaderGuides({ policies = [], playbooks = [], policy = null }) {
  const chosen = policies.find((entry) => entry.id === policy && entry.text)
  return { policy: chosen?.text ?? '', playbooks: playbooks.map(({ name, description }) => ({ name, description })) }
}

/** The `playbook` tool's answer: the playbook in full, or which ones there are. */
export function readPlaybook(playbooks, ref) {
  const key = String(ref ?? '').trim().toLowerCase()
  const found = key && playbooks.find((entry) => entry.name.toLowerCase() === key)
  if (found) return `# Playbook: ${found.name}\n\n${found.body || '(empty)'}`
  const names = playbooks.map((entry) => `"${entry.name}"`).join(', ')
  return names ? `No playbook named "${ref ?? ''}". Playbooks: ${names}` : 'The user has no playbooks.'
}
