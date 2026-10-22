import fs from 'node:fs/promises'
import path from 'node:path'
import { SIWC_LIMIT_TEXT } from './siwc-usage-error.js'

function validateMessageId(messageId) {
  if (messageId === undefined) return undefined
  if (typeof messageId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(messageId)) {
    throw new Error('messageId は UUID 文字列で指定してください')
  }
  return messageId.toLowerCase()
}

function normalizeMessage({ text = '', images = [], messageId } = {}) {
  if (typeof text !== 'string' || !Array.isArray(images)) throw new Error('メッセージの形式が不正です')
  if (!text.trim() && images.length === 0) throw new Error('メッセージが空です')
  return { text, images: structuredClone(images), messageId: validateMessageId(messageId) }
}

function receiptStatus(receipt) {
  if (!receipt) return { status: 'missing' }
  if (receipt.status !== 'accepted') return { status: 'uncertain' }
  return { status: 'accepted', turnId: receipt.turnId, kind: receipt.kind }
}

async function assertDirectory(dir) {
  if (typeof dir !== 'string' || !dir.trim()) throw new Error('ワークスペースを選択してください')
  let stat
  try {
    stat = await fs.stat(dir)
  } catch {
    throw new Error(`フォルダが見つかりません: ${dir}`)
  }
  if (!stat.isDirectory()) throw new Error(`フォルダではありません: ${dir}`)
}

/**
 * The earlier conversation, condensed for a session that cannot resume the old
 * one: each prompt with the agent's final answer, newest turns kept first.
 */
export function carryoverText(turns, budget = 24_000) {
  const parts = []
  let used = 0
  for (const turn of [...turns].reverse()) {
    // The reply is every message after the last tool call; earlier ones are narration.
    const lastTool = turn.items.findLastIndex((item) => item.type === 'tool')
    const answer = turn.items.slice(lastTool + 1).filter((item) => item.type === 'agent' && item.text).map((item) => item.text).join('\n\n')
    const tools = turn.items.filter((item) => item.type === 'tool').length
    const entry = [
      `User: ${clipText(turn.user?.text ?? '', 2000)}`,
      ...turn.items.filter((item) => item.type === 'steer' && item.text).map((item) => `User (while the assistant worked): ${clipText(item.text, 1000)}`),
      answer ? `Assistant: ${clipText(answer, 3000)}` : `Assistant: (${turn.status === 'done' ? 'no reply text' : turn.status})`,
      tools ? `(the assistant used ${tools} tool call${tools === 1 ? '' : 's'} in this turn)` : null,
    ].filter(Boolean).join('\n')
    if (used + entry.length > budget) break
    parts.unshift(entry)
    used += entry.length
  }
  if (!parts.length) return ''
  return [
    '[Context from Agent Desk] This conversation continues in a new session (the permission mode changed or the previous session could not be resumed).',
    'Earlier turns, oldest first. Files in the workspace already reflect any changes made during them:',
    '<previous_conversation>',
    parts.join('\n\n'),
    '</previous_conversation>',
    'Continue from here with the request below.',
  ].join('\n')
}

/** A restore can be undone while it is the latest one and no message followed it. */
export function isUndoable(turns, turn) {
  if (!turn.restore) return false
  const latest = Math.max(...turns.map((entry) => entry.restore?.at ?? 0))
  return turn.restore.at === latest && turns.length === turn.restore.turns
}

/** Tells the agent, with the next message, that the user undid file changes. */
export function restoreNoteText({ request, first }) {
  const which = first ? 'their first request' : `an earlier request of theirs ("${clipText(String(request).split('\n')[0], 200)}")`
  return [
    `[Context from Agent Desk] Since your last reply, the user restored the workspace files to how they were before ${which}.`,
    'Every file change made while handling that request and the ones after it has been undone; the conversation above is unchanged.',
    'Do not assume your earlier edits are still there: read files again before relying on them.',
  ].join('\n')
}

function sameFolder(a, b) {
  const left = path.resolve(a)
  const right = path.resolve(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function clipText(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function shortMessage(error) {
  const text = error instanceof Error ? error.message : String(error?.message ?? error)
  return text.split('\n')[0].slice(0, 200)
}

/** Turns runtime and provider failures into a message plus a raw detail. */
export function describeError(error, thread, runtime) {
  const raw = [error?.message, error?.data ? JSON.stringify(error.data) : null].filter(Boolean).join('\n')
  let provider = null
  try {
    provider = JSON.parse(thread.model)[0]
  } catch {}
  let message = shortMessage(error)
  const runtimeExited = /ACP connection closed|exited|TransportClosed/i.test(raw)
  if (runtimeExited) {
    message = 'エージェントの実行環境が予期せず終了しました。もう一度送信すると再起動します。'
  } else if (/MISSING_CREDENTIAL|missing credential|no api key/i.test(raw)) {
    message = provider === 'openai-codex'
      ? 'ChatGPT のサインイン情報が見つかりません。設定から再度サインインしてください。'
      : '必要な API キーが見つかりません。設定で API キーを登録してください。'
  } else if (/anthropic-workspace-id|Workspace `?wrkspc_/i.test(raw)) {
    message = 'この Claude API キーでは、使うワークスペースの指定が必要です。設定 → アカウントの Claude 欄でワークスペースを選んでください。'
  } else if (/\b401\b|unauthori[sz]ed|invalid.{0,20}(api.?key|token)|authentication/i.test(raw)) {
    message = provider === 'openai-codex'
      ? 'ChatGPT の認証に失敗しました。設定から再度サインインしてください。'
      : 'API キーの認証に失敗しました。設定でキーを確認してください。'
  } else if (/subscription_sharing_usage_limit_exceeded/i.test(raw)) {
    message = SIWC_LIMIT_TEXT
  } else if (/\b429\b|rate.?limit|usage limit|quota/i.test(raw)) {
    message = '利用上限に達しました。しばらく待つか、別のモデルを選んでください。'
  } else if (/WebSocket closed|An error occurred while processing your request/i.test(raw)) {
    // dsh retries these first (retry-hook.js); this is when every retry failed.
    message = 'モデルとの接続が途中で切れ、再試行しても戻りませんでした。「続けて」と送ると、ここまでの作業の続きから再開します。'
  }
  // The runtime's log helps only when the runtime itself went down.
  const stderr = runtime?.stderr && runtimeExited ? `\n\n${runtime.stderr.slice(-1500)}` : ''
  return { message, detail: `${raw}${stderr}`.slice(0, 4000) }
}

export { assertDirectory, normalizeMessage, receiptStatus, sameFolder, shortMessage, validateMessageId }
