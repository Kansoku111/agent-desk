import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { MAX_FILE_BYTES } from './checkpoints.js'
const exec = promisify(execFile)
const git = (workspace, args) => exec('git', args, { cwd: workspace, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 30_000 })

// Read the real repository only. Never stage, reset, or commit its index/HEAD.
export async function gitPresetReview(workspace, ref) {
  if (typeof ref !== 'string' || !ref.trim() || ref.length > 200 || ref.startsWith('-') || /[\r\n\0]/.test(ref)) throw new Error('レビューの基準コミットを指定してください')
  const { stdout } = await git(workspace, ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}'])
  const sha = stdout.trim()
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error('基準コミットを確認できません')
  const names = (await git(workspace, ['diff', '--name-only', '--relative', '-z', '--no-renames', sha, '--', '.'])).stdout.split('\0').filter(Boolean)
  const untracked = (await git(workspace, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.'])).stdout.split('\0').filter(Boolean)
  const files = [...new Set([...names, ...untracked])]
  const omitted = []
  for (const name of files) {
    try { if ((await fs.lstat(path.join(workspace, name))).size > MAX_FILE_BYTES) omitted.push(name) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const scope = ['--', '.', ...omitted.map((name) => ':(exclude,literal)' + name)]
  let patch = (await git(workspace, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--relative', '--no-renames', sha, ...scope])).stdout
  for (const name of untracked.filter((name) => !omitted.includes(name))) {
    let result
    try { result = await git(workspace, ['diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', name]) }
    catch (error) { if (error.code !== 1 || typeof error.stdout !== 'string') throw error; result = error }
    patch += result.stdout
    if (patch.length > 24_000_000) throw new Error('レビュー差分が大きすぎます。対象を絞ってください')
  }
  return { files: files.map((name) => ({ path: name })), patch, warning: omitted.length ? '50MiB超のため差分対象外: ' + omitted.join(', ') : null, sha }
}

export async function presetFileScope(workspace, files) {
  if (!Array.isArray(files) || !files.length || files.length > 50) throw new Error('レビュー対象ファイルを1〜50件指定してください')
  const scoped = [...new Set(files.map((file) => {
    if (typeof file !== 'string' || !file.trim() || file.length > 1000 || path.isAbsolute(file)) throw new Error('対象ファイルはプロジェクト内の相対パスで指定してください')
    const relative = path.relative(workspace, path.resolve(workspace, file))
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep)) throw new Error('対象ファイルがプロジェクト外です')
    return relative
  }))]
  const root = await fs.realpath(workspace)
  for (const file of scoped) {
    const target = await fs.realpath(path.join(workspace, file))
    const relative = path.relative(root, target)
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('対象ファイルがプロジェクト外を参照しています')
    if (!(await fs.stat(target)).isFile()) throw new Error('対象はファイルで指定してください')
  }
  return scoped
}
