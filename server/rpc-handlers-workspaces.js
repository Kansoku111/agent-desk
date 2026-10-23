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
export function createWorkspaceHandlers({ paths, getSettings, saveSettings, broadcast }) {

  /** Where the folder picker starts: next to the most recent project, else the home folder. */
  function suggestedParent() {
    const recent = getSettings().workspaces.find((dir) => dir !== paths.myPc && fs.existsSync(dir))
    return recent ? path.dirname(recent) : os.homedir()
  }

  async function addWorkspace(dir) {
    // path.resolve('') would be the server's own folder, so an empty path is refused.
    const text = String(dir ?? '').trim().replace(/^"(.*)"$/, '$1').trim()
    if (!text) throw new Error('フォルダを指定してください')
    const resolved = path.resolve(text)
    const stat = await fsp.stat(resolved).catch(() => null)
    if (!stat?.isDirectory()) throw new Error(`フォルダが見つかりません: ${resolved}`)
    if (resolved === paths.myPc) return resolved
    getSettings().workspaces = [resolved, ...getSettings().workspaces.filter((entry) => entry !== resolved)].slice(0, 30)
    getSettings().lastWorkspace = resolved
    await saveSettings()
    broadcast('settings', { settings: getSettings() })
    return resolved
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
      const resolved = await addWorkspace(dir)
      if (resolved === paths.myPc) throw new Error('My PC のフォルダはプロジェクトにできません')
      const label = String(name ?? '').trim().slice(0, 80)
      getSettings().projectNames = { ...getSettings().projectNames }
      if (label && label !== path.basename(resolved)) getSettings().projectNames[resolved] = label
      else delete getSettings().projectNames[resolved]
      await saveSettings()
      broadcast('settings', { settings: getSettings() })
      return { path: resolved }
    },

    'project.rename': async ({ path: dir, name }) => {
      const label = String(name ?? '').trim().slice(0, 80)
      getSettings().projectNames = { ...getSettings().projectNames }
      if (label && label !== path.basename(dir)) getSettings().projectNames[dir] = label
      else delete getSettings().projectNames[dir]
      await saveSettings()
      broadcast('settings', { settings: getSettings() })
      return { settings: getSettings() }
    },

    'project.color': async ({ path: dir, color }) => {
      if (typeof dir !== 'string' || !dir) throw new Error('プロジェクトが見つかりません')
      if (!isProjectColor(color)) throw new Error('この色は選べません')
      getSettings().projectColors = { ...getSettings().projectColors, [dir]: color }
      await saveSettings()
      broadcast('settings', { settings: getSettings() })
      return { settings: getSettings() }
    },

    'workspace.remove': async ({ path: dir }) => {
      getSettings().workspaces = getSettings().workspaces.filter((entry) => entry !== dir)
      getSettings().projectNames = Object.fromEntries(Object.entries(getSettings().projectNames ?? {}).filter(([key]) => key !== dir))
      getSettings().projectColors = Object.fromEntries(Object.entries(getSettings().projectColors ?? {}).filter(([key]) => key !== dir))
      if (getSettings().lastWorkspace === dir) getSettings().lastWorkspace = getSettings().workspaces[0] ?? null
      await saveSettings()
      broadcast('settings', { settings: getSettings() })
      return { settings: getSettings() }
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
