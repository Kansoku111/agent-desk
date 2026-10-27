// ECO review evidence is captured by the app, not supplied by the child.
// Reuse the isolated checkpoint repository: never stage or commit the user's repo.
import fs from 'node:fs/promises'
import path from 'node:path'
import { Checkpoints } from './checkpoints.js'
import { sourceSnapshot, verificationReport } from './execution.js'
import { clip } from './teams-prompts.js'

export class ExecutionReview {
  constructor({ dir }) {
    this.checkpoints = new Checkpoints({ root: path.join(dir, 'snapshots') })
  }

  async start(folder, id) {
    try {
      return await this.checkpoints.snapshot(folder, `${id}/before`)
    } catch (error) {
      // Missing Git or an unreadable folder must not masquerade as an empty diff.
      return { error: error.message }
    }
  }

  async report({ folder, execution, run, childReport }) {
    const record = path.join(path.dirname(run.record), 'review.md')
    const patchFile = path.join(path.dirname(run.record), 'changes.patch')
    const warnings = []
    const baseline = execution.baseline
    let files = []
    let patch = ''
    let captured = false
    try {
      if (!baseline?.commit) throw new Error(baseline?.error || '作業開始前の記録がありません（旧バージョンで開始した作業など）。')
      const after = await this.checkpoints.snapshot(folder, `${run.ownerId}/${run.id}/after`)
      const omitted = [...new Set([...(baseline.omitted ?? []), ...(after.omitted ?? [])])]
      if (baseline.warning) warnings.push(baseline.warning)
      if (after.warning) warnings.push(after.warning)
      if (omitted.length) warnings.push(`${this.checkpoints.maxFileBytes / 1024 / 1024}MiB超のため差分対象外: ${omitted.map((file) => JSON.stringify(file)).join(', ')}`)
      const diff = await this.checkpoints.reviewDiff(folder, baseline.commit, after.commit, omitted)
      files = diff.files
      patch = diff.patch
      await fs.writeFile(patchFile, patch, 'utf8')
      captured = true
      // The diff is captured after commands finish; do not pair it with older results.
      if (run.endHash) {
        try {
          if ((await sourceSnapshot(folder)).hash !== run.endHash) {
            run.status = 'stale'
            warnings.push('検証後、差分の取得中にソースが変更されました。verify で再検証してください。')
          }
        } catch (error) {
          const message = `検証後のソース確認に失敗しました: ${error.message}`
          if (['passed', 'unverified'].includes(run.status)) { run.status = 'error'; run.error = message }
          else warnings.push(message)
        }
      }
    } catch (error) {
      warnings.push(`差分取得失敗: ${error.message}`)
    }
    const task = execution.task ?? '（依頼文の記録なし。元の依頼を確認してください）'
    const instructions = (execution.instructions ?? []).join('\n\n')
    const changes = captured ? files.length ? files.map((file) => `${file.status} ${JSON.stringify(file.path)}`).join('\n') : '変更なし' : '不明（変更なしを意味しません）'
    const warning = warnings.join('\n')
    const scope = '差分は作業開始前からの変更です。作業前の未コミット変更を除き、子・親・検証コマンド・外部編集の変更元は区別しません。Git除外・依存物などチェックポイント対象外のファイルは含みません。バイナリは内容を別途確認してください。'
    const judgment = '親の判定: 依頼・完了条件と実際の変更を照合してください。バグ修正は原因と修正、UIは画面と操作、テスト変更は検査を弱めていないかを確認。close の reason に、確認した箇所・結果と合格の根拠を短く残してください。テスト成功だけを合格理由にしないでください。'
    const full = [
      '# eco レビュー資料', `依頼:\n${task}`, `完了条件:\n${execution.criteria}`,
      ...(instructions ? [`追加指示:\n${instructions}`] : []),
      `変更一覧:\n${changes}`, captured ? `差分全文: ${patchFile}` : '差分全文: 取得できませんでした',
      ...(warning ? [`注意:\n${warning}`] : []), scope,
      verificationReport(run), `子の報告:\n${childReport}`, judgment,
    ].join('\n\n')
    await fs.writeFile(record, full, 'utf8')
    const text = [
      '[eco レビュー資料]', `資料全文: ${record}`, captured ? `差分全文: ${patchFile}` : '差分全文: 取得できませんでした',
      ...(warning ? [`注意:\n${clip(warning, 2000)}`] : []),
      `依頼:\n${clip(task, 4000)}`, `完了条件:\n${clip(execution.criteria, 2000)}`,
      ...(instructions ? [`追加指示:\n${clip(instructions, 2000)}`] : []),
      `変更一覧 (${captured ? files.length : '不明'}件):\n${clip(changes, 4000)}`,
      scope, clip(verificationReport(run), 6000),
      ...(patch ? [`差分抜粋（長い場合は差分全文を開いてください）:\n${clip(patch, 8000)}`] : []),
      `子の報告:\n${clip(childReport, 4000)}`, judgment,
    ].join('\n\n')
    return { text, record, patch: captured ? patchFile : null, warning: warning || null }
  }
}
