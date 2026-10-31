import { useEffect, useState } from 'react'
import { FolderOpen, Languages, Loader2 } from 'lucide-react'
import { request, toast, useStore } from '../../store'
import { requestErrorMessage } from '../../rpc-client'
import { workspaceLabel } from '../../util'
import { openRef } from '../FileRef'

interface SkillEntry {
  name: string
  description: string
  /** Cached Japanese translation of the description. */
  descriptionJa?: string
  /** Not Japanese and not translated yet. */
  translatable?: boolean
  scope: 'project' | 'user' | 'bundled'
  root: string
  file: string
  /** False when a same-named skill with a higher precedence wins. */
  active: boolean
  userInvocable: boolean
  modelInvocable: boolean
}

const SCOPES: { id: SkillEntry['scope']; label: string }[] = [
  { id: 'project', label: 'プロジェクト' },
  { id: 'user', label: 'ユーザー' },
  { id: 'bundled', label: '組み込み' },
]

/** Settings → Skills: what the agent can load in a project, and which skill wins a name clash. */
export function SkillsSettings() {
  const myPc = useStore((state) => state.server?.app.myPc)
  const names = useStore((state) => state.server?.settings.projectNames)
  const known = useStore((state) => state.server?.settings.workspaces ?? [])
  const initial = useStore((state) => state.draft.workspace ?? state.server?.settings.lastWorkspace ?? myPc ?? null)
  const [workspace, setWorkspace] = useState(initial)
  const [skills, setSkills] = useState<SkillEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [translating, setTranslating] = useState(false)
  const workspaces = workspace && !known.includes(workspace) ? [workspace, ...known] : known

  useEffect(() => {
    if (!workspace) return
    let active = true
    setSkills(null)
    setError(null)
    load(workspace).then((result) => {
      if (active) setSkills(result.skills)
    }).catch((reason) => { if (active) setError(requestErrorMessage(reason)) })
    return () => { active = false }
  }, [workspace])

  const load = (target: string) => request<{ skills: SkillEntry[] }>('skills.overview', { workspace: target })

  const translate = async () => {
    if (!workspace) return
    setTranslating(true)
    try {
      await request('skills.translate', { workspace })
      setSkills((await load(workspace)).skills)
    } catch (reason) {
      toast(requestErrorMessage(reason), 'error')
    }
    setTranslating(false)
  }

  const reveal = (skill: SkillEntry) => {
    openRef(skill.file, null, 'reveal').catch((reason) => toast(requestErrorMessage(reason), 'error'))
  }

  return (
    <div className="settings-section skills-settings">
      <div className="skills-bar">
        {workspaces.length > 0 && (
          <select value={workspace ?? ''} onChange={(event) => setWorkspace(event.target.value)} aria-label="プロジェクト">
            {workspaces.map((entry) => <option key={entry} value={entry}>{workspaceLabel(entry, myPc, names)}</option>)}
          </select>
        )}
        {skills?.some((skill) => skill.translatable) && (
          <button type="button" className="button" disabled={translating} onClick={() => void translate()} title="説明を日本語にします（Claude Haiku を使います）">
            {translating ? <Loader2 size={14} className="spin" /> : <Languages size={14} />} 日本語にする
          </button>
        )}
      </div>
      {error && <p className="notice notice-warning" role="alert">{error}</p>}
      {!error && !skills && workspace && <p className="skill-empty">読み込み中…</p>}
      {skills && !skills.length && <p className="skill-empty">skills はありません</p>}
      {skills && SCOPES.map(({ id, label }) => {
        const rows = skills.filter((skill) => skill.scope === id)
        if (!rows.length) return null
        return (
          <section key={id} className="skill-group">
            <h3>{label}</h3>
            {rows.map((skill) => (
              <div key={skill.file} className={`skill-row ${skill.active ? '' : 'shadowed'}`}>
                <div className="skill-main">
                  <div className="skill-title">
                    <strong>{skill.name}</strong>
                    <code>{skill.root}</code>
                    {!skill.active && <span className="badge danger">上書きされています</span>}
                    {!skill.userInvocable && <span className="badge">自動のみ</span>}
                    {!skill.modelInvocable && <span className="badge">手動のみ</span>}
                  </div>
                  <p>{skill.descriptionJa ?? skill.description}</p>
                </div>
                <button type="button" className="icon-button small" onClick={() => reveal(skill)} title="場所を表示" aria-label={`${skill.name} の場所を表示`}>
                  <FolderOpen size={14} />
                </button>
              </div>
            ))}
          </section>
        )
      })}
    </div>
  )
}
