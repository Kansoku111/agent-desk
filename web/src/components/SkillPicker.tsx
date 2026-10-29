import { useEffect, useState } from 'react'
import { ChevronDown, Sparkles } from 'lucide-react'
import { request } from '../store'
import { requestErrorMessage } from '../rpc-client'
import { Dropdown, MenuItem } from './Popover'

interface Skill { name: string; description: string }

function SkillList({ workspace, threadId, onSelect }: { workspace: string; threadId?: string; onSelect: (name: string) => void }) {
  const [skills, setSkills] = useState<Skill[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    request<{ skills: Skill[] }>('skills.list', { workspace, threadId }).then((result) => {
      if (active) setSkills(result.skills)
    }).catch((reason) => { if (active) setError(requestErrorMessage(reason)) })
    return () => { active = false }
  }, [workspace, threadId])
  if (error) return <div className="menu-empty" role="alert">skills を取得できませんでした。{error}</div>
  if (!skills) return <div className="menu-empty">読み込み中…</div>
  if (!skills.length) return <div className="menu-empty">利用できる skills はありません</div>
  return <div className="menu-scroll">{skills.map((skill) => (
    <MenuItem key={skill.name} label={skill.name} description={skill.description.replace(/\s+/g, ' ').slice(0, 120)} onSelect={() => onSelect(skill.name)} />
  ))}</div>
}

export function SkillPicker({ workspace, threadId, onSelect }: { workspace: string; threadId?: string; onSelect: (name: string) => void }) {
  return (
    <Dropdown width={320} trigger={({ open, toggle }) => (
      <button type="button" className={`chip ${open ? 'active' : ''}`} onClick={toggle} aria-label="Skills" aria-expanded={open}>
        <Sparkles size={13} /><span>Skills</span><ChevronDown size={13} />
      </button>
    )}>
      {(close) => <SkillList key={`${threadId ?? ''}:${workspace}`} workspace={workspace} threadId={threadId} onSelect={(name) => { close(); onSelect(name) }} />}
    </Dropdown>
  )
}
