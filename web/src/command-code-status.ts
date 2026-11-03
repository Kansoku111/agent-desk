import type { CommandCodeSync } from './types'

/** A list check never proves that the saved key or subscription is valid. */
export function commandCodeStatus(configured: boolean, autoSync: boolean, sync: CommandCodeSync | null | undefined) {
  if (!configured) return { kind: 'unconfigured', label: 'API キー未設定' } as const
  if (sync?.checking) return { kind: 'checking', label: '確認中…' } as const
  if (sync?.error) return { kind: 'error', label: '一覧の取得に失敗' } as const
  if (sync?.applyError) return { kind: 'apply-error', label: '一覧の反映に失敗' } as const
  if (!sync?.checkedAt) return { kind: 'unverified', label: '未確認' } as const
  if (!sync.applied) return { kind: 'pending', label: '一覧の反映待ち' } as const
  if (sync.skipped) return { kind: 'partial', label: `未対応 ${sync.skipped}件` } as const
  if (!autoSync) return { kind: 'manual', label: '自動同期オフ' } as const
  return { kind: 'ready', label: '一覧を同期済み' } as const
}

export function commandCodeEmptyHint(configured: boolean, autoSync: boolean, sync: CommandCodeSync | null | undefined) {
  const status = commandCodeStatus(configured, autoSync, sync)
  if (status.kind === 'unconfigured') return '設定 → アカウントで API キーを登録'
  if (status.kind === 'checking') return '一覧を確認中…'
  if (status.kind === 'pending') return '一覧の反映待ち（作業中は終了後に反映）'
  if (status.kind === 'error' || status.kind === 'apply-error') return status.label + '（設定 → 情報で確認）'
  if (status.kind === 'unverified') return '設定 → アカウントでモデル一覧を更新'
  return '設定 → モデルで表示を確認'
}
