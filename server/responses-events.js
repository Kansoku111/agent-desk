// Shared public Responses SSE helpers; no private transport/authentication.
export function parseSse(text) {
  const events = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (!data || data === '[DONE]') continue
    try {
      events.push(JSON.parse(data))
    } catch {}
  }
  return events
}
export function responseProblem(status, body, subject = 'The request') {
  let message = ''
  try {
    const parsed = JSON.parse(body)
    const detail = parsed.error?.message ?? parsed.detail
    message = typeof detail === 'string' ? detail : JSON.stringify(detail ?? '')
  } catch {
    message = String(body).slice(0, 500)
  }
  return `${subject} failed with HTTP ${status}${message ? `: ${message}` : ''}`
}
export function completedEvents(events) {
  const failed = events.find(event => ['error', 'response.failed', 'response.incomplete'].includes(event.type))
  if (failed) {
    const detail = failed.error ?? failed.response?.error ?? failed.response?.incomplete_details ?? {}
    throw new Error(`Responses ${failed.type}: ${JSON.stringify(detail)}`)
  }
  if (!events.some(event => event.type === 'response.completed')) {
    throw new Error('Responses stream ended without response.completed')
  }
  return events
}
