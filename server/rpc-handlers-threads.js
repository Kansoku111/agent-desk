// RPC handlers for thread tasks (see index.js): create, send, steer, update and
// remove, checkpoints, permission answers, subagents, and message attachments.
import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { IMAGE_TYPES, isImageFile, isOtherFile, MAX_ATTACHMENT_BYTES, otherFileId } from './attachments.js'

/** Handlers for thread tasks; index.js merges them into the request table. */
export function createThreadHandlers({ paths, threads, teams, subagents, getSettings, saveSettings, broadcast }) {

  async function saveImages(images) {
    const saved = []
    for (const image of images ?? []) {
      if (isImageFile(image?.file) || isOtherFile(image?.file)) {
        saved.push({ file: image.file, mimeType: String(image.mimeType ?? ''), name: String(image.name ?? '') })
      }
    }
    return saved
  }

  return {
    'thread.get': ({ threadId }) => threads.get(threadId),

    'subagents.list': async ({ threadId }) => {
      const { thread } = await threads.get(threadId)
      return { subagents: await subagents.list(thread.id, thread.sessionId) }
    },

    'thread.create': async ({ workspace, model, effort, permissionMode, text, images }) => {
      const thread = await threads.create({ workspace, model, effort, permissionMode })
      try {
        await threads.send(thread.id, { text: text ?? '', images: await saveImages(images) })
      } catch (error) {
        await threads.remove(thread.id)
        throw error
      }
      getSettings().lastWorkspace = thread.workspace
      if (model) getSettings().defaultModel = model
      getSettings().defaultEffort = effort || getSettings().defaultEffort
      getSettings().defaultPermissionMode = permissionMode ?? getSettings().defaultPermissionMode
      if (thread.workspace !== paths.myPc && !getSettings().workspaces.includes(thread.workspace)) getSettings().workspaces.unshift(thread.workspace)
      try {
        await saveSettings()
        broadcast('settings', { settings: getSettings() })
      } catch (error) {
        // The task is already running. An error here would leave the draft to be sent again as a second task.
        console.warn('[agent-desk] task created; saving settings failed:', error.message)
      }
      return { thread: threads.summary(threads.threads.get(thread.id)) }
    },

    'thread.messageStatus': ({ threadId, messageId }) => threads.messageStatus(threadId, messageId),

    'thread.send': async ({ threadId, text, images, messageId }) => {
      teams.userWrote(threadId)
      return threads.send(threadId, { text: text ?? '', images: await saveImages(images), messageId })
    },

    'thread.steer': async ({ threadId, text, images, messageId }) => {
      teams.userWrote(threadId)
      return threads.steer(threadId, { text: text ?? '', images: await saveImages(images), messageId })
    },

    'thread.cancel': ({ threadId }) => threads.cancel(threadId),

    'thread.update': async ({ threadId, ...patch }) => {
      const thread = await threads.update(threadId, patch)
      if (patch.model) getSettings().defaultModel = patch.model
      if (patch.effort !== undefined) getSettings().defaultEffort = patch.effort
      if (patch.permissionMode) getSettings().defaultPermissionMode = patch.permissionMode
      await saveSettings()
      return { thread }
    },

    'thread.remove': async ({ threadId }) => {
      // Some older projects only survive through their tasks (the recent-project
      // list used to be capped). Preserve that project before its last task goes.
      const thread = threads.threads.get(threadId)
      if (thread && thread.workspace !== paths.myPc && !getSettings().workspaces.includes(thread.workspace)) {
        getSettings().workspaces.push(thread.workspace)
      }
      // Persist even on a retry after a failed settings write; never destroy the
      // only durable reference to a project before this save succeeds.
      if (thread) {
        await saveSettings()
        broadcast('settings', { settings: getSettings() })
      }
      return threads.remove(threadId)
    },

    'checkpoint.preview': ({ threadId, turnId }) => threads.checkpointPreview(threadId, turnId),

    'checkpoint.restore': ({ threadId, turnId }) => threads.restoreCheckpoint(threadId, turnId),

    'checkpoint.undo': ({ threadId, turnId }) => threads.undoRestore(threadId, turnId),

    'permission.respond': ({ requestId, optionId }) => threads.respondPermission(requestId, optionId ?? null),

    'attachment.add': async ({ name, mimeType, data }) => {
      const bytes = Buffer.from(String(data ?? ''), 'base64')
      if (bytes.length === 0) throw new Error('ファイルが空です')
      if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error('ファイルは 10MB 以下にしてください')
      const label = String(name ?? '').slice(0, 200)
      const ext = IMAGE_TYPES[mimeType]
      if (ext) {
        const file = `${randomUUID()}.${ext}`
        await fsp.writeFile(path.join(paths.attachmentsDir, file), bytes)
        return { file, mimeType, name: label }
      }
      // Any other file keeps its name so the agent can tell what it is.
      const file = otherFileId(randomUUID(), label)
      const [folder, base] = file.split('/')
      await fsp.mkdir(path.join(paths.attachmentsDir, folder), { recursive: true })
      await fsp.writeFile(path.join(paths.attachmentsDir, folder, base), bytes)
      return { file, mimeType: String(mimeType ?? '') || 'application/octet-stream', name: label }
    },
  }
}
