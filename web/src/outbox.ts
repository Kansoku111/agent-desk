// Durable follow-ups, independent of React and the WebSocket lifecycle.
// A message stays on disk until the server confirms its stable ID. In-flight
// steering is reconciled, never blindly replayed after an ambiguous failure.
import type { Attachment } from './types'

export interface QueuedMessage {
  id: string
  text: string
  images: Attachment[]
  plan?: boolean
  phase: 'queued' | 'sending' | 'uncertain' | 'failed'
  operation?: 'send' | 'steer'
  error?: string
}
type Queues = Record<string, QueuedMessage[]>
type Receipt = { status: 'accepted'; turnId: string; kind: 'send' | 'steer' } | { status: 'missing' | 'uncertain' }
type Thread = { status: 'idle' | 'running' | 'error' }
type Options = {
  initial: Queues
  persist(queues: Queues): void
  changed(queues: Queues): void
  request(type: string, params: Record<string, unknown>): Promise<unknown>
  thread(id: string): Thread | undefined
  ready(): boolean
  report(message: string): void
  newId?: () => string
}

/** randomUUID requires HTTPS; getRandomValues also works on the phone's HTTP origin. */
export function messageId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Upgrade the old text/images queues without losing a follow-up on UI reload. */
export function readQueues(raw: string | null, newId = messageId): Queues {
  let parsed: unknown
  try { parsed = JSON.parse(raw ?? '{}') } catch { return {} }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const queues: Queues = {}
  for (const [threadId, list] of Object.entries(parsed)) {
    if (!Array.isArray(list) || ['__proto__', 'constructor', 'prototype'].includes(threadId)) continue
    const messages: QueuedMessage[] = []
    for (const value of list) {
      if (!value || typeof value !== 'object' || typeof value.text !== 'string' || !Array.isArray(value.images)
        || (value.plan !== undefined && typeof value.plan !== 'boolean')) continue
      if (!value.images.every((image: Attachment) => image && typeof image.file === 'string' && typeof image.mimeType === 'string' && typeof image.name === 'string')) continue
      const hasId = typeof value.id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.id)
      messages.push({
        id: hasId ? value.id : newId(), text: value.text, images: value.images,
        ...(value.plan === true ? { plan: true } : {}),
        phase: hasId && ['queued', 'sending', 'uncertain', 'failed'].includes(value.phase) ? value.phase : 'queued',
        ...(value.operation === 'send' || value.operation === 'steer' ? { operation: value.operation } : {}),
        ...(typeof value.error === 'string' ? { error: value.error } : {}),
      })
    }
    if (messages.length) queues[threadId] = messages
  }
  return queues
}

export class Outbox {
  private queues: Queues
  private options: Options
  private active = new Map<string, Promise<void>>()

  constructor(options: Options) {
    this.options = options
    this.queues = options.initial
  }

  snapshot() { return this.queues }

  enqueue(threadId: string, text: string, images: Attachment[], first = false, plan = false) {
    const message: QueuedMessage = { id: (this.options.newId ?? messageId)(), text, images, phase: 'queued', ...(plan ? { plan: true } : {}) }
    this.change(threadId, (queue) => first ? [message, ...queue] : [...queue, message])
    return message.id
  }

  remove(threadId: string, id: string) {
    const message = this.find(threadId, id)
    // Sending does not mean unsent: dismissing an unknown result cannot cancel the server action.
    // Only the row being sent is guarded; another row can go at once, and a
    // reserved operation for it finds nothing when its turn comes.
    if (!message || message.phase === 'sending') return false
    this.change(threadId, (queue) => queue.filter((entry) => entry.id !== id))
    return true
  }

  forget(threadId: string) {
    this.change(threadId, () => [])
  }

  /** A hello or a thread transition also reconciles receipts while that thread is running. */
  flush(threadId: string, allowError = false): Promise<void> {
    return this.exclusive(threadId, () => this.pump(threadId, allowError))
  }

  retry(threadId: string, id: string): Promise<void> {
    return this.exclusive(threadId, async () => {
      const message = this.find(threadId, id)
      if (!message || !this.canConnect()) return
      if (message.phase === 'failed') this.update(threadId, id, { phase: 'queued', error: undefined })
      else if (message.phase === 'uncertain' || message.phase === 'sending') await this.reconcile(threadId, message)
      await this.pump(threadId, true)
    })
  }

  steer(threadId: string, id: string): Promise<void> {
    return this.exclusive(threadId, async () => {
      const message = this.find(threadId, id)
      if (!message || message.phase !== 'queued' || !this.canConnect() || this.options.thread(threadId)?.status !== 'running') return
      this.update(threadId, id, { phase: 'sending', operation: 'steer', error: undefined })
      try {
        const result = await this.options.request('thread.steer', this.params(threadId, message)) as { status?: string; steered?: boolean }
        if (result.status === 'uncertain') this.markUncertain(threadId, id)
        else if (result.steered === true || result.status === 'accepted') this.acknowledge(threadId, id)
        else if (result.steered === false) this.update(threadId, id, { phase: 'queued', operation: undefined })
        else throw new Error('割り込みの受領結果を確認できませんでした')
      } catch (error) {
        await this.failedRequest(threadId, id, error)
      }
      await this.pump(threadId, false)
    })
  }

  private async pump(threadId: string, allowError: boolean) {
    while (this.canConnect()) {
      const message = this.queues[threadId]?.[0]
      if (!message) return
      if (message.phase === 'sending' || message.phase === 'uncertain') {
        if (!await this.reconcile(threadId, message)) return
        // The next entry can also be awaiting a receipt (several queued
        // follow-ups may have been steered before the page reloaded).
        continue
      }
      const thread = this.options.thread(threadId)
      if (!thread || (thread.status !== 'idle' && !(allowError && thread.status === 'error')) || message.phase !== 'queued') return
      this.update(threadId, message.id, { phase: 'sending', operation: 'send', error: undefined })
      try {
        const result = await this.options.request('thread.send', this.params(threadId, message)) as { status?: string; turnId?: string }
        if (result.status === 'uncertain') { this.markUncertain(threadId, message.id); return }
        if (!result.turnId) throw new Error('メッセージの受領結果を確認できませんでした')
        this.acknowledge(threadId, message.id)
      } catch (error) {
        await this.failedRequest(threadId, message.id, error)
        return
      }
      allowError = false
    }
  }

  private async reconcile(threadId: string, message: QueuedMessage) {
    try {
      const receipt = await this.options.request('thread.messageStatus', { threadId, messageId: message.id }) as Receipt
      if (receipt.status === 'accepted') { this.acknowledge(threadId, message.id); return true }
      if (receipt.status === 'missing') {
        // A durable pre-send steering receipt would exist if the engine might have read it.
        this.update(threadId, message.id, { phase: 'queued', operation: undefined, error: undefined })
        return true
      }
      this.markUncertain(threadId, message.id)
    } catch (error) {
      this.options.report(this.errorText(error))
    }
    return false
  }

  private async failedRequest(threadId: string, id: string, error: unknown) {
    const message = this.find(threadId, id)
    if (!message) return
    if ((error as { code?: string })?.code === 'REQUEST_REJECTED' && this.canConnect()) {
      // An error reply can follow a disk error after the engine accepted steering.
      const reconciled = await this.reconcile(threadId, message)
      if (reconciled && this.find(threadId, id)) this.update(threadId, id, { phase: 'failed', error: this.errorText(error) })
    }
    this.options.report(`メッセージを保持しています: ${this.errorText(error)}`)
  }

  private markUncertain(threadId: string, id: string) {
    const message = this.find(threadId, id)
    if (!message || message.phase === 'uncertain') return
    const error = '割り込みが届いた可能性があるため自動再送しません。会話を確認してください'
    this.update(threadId, id, { phase: 'uncertain', error })
    this.options.report(error)
  }

  private params(threadId: string, message: QueuedMessage) {
    return { threadId, messageId: message.id, text: message.text, images: message.images.map(({ file, mimeType, name }) => ({ file, mimeType, name })), ...(message.plan ? { plan: true } : {}) }
  }

  private canConnect() { return this.options.ready() }
  private find(threadId: string, id: string) { return this.queues[threadId]?.find((message) => message.id === id) }
  private errorText(error: unknown) { return error instanceof Error ? error.message : String(error) }
  private acknowledge(threadId: string, id: string) { this.change(threadId, (queue) => queue.filter((message) => message.id !== id)) }
  private update(threadId: string, id: string, patch: Partial<QueuedMessage>) {
    this.change(threadId, (queue) => queue.map((message) => message.id === id ? { ...message, ...patch } : message))
  }

  private change(threadId: string, transform: (queue: QueuedMessage[]) => QueuedMessage[]) {
    const queue = transform(this.queues[threadId] ?? [])
    const next = { ...this.queues, [threadId]: queue }
    if (!queue.length) delete next[threadId]
    // If storage is full/unavailable, never report acceptance to the composer or send a new ID.
    this.options.persist(next)
    this.queues = next
    this.options.changed(next)
  }

  private exclusive(threadId: string, work: () => Promise<void>): Promise<void> {
    const pending = this.active.get(threadId)
    // Explicit steering and retries wait their turn instead of being dropped.
    // Receipt checks also stay serialized, so overlapping requests cannot send
    // the same queued message concurrently.
    const run = (pending ? pending.then(() => work()) : Promise.resolve().then(work))
      .catch((error) => this.options.report(this.errorText(error)))
      // The guard now names the newest tail; an older run finishing must not clear it.
      .finally(() => { if (this.active.get(threadId) === run) this.active.delete(threadId) })
    this.active.set(threadId, run)
    return run
  }
}
