import { useState } from 'react'
import { request, useStore } from '../../store'
import { INSTRUCTIONS_MAX } from '../../../../shared/text-limits.js'
import { TextSettingCard } from './TextSettingCard'

/** Standing instructions the agent reads before every task. */
export function PersonalizeSettings() {
  const enabled = useStore((state) => state.server?.settings.customInstructionsEnabled !== false)
  const [toggling, setToggling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = async (enabled: boolean) => {
    setToggling(true)
    setError(null)
    try {
      await request('settings.update', { patch: { customInstructionsEnabled: enabled } })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
    setToggling(false)
  }

  return (
    <div className="settings-section">
      <TextSettingCard setting="customInstructions" title="カスタム指示" label="指示" max={INSTRUCTIONS_MAX} rows={10}
        description="すべてのタスクとサブエージェントが作業前に読みます。"
        placeholder={'例:\n- 回答は日本語で、結論から簡潔に書いてください。\n- コードのコメントは英語で書いてください。\n- 変更したらテストを実行して結果を報告してください。'}
        head={(
          <label className="switch">
            <input type="checkbox" role="switch" aria-label="カスタム指示" checked={enabled} disabled={toggling} onChange={(event) => void toggle(event.target.checked)} />
            <span />
          </label>
        )}>
        {error && <p className="form-error">{error}</p>}
        <p className="fine-print">dsh は待機後、Claude Code は再起動後に反映。会話での依頼が優先です。</p>
      </TextSettingCard>
    </div>
  )
}
