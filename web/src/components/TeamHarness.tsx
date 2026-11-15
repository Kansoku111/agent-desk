import { useState } from 'react'
import { HARNESS_MAX } from '../../../shared/text-limits.js'
import { request, toast, useStore } from '../store'
import type { Settings } from '../types'
import { TextSettingCard } from './settings/TextSettingCard'

const READERS = {
  tm: { parent: 'TM のリーダー', child: 'TM の子' },
  eco: { parent: 'eco の親', child: 'eco の子' },
  ab: { parent: 'AB の判断リーダー（判断・実装指示・直接実装・レビュー）', child: 'AB の相談A・B と実装担当' },
}

type Mode = 'tm' | 'eco' | 'ab'

/** Turns one harness off without deleting its text (server/team-harness.js effectiveHarness). */
function HarnessSwitch({ setting, label }: { setting: `${Mode}${'Parent' | 'Child'}HarnessEnabled` & keyof Settings; label: string }) {
  const enabled = useStore((state) => state.server?.settings[setting] !== false)
  const [toggling, setToggling] = useState(false)
  const toggle = async (next: boolean) => {
    setToggling(true)
    try {
      await request('settings.update', { patch: { [setting]: next } })
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error')
    }
    setToggling(false)
  }
  return (
    <label className="switch">
      <input type="checkbox" role="switch" aria-label={label} checked={enabled} disabled={toggling} onChange={(event) => void toggle(event.target.checked)} />
      <span />
    </label>
  )
}

/** One mode's parent and child harnesses, read only by that mode (server/team-harness.js). */
export function TeamHarness({ mode }: { mode: Mode }) {
  return (
    <>
      <TextSettingCard setting={`${mode}ParentHarness`} title="親ハーネス" max={HARNESS_MAX.parent} rows={5}
        head={<HarnessSwitch setting={`${mode}ParentHarnessEnabled`} label="親ハーネス" />}
        placeholder={`${READERS[mode].parent}だけが読みます。\n例:\n- 子への依頼には受け入れ条件を必ず書く\n- 回答は結論から短く`} />
      <TextSettingCard setting={`${mode}ChildHarness`} title="子ハーネス" max={HARNESS_MAX.child} rows={4}
        head={<HarnessSwitch setting={`${mode}ChildHarnessEnabled`} label="子ハーネス" />}
        placeholder={`${READERS[mode].child}だけが読みます。子の人数分、毎ターン読まれるので短く。\n例:\n- 報告は 5 行以内\n- 変更前に関連テストを読む`} />
    </>
  )
}
