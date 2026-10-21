// A dsh plugin: the search provider behind `web_search`, on the ChatGPT
// subscription (see web-search.js). The home patch (dsh-config.js) loads it
// into every dsh process and selects it in place of DeepSeek's search.
import path from 'node:path'
import { WebError } from '@deepseek-ai/dsh-web'
import { SiwcClient } from './siwc-client.js'
import { parseSse, responseProblem, completedEvents } from './responses-events.js'
import { CredentialStore } from './credentials.js'
import { searchFromEvents, searchRequest } from './web-search.js'

export const PROVIDER_ID = 'agent-desk-chatgpt'

export const name = 'agent-desk-web-search'
export const inject = ['web']

/** The provider; `credentials` is dsh's credential file, which holds the ChatGPT sign-in. */
export function chatgptSearchProvider(credentials) {
  const siwc = new SiwcClient(new CredentialStore(credentials))
  const aborted = (signal, cause) => new WebError('ChatGPT web search aborted', 'WEB_ABORTED', { cause: signal?.reason ?? cause })
  return {
    id: PROVIDER_ID,
    available: () => true,
    async search(request, signal) {
      let response
      try {
        const models = await siwc.models()
        const offered = models.filter(model => model.visibility === 'list')
        const selected = offered.find(model => model.slug === 'gpt-6-luna') ?? offered[0]
        if (!selected) throw new Error('ChatGPT account has no available search model')
        response = await siwc.post(searchRequest(request.query, { model: selected.slug }), { signal })
      } catch (error) {
        if (signal?.aborted) throw aborted(signal, error)
        throw new WebError(`ChatGPT web search failed: ${error.message}`, 'WEB_PROVIDER_ERROR', { cause: error })
      }
      if (!response.ok) throw new WebError(responseProblem(response.status, response.text, 'The web search'), 'WEB_PROVIDER_ERROR')
      try {
        return searchFromEvents(completedEvents(parseSse(response.text)))
      } catch (error) {
        throw new WebError(`ChatGPT ${error.message}`, 'WEB_PROVIDER_ERROR', { cause: error })
      }
    },
  }
}

export function apply(ctx, config) {
  const credentials = config?.credentials ?? path.join(process.env.DSH_HOME ?? '', '.credentials.yaml')
  ctx.web.registerSearchProvider(chatgptSearchProvider(credentials))
}
