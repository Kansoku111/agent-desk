// Keep the machine-readable code while making plan limits actionable in tasks.
export const SIWC_LIMIT_CODE = 'subscription_sharing_usage_limit_exceeded'
export const SIWC_LIMIT_TEXT = 'ChatGPT のプランの利用上限に達しました。'
  + 'ChatGPT の設定 → Usage で Agent Desk の上限やクレジットの利用を見直すと続けられます。'
export const SIWC_LIMIT_MESSAGE = SIWC_LIMIT_TEXT
  + ' [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage)'
function explain(error) {
  if (error?.code !== SIWC_LIMIT_CODE) return false
  error.message = `${SIWC_LIMIT_CODE}: ${SIWC_LIMIT_MESSAGE}`
  return true
}

/** Preserve status/headers and other errors, including pre-stream admission details. */
export async function explainSiwcUsage(response) {
  if (!response.ok) {
    let body
    try {
      body = await response.clone().json()
    } catch {
      return response
    }
    if (!explain(body.error)) return response
    return new Response(JSON.stringify(body), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    })
  }
  if (!response.body) return response
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = ''
  const emit = (block, controller) => {
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    let event
    try {
      event = JSON.parse(data)
    } catch {
      controller.enqueue(encoder.encode(block + '\n\n'))
      return
    }
    const changed = explain(event.response?.error) || explain(event.error)
    controller.enqueue(encoder.encode(changed ? `data: ${JSON.stringify(event)}\n\n` : block + '\n\n'))
  }
  const consume = (text, controller) => {
    pending += text
    let index
    while ((index = pending.search(/\r?\n\r?\n/)) >= 0) {
      const match = /^\r?\n\r?\n/.exec(pending.slice(index))[0]
      const block = pending.slice(0, index).replace(/\r\n/g, '\n')
      pending = pending.slice(index + match.length)
      emit(block, controller)
    }
  }
  const body = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      consume(decoder.decode(chunk, {
        stream: true
      }), controller)
    },
    flush(controller) {
      consume(decoder.decode(), controller)
      if (pending.trim()) emit(pending, controller)
    }
  }))
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
}
