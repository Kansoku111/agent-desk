import { useState, type ReactNode } from 'react'
import { ChevronRight, Loader2 } from 'lucide-react'
import { useStore } from '../store'
import { AbConfigFields, useAbConfig } from './Ab'
import { ExecutionModelFields, useExecutionModels } from './ExecutionSettings'

/** 設定 → エージェントチーム: one card per launch mode (TM / AB / eco), closed until opened. */
export function ModeSection({ mark, name, children }: { mark: string; name: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="account-card mode-section">
      <button type="button" className={`mode-section-head ${open ? 'open' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={14} />
        <span className="cl-mark tm-mark">{mark}</span>
        <h3>{name}</h3>
      </button>
      {open && <div className="mode-section-body">{children}</div>}
    </section>
  )
}

export function AbSettings() {
  const server = useStore((state) => state.server)
  const { config, change } = useAbConfig()
  if (!server || !config) return <Loader2 className="spin" size={20} />
  return <AbConfigFields server={server} config={config} change={change} />
}

export function ExecutionSettings() {
  const models = useExecutionModels()
  if (!models.server?.settings.agentTeams || !models.selection) return <Loader2 className="spin" size={20} />
  return <ExecutionModelFields models={models} />
}
