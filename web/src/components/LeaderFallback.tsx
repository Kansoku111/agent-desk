import type { AppState } from '../types'
import { workflowEffort, workflowLevels, workflowOptions } from '../../../shared/workflow-effort.js'
import { ModelField, modelGroups } from './WorkflowModelField'

export function LeaderFallback({ server, value, effort, disabled, onChange }: {
  server: AppState; value: string; effort: string; disabled: boolean; onChange: (value: string, effort: string) => void
}) {
  const groups = modelGroups(server)
  return <details className="model-sync-details">
    <summary>利用上限時のフォールバック{value ? '（設定済み）' : ''}</summary>
    <div className="claude-auth-consent-body">
      <ModelField label="リーダーの切り替え先" value={value} groups={groups} disabled={disabled}
        effort={effort} efforts={workflowOptions(effort, workflowLevels(server.catalog, value))} allowClearUnavailableEffort
        onEffort={(next) => onChange(value, next)}
        onChange={(next) => onChange(next, workflowEffort(effort, workflowLevels(server.catalog, next), true))} />
      {value && <button type="button" className="link-button" disabled={disabled} onClick={() => onChange('', '')}>設定を解除</button>}
      <p className="muted">利用上限時に切り替えます。Claude（API）・DeepSeekは従量課金です。</p>
    </div>
  </details>
}
