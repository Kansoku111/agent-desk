// RPC handlers for workspaces (the project folders), projects, the files an
// answer mentions, and opening a URL on this PC (see index.js).
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isRunnable, resolveReference } from './file-refs.js'
import { isProjectColor } from './project-colors.js'
import { gitInfo, openExternal, openFile, openIn, pickFolder } from './system.js'

/** Handlers for workspaces and projects; index.js merges them into the request table. */
export function createWorkspaceHandlers({ paths, getSettings, mutateSettings }) {

  /** Where the folder picker starts: next to the most recent project, else the home folder. */
  function suggestedParent() {
    const recent = getSettings().workspaces.find((dir) => dir !== paths.myPc && fs.existsSync(dir))
    return recent ? path.dirname(recent) : os.homedir()
  }

  async function addWorkspace(dir, project) {
    // path.resolve('') would be the server's own folder, so an empty path is refused.
    const text = String(dir ?? '').trim().replace(/^"(.*)"$/, '$1').trim()
    if (!text) throw new Error('フォルダを指定してください')
    const resolved = path.resolve(text)
    const stat = await fsp.stat(resolved).catch(() => null)
    if (!stat?.isDirectory()) throw new Error(`フォルダが見つかりません: ${resolved}`)
    if (resolved === paths.myPc) {
      if (project) throw new Error('My PC のフォルダはプロジェクトにできません')
      return resolved
    }
    await mutateSettings(candidate => {
      candidate.workspaces = [resolved, ...candidate.workspaces.filter((entry) => entry !== resolved)].slice(0, 30)
      candidate.lastWorkspace = resolved
      if (project) rename(candidate, resolved, project.name)
    })
    return resolved
  }

  function rename(candidate, dir, name) {
    const label = String(name ?? '').trim().slice(0, 80)
    candidate.projectNames ??= {}
    if (label && label !== path.basename(dir)) candidate.projectNames[dir] = label
    else delete candidate.projectNames[dir]
  }

  return {
    'workspace.pick': async () => {
      const chosen = await pickFolder({ title: 'ワークスペースにするフォルダーを選択', initial: suggestedParent() })
      return { path: chosen ? await addWorkspace(chosen) : null }
    },

    'workspace.add': async ({ path: dir }) => ({ path: await addWorkspace(dir) }),

    // Chooses a folder without adding it anywhere (the project dialog adds it on create).
    'folder.pick': async () => ({
      path: await pickFolder({ title: 'ソースフォルダーを選択', initial: suggestedParent() }),
    }),

    'project.create': async ({ name, path: dir }) => {
      const resolved = await addWorkspace(dir, { name })
      return { path: resolved }
    },

    'project.rename': async ({ path: dir, name }) => {
      return mutateSettings(candidate => rename(candidate, dir, name))
    },

    'project.color': async ({ path: dir, color }) => {
      if (typeof dir !== 'string' || !dir) throw new Error('プロジェクトが見つかりません')
      if (!isProjectColor(color)) throw new Error('この色は選べません')
      return mutateSettings(candidate => {
        candidate.projectColors = { ...candidate.projectColors, [dir]: color }
      })
    },

    'workspace.remove': async ({ path: dir }) => {
      return mutateSettings(candidate => {
        candidate.workspaces = candidate.workspaces.filter((entry) => entry !== dir)
        candidate.projectNames = Object.fromEntries(Object.entries(candidate.projectNames ?? {}).filter(([key]) => key !== dir))
        candidate.projectColors = Object.fromEntries(Object.entries(candidate.projectColors ?? {}).filter(([key]) => key !== dir))
        if (candidate.lastWorkspace === dir) candidate.lastWorkspace = candidate.workspaces[0] ?? null
      })
    },

    'workspace.open': ({ path: dir, target }) => openIn(target, dir),

    // Which of the paths an answer mentions exist (they become clickable).
    'file.stat': async ({ refs, workspace }) => {
      const list = Array.isArray(refs) ? refs.slice(0, 100) : []
      const results = await Promise.all(list.map(async (ref) => {
        const found = await resolveReference(ref, typeof workspace === 'string' ? workspace : null)
        return [ref, found.exists ? { file: found.file, line: found.line, directory: found.directory } : null]
      }))
      return { files: Object.fromEntries(results) }
    },

    'file.open': async ({ ref, workspace, how }) => {
      if (!['open', 'reveal'].includes(how)) throw new Error('不明な開き方です')
      const found = await resolveReference(ref, typeof workspace === 'string' ? workspace : null)
      if (!found.exists) throw new Error(`ファイルが見つかりません: ${ref}`)
      // Programs and scripts are shown, never started, from a click in an answer.
      const reveal = how === 'open' && !found.directory && isRunnable(found.file)
      openFile(found.file, reveal ? 'reveal' : how)
      return { file: found.file, revealed: reveal }
    },

    'workspace.git': async ({ path: dir }) => ({ git: await gitInfo(dir) }),

    'system.openUrl': ({ url }) => openExternal(url),
  }
}
