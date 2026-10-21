// RPC handlers for the model catalog: custom models, the dsh and model-list
// updates, and the catalog refresh (see index.js).
import { CUSTOM_MODEL_PROVIDERS, isModelId, templateModels } from './model-catalog.js'

/** Handlers for models and updates; index.js merges them into the request table. */
export function createModelHandlers({ getSettings, saveSettings, broadcast, threads, catalog, catalogState, updater, modelUpdater, modelUpdateState, updateModelCatalog, refreshCodexModels, assertNotUpdating }) {
  return {
    'models.templates': async () => ({ templates: await templateModels(), custom: getSettings().customModels }),

    'models.addCustom': async ({ provider, modelId: rawId, template, name }) => {
      if (!CUSTOM_MODEL_PROVIDERS.includes(provider)) throw new Error('このプロバイダーにはモデルを追加できません')
      const modelId = String(rawId ?? '').trim()
      if (!isModelId(modelId)) throw new Error('モデル ID は英数字と「.」「-」「_」で入力してください（例: claude-sonnet-6）')
      const templates = (await templateModels())[provider] ?? []
      if (templates.some((entry) => entry.id === modelId)) throw new Error('このモデルはすでに一覧にあります')
      if (getSettings().customModels.some((entry) => entry.provider === provider && entry.id === modelId)) throw new Error('このモデルはすでに追加されています')
      if (!templates.some((entry) => entry.id === template)) throw new Error('元にするモデルを選んでください')
      getSettings().customModels = [...getSettings().customModels, {
        provider,
        id: modelId,
        template,
        name: String(name ?? '').trim().slice(0, 80) || null,
      }]
      await saveSettings()
      broadcast('settings', { settings: getSettings() })
      const result = await updateModelCatalog()
      return { settings: getSettings(), busy: threads.busy, skipped: result.skipped }
    },

    'models.removeCustom': async ({ provider, modelId }) => {
      getSettings().customModels = getSettings().customModels.filter((entry) => !(entry.provider === provider && entry.id === modelId))
      await saveSettings()
      broadcast('settings', { settings: getSettings() })
      await updateModelCatalog()
      return { settings: getSettings(), busy: threads.busy }
    },

    'dshUpdate.check': async () => ({ update: await updater.check() }),
    'dshUpdate.apply': async ({ version }) => ({ update: await updater.apply(version) }),
    'dshUpdate.cancel': () => ({ update: updater.cancel() }),
    'dshUpdate.recover': async () => ({ update: await updater.retryRecovery() }),

    'modelUpdate.check': async () => {
      // The ChatGPT account's own list first (the authoritative one), then pi-ai's newest release.
      await refreshCodexModels()
      await modelUpdater.check()
      return { modelUpdate: modelUpdateState(), busy: threads.busy }
    },

    'catalog.refresh': async () => {
      assertNotUpdating()
      catalog.data.models = []
      await threads.warmCatalog()
      return { catalog: catalogState() }
    },
  }
}
