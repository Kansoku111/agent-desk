// Checkpoints: snapshots of a task's workspace, taken before and after each
// turn, so the files can be put back the way they were before a request.
// Snapshots live in a separate git repository per workspace inside the app
// data folder. The workspace (and any git repository of its own) is only read,
// except by a restore, which rewrites exactly the files that differ.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

// Larger files are left out of snapshots, so a restore never touches them.
export const MAX_FILE_BYTES = 50 * 1024 * 1024
const SNAPSHOT_TIMEOUT_MS = 45_000
// A workspace too large to snapshot is skipped for a while instead of delaying every turn.
const SKIP_MS = 7 * 24 * 60 * 60 * 1000
// Nested repositories and symlinks are never deleted or rewritten by a restore.
const UNTOUCHED_MODES = new Set(['160000', '120000'])

const EXCLUDES = [
  '# Agent Desk: dependencies, caches and OS files are never snapshotted.',
  'node_modules/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.mypy_cache/',
  '.pytest_cache/',
  '.next/',
  '.nuxt/',
  '.turbo/',
  '.parcel-cache/',
  '.gradle/',
  'Thumbs.db',
  'desktop.ini',
  '.DS_Store',
  // Office lock files.
  '~$*',
  '',
].join('\n')

// Bytes are stored and restored exactly: no line-ending conversion or filters
// from the workspace's own .gitattributes.
const ATTRIBUTES = '* -text -eol -filter -ident -working-tree-encoding\n'

export class Checkpoints {
  /** @param {{ root: string }} options  root: the folder that holds one repository per workspace */
  constructor({ root, maxFileBytes = MAX_FILE_BYTES }) {
    this.root = root
    this.maxFileBytes = maxFileBytes
    this.repos = new Map()
  }

  /**
   * Records the workspace as it is now.
   * @param {string} workspace
   * @param {string | null} ref  name that keeps the snapshot (e.g. `<thread>/<turn>/before`)
   * @returns {Promise<{ commit: string, warning: string | null }>}
   */
  async snapshot(workspace, ref = null) {
    const repo = await this.#repo(workspace)
    return this.#exclusive(repo, () => this.#snapshot(repo, ref))
  }

  /** Files that differ between two snapshots, as `{ path, status }` (status A, M, D or T). */
  async changes(workspace, from, to) {
    const repo = await this.#repo(workspace)
    return this.#exclusive(repo, () => this.#diff(repo, from, to))
  }

  /**
   * What a restore to `target` would do right now.
   * @returns {Promise<{ path: string, action: 'restore' | 'recreate' | 'delete' }[]>}
   */
  async preview(workspace, target) {
    const repo = await this.#repo(workspace)
    return this.#exclusive(repo, async () => {
      const { commit } = await this.#snapshot(repo, null)
      const entries = await withoutLargeCurrentFiles(repo, await this.#diff(repo, target, commit))
      return entries.map(({ path: file, status }) => ({ path: file, action: actionOf(status) }))
    })
  }

  /**
   * Puts the workspace back to `target`: files changed or deleted since then are
   * rewritten, files created since then are deleted. Ignored and large files,
   * nested repositories and symlinks stay as they are.
   * @param {string} undoRef  name that keeps the state before the restore, to undo it
   * @returns {Promise<{ undo: string, restored: string[], removed: string[], error: string | null }>}
   */
  async restore(workspace, target, undoRef = null) {
    const repo = await this.#repo(workspace)
    return this.#exclusive(repo, async () => {
      const { commit: undo } = await this.#snapshot(repo, undoRef)
      const entries = await withoutLargeCurrentFiles(repo, await this.#diff(repo, target, undo))
      const restored = entries.filter((entry) => entry.status !== 'A').map((entry) => entry.path)
      const removed = entries.filter((entry) => entry.status === 'A').map((entry) => entry.path)
      const problems = []
      if (restored.length) {
        try {
          await git(repo, ['checkout', target, '--pathspec-from-file=-', '--pathspec-file-nul'], {
            input: nulJoin(restored),
            literal: true,
          })
        } catch (error) {
          problems.push(firstLines(error.stderr || error.message))
        }
      }
      const dirs = new Set()
      for (const file of removed) {
        const full = inside(repo.workspace, file)
        if (!full) continue
        try {
          await fs.rm(full, { force: true })
          dirs.add(path.dirname(full))
        } catch (error) {
          problems.push(`${file}: ${error.code ?? error.message}`)
        }
      }
      await removeEmptyDirs(repo.workspace, dirs)
      return { undo, restored, removed, error: problems.length ? problems.join('\n').slice(0, 2000) : null }
    })
  }

  /** Drops the snapshots kept for a task (e.g. when it is deleted) and frees their space. */
  async forget(workspace, prefix) {
    const repo = await this.#repo(workspace)
    return this.#exclusive(repo, async () => {
      const refs = (await git(repo, ['for-each-ref', '--format=%(refname)', `refs/agent-desk/${prefix}/`])).split('\n').filter(Boolean)
      if (!refs.length) return
      await git(repo, ['update-ref', '--stdin'], { input: refs.map((ref) => `delete ${ref}\n`).join('') })
      // Every snapshot still needed has a ref, and nothing else writes to this repository meanwhile.
      await git(repo, ['gc', '--quiet', '--prune=now'], { timeout: 10 * 60_000 })
    })
  }

  /** Packs loose snapshot objects once there are many (cheap when there is nothing to do). */
  async tidy(workspace) {
    const repo = await this.#repo(workspace)
    return this.#exclusive(repo, () => git(repo, ['gc', '--auto', '--quiet'], { timeout: 10 * 60_000 }))
  }

  // ---------------------------------------------------------------- internals

  async #repo(workspace) {
    const resolved = path.resolve(workspace)
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
    const id = createHash('sha256').update(key).digest('hex').slice(0, 16)
    let repo = this.repos.get(id)
    if (!repo) {
      repo = {
        workspace: resolved,
        maxFileBytes: this.maxFileBytes,
        gitDir: path.join(this.root, id),
        emptyConfig: path.join(this.root, 'empty.gitconfig'),
        queue: Promise.resolve(),
        ready: null,
      }
      this.repos.set(id, repo)
    }
    repo.ready ??= this.#init(repo).catch((error) => {
      repo.ready = null
      throw error
    })
    await repo.ready
    return repo
  }

  async #init(repo) {
    await fs.mkdir(this.root, { recursive: true })
    await fs.writeFile(repo.emptyConfig, '', { flag: 'a' })
    try {
      await fs.access(path.join(repo.gitDir, 'HEAD'))
    } catch {
      await git(repo, ['init', '--quiet'])
    }
    const config = [
      ['core.autocrlf', 'false'],
      ['core.untrackedCache', 'true'],
      ['gc.autoDetach', 'false'],
    ]
    if (process.platform === 'win32') config.push(['core.longpaths', 'true'], ['core.ignorecase', 'true'])
    for (const [name, value] of config) await git(repo, ['config', name, value])
    await fs.mkdir(path.join(repo.gitDir, 'info'), { recursive: true })
    await fs.writeFile(path.join(repo.gitDir, 'info', 'exclude'), EXCLUDES)
    await fs.writeFile(path.join(repo.gitDir, 'info', 'attributes'), ATTRIBUTES)
    await fs.writeFile(path.join(repo.gitDir, 'workspace.txt'), `${repo.workspace}\n`)
  }

  /** Runs git work for one repository one at a time. */
  #exclusive(repo, task) {
    const run = repo.queue.then(task, task)
    repo.queue = run.catch(() => {})
    return run
  }

  async #snapshot(repo, ref) {
    const skipFile = path.join(repo.gitDir, 'skip.json')
    const skip = await fs.readFile(skipFile, 'utf8').then(JSON.parse).catch(() => null)
    if (skip && Date.now() - skip.at < SKIP_MS) throw new Error(skip.reason)
    // A snapshot cut off by a timeout or a crash leaves the index locked.
    await fs.rm(path.join(repo.gitDir, 'index.lock'), { force: true })
    let warning = null
    try {
      const large = await largeFiles(repo)
      if (large.length) {
        await git(repo, ['rm', '--cached', '--force', '--quiet', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'], {
          input: nulJoin(large),
          literal: true,
        })
      }
      const pathspecs = ['.', ...large.map((file) => `:(exclude,literal)${file}`)]
      try {
        await git(repo, ['add', '--all', '--ignore-errors', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: nulJoin(pathspecs) })
      } catch (error) {
        // Files another program keeps locked keep their previous snapshot.
        if (error.killed) throw error
        warning = firstLines(error.stderr || error.message)
      }
    } catch (error) {
      if (error.killed) {
        const reason = 'フォルダ内のファイルが多すぎるため、変更を戻すための保存を省略しました。'
        await fs.writeFile(skipFile, JSON.stringify({ at: Date.now(), reason })).catch(() => {})
        await fs.rm(path.join(repo.gitDir, 'index.lock'), { force: true })
        throw new Error(reason)
      }
      throw error
    }
    const tree = (await git(repo, ['write-tree'])).trim()
    const commit = (await git(repo, ['commit-tree', tree, '-m', 'Agent Desk checkpoint'])).trim()
    if (ref) await git(repo, ['update-ref', `refs/agent-desk/${ref}`, commit])
    return { commit, warning }
  }

  async #diff(repo, from, to) {
    const out = await git(repo, ['diff-tree', '-r', '-z', '--no-renames', from, to])
    const parts = out.split('\0')
    const entries = []
    for (let index = 0; index + 1 < parts.length; index += 2) {
      const [oldMode, newMode, , , status] = parts[index].replace(/^:/, '').split(' ')
      if (UNTOUCHED_MODES.has(oldMode) || UNTOUCHED_MODES.has(newMode)) continue
      entries.push({ path: parts[index + 1], status })
    }
    return entries
  }
}

function actionOf(status) {
  if (status === 'A') return 'delete'
  if (status === 'D') return 'recreate'
  return 'restore'
}

/** New or changed files above MAX_FILE_BYTES, which snapshots leave out. */
async function largeFiles(repo) {
  const out = await git(repo, ['ls-files', '-z', '--others', '--modified', '--exclude-standard'])
  const files = out.split('\0').filter(Boolean)
  const large = []
  for (let start = 0; start < files.length; start += 256) {
    await Promise.all(files.slice(start, start + 256).map(async (file) => {
      const stat = await fs.lstat(path.join(repo.workspace, file)).catch(() => null)
      if (stat?.isFile() && stat.size > repo.maxFileBytes) large.push(file)
    }))
  }
  return large
}

/** Snapshot changes to files that are currently too large are never applied. */
async function withoutLargeCurrentFiles(repo, entries) {
  const large = await Promise.all(entries.map(async ({ path: file }) => {
    const stat = await fs.lstat(path.join(repo.workspace, file)).catch(() => null)
    return stat?.isFile() && stat.size > repo.maxFileBytes
  }))
  return entries.filter((_entry, index) => !large[index])
}

/** The absolute path of a workspace-relative file, or null if it would leave the workspace. */
function inside(workspace, file) {
  const full = path.resolve(workspace, file)
  const relative = path.relative(workspace, full)
  const outside = relative === '..' || relative.startsWith(`..${path.sep}`)
  return relative && !outside && !path.isAbsolute(relative) ? full : null
}

/** Removes folders a restore emptied, up to (not including) the workspace. */
async function removeEmptyDirs(workspace, dirs) {
  const sorted = [...dirs].sort((a, b) => b.length - a.length)
  for (let dir of sorted) {
    while (inside(workspace, dir)) {
      try {
        await fs.rmdir(dir)
      } catch {
        break
      }
      dir = path.dirname(dir)
    }
  }
}

function nulJoin(values) {
  return values.map((value) => `${value}\0`).join('')
}

function firstLines(text) {
  return String(text ?? '').trim().split('\n').slice(0, 6).join('\n')
}

function gitEnv(repo, literal) {
  const env = {}
  for (const [name, value] of Object.entries(process.env)) if (!/^GIT_/i.test(name)) env[name] = value
  Object.assign(env, {
    GIT_DIR: repo.gitDir,
    GIT_WORK_TREE: repo.workspace,
    // The user's own git settings (hooks, signing, line endings) must not apply.
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: repo.emptyConfig,
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Agent Desk',
    GIT_AUTHOR_EMAIL: 'agent-desk@localhost',
    GIT_COMMITTER_NAME: 'Agent Desk',
    GIT_COMMITTER_EMAIL: 'agent-desk@localhost',
  })
  if (literal) env.GIT_LITERAL_PATHSPECS = '1'
  return env
}

function git(repo, args, { input = '', literal = false, timeout = SNAPSHOT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['-c', 'safe.directory=*', ...args], {
      env: gitEnv(repo, literal),
      windowsHide: true,
      timeout,
      maxBuffer: 256 * 1024 * 1024,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout)
      if (error.code === 'ENOENT') return reject(new Error('Git が見つからないため、変更を戻すための保存ができません。Git をインストールしてください。'))
      error.stderr = stderr
      reject(error)
    })
    child.stdin.end(input)
  })
}
