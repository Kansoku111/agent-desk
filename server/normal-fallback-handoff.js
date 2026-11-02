import { isImageFile } from './attachments.js'
import { carryoverText } from './thread-utils.js'

// A transcript cannot prove a goal is inactive; err on the side of not moving it.
export function hasGoalHistory(turns) {
  return turns.some((turn) => /^\s*\/goal(?:\s|$)/i.test(turn.user?.text ?? '') || (turn.items ?? []).some((item) => {
    if (item.type !== 'tool') return false
    if (/(?:^|[._/])create_goal$/i.test(item.name ?? '')) return true
    const code = typeof item.input?.code === 'string' ? item.input.code : ''
    return /(?:tools\.|tools\[\s*['"])create_goal/i.test(code)
  }))
}

/**
 * Create a hidden idle target, durably link the source, then deliver once. Once a
 * commit has been attempted, never delete or replay the target: its persistence
 * or delivery may have succeeded despite an error. The caller supplies the
 * source fence and owns the persisted source record.
 */
export async function handoffThreadToClaude({ thread, turn, turns, choice, terminals, guard, commit }) {
  if (thread.permissionMode !== 'danger-full-access') throw new Error('Claude Codeへは元のサンドボックス権限を引き継げないため、自動切り替えできません')
  if (turn.user?.plan || hasGoalHistory([...turns, turn])) throw new Error('Planまたはゴールの実行状態をClaude Codeへ引き継げません')
  if (turns.some((entry) => entry.user?.images?.some((image) => isImageFile(image.file)))) throw new Error('画像を含む会話をClaude Codeへ自動で引き継げません')
  const history = carryoverText(turns).replace('the permission mode changed or the previous session could not be resumed', 'the model and runtime changed after a usage limit')
  if (!history) throw new Error('会話を引き継げないため切り替えを中止しました')
  guard()
  let target, commitAttempted = false
  try {
    target = await terminals.create({ workspace: thread.workspace, model: choice.model.slice(7), effort: choice.effort || null,
      title: thread.title + '（切り替え後）', usageFallbackFrom: { kind: 'thread', id: thread.id, turnId: turn.id }, requireDurable: true, usageFallbackPending: true })
    guard()
    commitAttempted = true
    await commit(target.id)
    guard()
    const prompt = history + '\n\n' + '[Agent Desk 利用上限フォールバック] モデルが切り替わりました。上記は会話の抜粋です。途中の依頼を続けてください。変更済みファイルを確認し、実行済みまたは完了が不明な外部操作を繰り返さないでください。'
    await terminals.deliverUsageFallback(target.id, prompt, guard)
    await terminals.revealUsageFallback(target.id)
    return target
  } catch (error) {
    if (target && !commitAttempted) await terminals.discardUsageFallback(target.id).catch(() => {})
    else if (target) {
      try { terminals.stopUsageFallback(target.id) } catch {}
      await terminals.revealUsageFallback(target.id).catch(() => {})
    }
    throw error
  }
}

/** Claude Code has no equivalent guaranteed ACP sandbox or permission mode.
 * The replacement is read-only until the user explicitly changes its permissions. */
export async function handoffClaudeToThread({ terminal, turns, choice, threads, guard, commit }) {
  const last = turns.at(-1)
  if (!last?.user?.text || hasGoalHistory(turns)) throw new Error('直前の依頼またはゴールの状態を引き継げません')
  if (turns.some((turn) => turn.user?.text?.includes('[画像]') || turn.user?.images?.length)) throw new Error('画像を含むClaude Codeの会話を自動で引き継げません')
  const history = carryoverText(turns).replace('the permission mode changed or the previous session could not be resumed', 'the model and runtime changed after a usage limit')
  if (!history) throw new Error('会話を引き継げないため切り替えを中止しました')
  guard()
  await threads.checkUsageFallbackModel(choice.model)
  guard()
  let target, commitAttempted = false
  try {
    target = await threads.create({ workspace: terminal.workspace, model: choice.model, effort: choice.effort,
      permissionMode: 'read-only', toolMode: 'native', usageFallbackFrom: { kind: 'terminal', id: terminal.id }, usageFallbackPending: true })
    guard()
    commitAttempted = true
    await commit(target.id)
    guard()
    const text = history + '\n\n' + '[Agent Desk 利用上限フォールバック] Claude Codeから切り替わりました。会話は抜粋です。安全のため読み取り専用で続けます。変更済みファイルを確認し、実行済みまたは完了が不明な外部操作を繰り返さないでください。書き込みが必要な場合は利用者に確認してください。'
    await threads.deliverUsageFallback(target.id, { text }, { sourceTerminalId: terminal.id, model: choice.model, effort: choice.effort }, guard)
    await threads.revealUsageFallback(target.id)
    return target
  } catch (error) {
    if (target && !commitAttempted) await threads.discardUsageFallback(target.id).catch(() => {})
    else if (target) {
      await threads.stopUsageFallback(target.id).catch(() => {})
      await threads.revealUsageFallback(target.id).catch(() => {})
    }
    throw error
  }
}
