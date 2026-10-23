// Lightweight API-key checks so the settings screen can tell a typo from a
// working key before the first agent turn fails.

async function probe(url, headers, timeoutMs = 8000) {
  try {
    const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
    if (response.ok) return { status: 'valid', response }
    let message = ''
    try {
      message = (await response.json())?.error?.message ?? ''
    } catch {}
    if (response.status === 401 || response.status === 403) return { status: 'invalid', httpStatus: response.status, message }
    return { status: 'unknown', httpStatus: response.status, message }
  } catch (error) {
    return { status: 'unreachable', message: error instanceof Error ? error.message : String(error) }
  }
}

const ANTHROPIC_API = 'https://api.anthropic.com'

function anthropicHeaders(key, workspaceId) {
  return {
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    ...(workspaceId ? { 'anthropic-workspace-id': workspaceId } : {}),
  }
}

/**
 * Rejects strings that are clearly not a Claude API key before any request.
 * The Console lists each key by an `apikey_…` id; only the `sk-ant-api…`
 * secret shown once at creation authenticates.
 */
export function anthropicKeyProblem(key) {
  if (/^apikey_/i.test(key)) {
    return 'これは API キーの ID（apikey_…）で、キー本体ではありません。Claude Console でキーを作成したときに一度だけ表示される「sk-ant-api…」で始まる文字列を貼り付けてください。表示を閉じてしまった場合は、新しいキーを作成してください。'
  }
  if (/^wrkspc_/i.test(key)) return 'これはワークスペース ID です。API キー（sk-ant-api…）を貼り付けてください。'
  if (/^sk-ant-oat/i.test(key)) return 'これは Claude のサブスクリプション用の OAuth トークンです。Claude Console で発行した API キー（sk-ant-api…）を使ってください。'
  if (/^sk-ant-admin/i.test(key)) return 'これは Admin API キーで、モデルの呼び出しには使えません。通常の API キー（sk-ant-api…）を使ってください。'
  if (/\s/.test(key)) return 'キーに空白や改行が含まれています。キーだけを貼り付けてください。'
  return null
}

/**
 * Checks a Claude API key. Identity-linked keys (personal and service account
 * keys) that are not scoped to one workspace need an `anthropic-workspace-id`
 * on every request; that answer comes back as `needs-workspace`.
 */
export async function checkAnthropicKey(key, workspaceId = null) {
  const result = await probe(`${ANTHROPIC_API}/v1/models?limit=1`, anthropicHeaders(key, workspaceId))
  delete result.response
  if (result.status === 'unknown' && /anthropic-workspace-id|scoped to a workspace/i.test(result.message ?? '')) {
    return workspaceId
      ? { ...result, status: 'workspace-invalid' }
      : { ...result, status: 'needs-workspace', workspaces: await listAnthropicWorkspaces(key) }
  }
  if (result.status === 'unknown' && result.httpStatus === 404 && workspaceId && /workspace/i.test(result.message ?? '')) {
    return { ...result, status: 'workspace-invalid' }
  }
  return result
}

/**
 * Workspaces an unscoped identity-linked key can see, for the picker. The
 * Admin API accepts such keys; when the key's role cannot list workspaces the
 * user types the id instead, so failures resolve to null.
 */
export async function listAnthropicWorkspaces(key) {
  const result = await probe(
    `${ANTHROPIC_API}/v1/organizations/workspaces?include_default=true&limit=100`,
    anthropicHeaders(key, null),
  )
  if (result.status !== 'valid') return null
  try {
    const body = await result.response.json()
    return (body?.data ?? [])
      .filter((entry) => entry && typeof entry.id === 'string' && !entry.archived_at)
      .map((entry) => ({ id: entry.id, name: typeof entry.name === 'string' ? entry.name : entry.id }))
  } catch {
    return null
  }
}

export async function checkDeepSeekKey(key) {
  const result = await probe('https://api.deepseek.com/models', { authorization: `Bearer ${key}` })
  delete result.response
  return result
}
