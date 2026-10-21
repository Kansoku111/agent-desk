// Web search through the ChatGPT subscription.
//
// dsh's `web_search` tool ships with one search provider, DeepSeek's search
// API, which needs a DeepSeek API key; without one every search fails. The
// Codex backend runs OpenAI's hosted `web_search` tool, so one request asks a
// GPT model to search and write a digest of what it found. The digest becomes
// the result's summary and the searched pages its sources.
// web-search-plugin.js registers this as dsh's search provider.

export const SEARCH_MODEL = 'gpt-6-luna'

const INSTRUCTIONS = [
  'You are the web search backend of another AI agent. Search the web for the query with the web_search tool; search again with a refined query when the first results are thin.',
  'Then write a compact, factual digest of what the sources say about the query: the key facts, names, versions, dates and numbers, each followed by its source as a markdown link.',
  'Say when sources disagree or look outdated. Do not answer from memory, add a preamble, or ask questions. Write in the language of the query.',
].join(' ')

/** The Responses request for one search. */
export function searchRequest(query, { model = SEARCH_MODEL } = {}) {
  return {
    model,
    store: false,
    stream: true,
    instructions: INSTRUCTIONS,
    input: [{ role: 'user', content: [{ type: 'input_text', text: query }] }],
    tools: [{ type: 'web_search' }],
    tool_choice: 'auto',
    include: ['web_search_call.action.sources'],
    reasoning: { effort: 'low' },
  }
}

/** Drops the tracking parameter OpenAI adds to cited links. */
export function cleanUrl(url) {
  try {
    const parsed = new URL(url)
    if (parsed.searchParams.get('utm_source') !== 'openai') return url
    parsed.searchParams.delete('utm_source')
    return parsed.href
  } catch {
    return url
  }
}

/**
 * The search result (dsh's `ctx.web` shape) from a finished stream. Sources
 * the digest cites come first, with their titles; the other pages the search
 * read follow. dsh caps the list at the tool's `maxResults`.
 * @returns {{ content?: string, sources: { url: string, title?: string }[], truncated: false }}
 */
export function searchFromEvents(events) {
  let searched = false
  let text = ''
  const cited = []
  const read = []
  for (const event of events) {
    if (event.type === 'error' || event.type === 'response.failed') {
      const error = event.error ?? event.response?.error ?? {}
      throw new Error(`web search failed: ${error.message ?? error.code ?? JSON.stringify(event).slice(0, 300)}`)
    }
    if (event.type !== 'response.output_item.done') continue
    const item = event.item ?? {}
    if (item.type === 'web_search_call') {
      searched = true
      for (const source of item.action?.sources ?? []) if (source?.url) read.push({ url: source.url })
    }
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        if (typeof part.text === 'string') text += part.text
        for (const note of part.annotations ?? []) {
          if (note.type === 'url_citation' && note.url) cited.push({ url: note.url, ...(note.title ? { title: note.title } : {}) })
        }
      }
    }
  }
  if (!searched) throw new Error(`the model did not search the web${text.trim() ? `; it said: ${text.trim().slice(0, 300)}` : ''}`)
  const seen = new Set()
  const sources = []
  for (const source of [...cited, ...read]) {
    const url = cleanUrl(source.url)
    if (seen.has(url)) continue
    seen.add(url)
    sources.push({ ...source, url })
  }
  const content = text.replace(/\?utm_source=openai(?=[)\]\s>]|$)/g, '').trim()
  return { ...(content ? { content } : {}), sources, truncated: false }
}
