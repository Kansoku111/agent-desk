// RPC handlers for thread tasks (see index.js): create, send, steer, update and
// remove, checkpoints, permission answers, subagents, and message attachments.
import { createHash, randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { IMAGE_TYPES, isImageFile, isOtherFile, MAX_ATTACHMENT_BYTES, otherFileId } from './attachments.js'

/** Handlers for thread tasks; index.js merges them into the request table. */
export function createThreadHandlers({ paths, threads, teams, subagents, mutateSettings }) {

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

    'thread.create': async ({ workspace, model, effort, permissionMode, toolMode, text, images, createId }) => {
      const options = { workspace, model, effort, permissionMode, toolMode }
      let thread
      if (createId !== undefined) {
        const message = { text: text ?? '', images: await saveImages(images) }
        const fingerprint = createHash('sha256').update(JSON.stringify({
          workspace: path.resolve(workspace),
          model: model ?? null,
          effort: effort ?? '',
          permissionMode: permissionMode ?? 'workspace-write',
          toolMode: toolMode ?? 'native',
          ...message,
        })).digest('hex')
        const result = await threads.createWithFirstMessage({ createId, payloadHash: fingerprint, options, message })
        thread = result.thread
      } else {
        thread = await threads.create(options)
        try {
          await threads.send(thread.id, { text: text ?? '', images: await saveImages(images) })
        } catch (error) {
          await threads.remove(thread.id)
          throw error
        }
        thread = threads.summary(threads.threads.get(thread.id))
      }
      try {
        await mutateSettings(candidate => {
          candidate.lastWorkspace = thread.workspace
          if (model) candidate.defaultModel = model
          candidate.defaultEffort = effort || candidate.defaultEffort
          candidate.defaultPermissionMode = permissionMode ?? candidate.defaultPermissionMode
          if (thread.workspace !== paths.myPc && !candidate.workspaces.includes(thread.workspace)) candidate.workspaces.unshift(thread.workspace)
        })
      } catch (error) {
        // The task is already running. An error here would leave the draft to be sent again as a second task.
        console.warn(error.settingsCommitted
          ? '[agent-desk] task created; settings saved but effects failed:'
          : '[agent-desk] task created; saving settings failed:', error.message)
      }
      return { thread: threads.summary(threads.threads.get(thread.id)) }
    },

    'thread.messageStatus': ({ threadId, messageId }) => threads.messageStatus(threadId, messageId),

    'thread.send': async ({ threadId, text, images, messageId }) => {
      return threads.send(threadId, { text: text ?? '', images: await saveImages(images), messageId }, { userInitiated: true })
    },

    'thread.steer': async ({ threadId, text, images, messageId }) => {
      return threads.steer(threadId, { text: text ?? '', images: await saveImages(images), messageId }, { userInitiated: true })
    },

    'thread.cancel': ({ threadId }) => threads.cancel(threadId),

    'thread.update': async ({ threadId, ...patch }) => {
      const thread = await threads.update(threadId, patch)
      await mutateSettings(candidate => {
        if (patch.model) candidate.defaultModel = patch.model
        if (patch.effort !== undefined) candidate.defaultEffort = patch.effort
        if (patch.permissionMode) candidate.defaultPermissionMode = patch.permissionMode
      }, { notify: false })
      return { thread }
    },

    'thread.remove': async ({ threadId }) => {
      // Some older projects only survive through their tasks (the recent-project
      // list used to be capped). Preserve that project before its last task goes.
      const thread = threads.threads.get(threadId)
      // Never destroy the only durable reference to a project before this save succeeds.
      if (!thread) return threads.remove(threadId)
      let result
      await mutateSettings(candidate => {
        if (thread.workspace !== paths.myPc && !candidate.workspaces.includes(thread.workspace)) {
          candidate.workspaces.push(thread.workspace)
        }
      }, { afterCommit: async () => { result = await threads.remove(threadId) } })
      return result
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
