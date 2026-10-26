import { useState } from 'react'
import type { ToolMode } from '../types'

/** Shared workflow control; Claude Code sessions never receive this setting. */
export function PtcToggle({ mode = 'native', disabled = false, onChange }: {
  mode?: ToolMode; disabled?: boolean; onChange: (mode: ToolMode) => unknown
}) {
  const [changing, setChanging] = useState(false)
  return <button type="button" className={`chip ptc-chip ${mode === 'ptc' ? 'on' : ''}`} aria-label="PTC" aria-pressed={mode === 'ptc'}
    title="PTC（dshの担当に適用・次の実行から反映）" disabled={disabled || changing} onClick={async () => {
      setChanging(true)
      try { await onChange(mode === 'ptc' ? 'native' : 'ptc') } finally { setChanging(false) }
    }}>PTC {mode === 'ptc' ? 'ON' : 'OFF'}</button>
}
