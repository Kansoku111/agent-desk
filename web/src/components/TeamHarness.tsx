import { HARNESS_MAX } from '../../../shared/text-limits.js'
import { TextSettingCard } from './settings/TextSettingCard'

/** 設定 → エージェントチーム: what only the parents, or only the children, of TM, eco and AB read (server/team-harness.js). */
export function TeamHarness() {
  return (
    <>
      <TextSettingCard setting="teamParentHarness" title="親ハーネス" max={HARNESS_MAX.parent} rows={6}
        placeholder={'TM・eco のリーダー、AB の判断リーダーだけが読みます。\n例:\n- 設計とレビューは Claude の中枠、量の多い作業は GPT の低枠\n- 子への依頼には受け入れ条件を必ず書く'} />
      <TextSettingCard setting="teamChildHarness" title="子ハーネス" max={HARNESS_MAX.child} rows={4}
        placeholder={'TM・eco の子、AB の相談役と実装担当だけが読みます。子の人数分、毎ターン読まれるので短く。\n例:\n- 報告は 5 行以内\n- 変更前に関連テストを読む'} />
    </>
  )
}
