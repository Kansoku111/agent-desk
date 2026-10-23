// RPC handlers for the model catalog: the dsh and model-list updates, and the
// catalog refresh (see index.js).

/** Handlers for models and updates; index.js merges them into the request table. */
export function createModelHandlers({ threads, catalog, catalogState, updates, modelUpdater, modelUpdateState, refreshCodexModels }) {
  return {
    'updates.check': async () => ({ updates: await updates.check() }),
    'updates.updateClaude': async () => ({ updates: await updates.updateClaude() }),

    'modelUpdate.check': async () => {
      // The ChatGPT account's own list first (the authoritative one), then pi-ai's newest release.
      await refreshCodexModels()
      await modelUpdater.check()
      return { modelUpdate: modelUpdateState(), busy: threads.busy }
    },

    'catalog.refresh': async () => {
      const models = catalog.data.models
      catalog.data.models = []
      try {
        await threads.warmCatalog()
      } catch (error) {
        catalog.data.models = models
        throw error
      }
      return { catalog: catalogState() }
    },
  }
}
