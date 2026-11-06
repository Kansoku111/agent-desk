import { OutputSpeedMeter } from './output-speed.js'

const textTypes = new Set(['agentMessage', 'reasoning'])
const deltaMethods = new Set([
  'item/agentMessage/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
])
const validId = (id) => typeof id === 'string' && id.length > 0

/** Translate app-server notifications without treating history or usage as text. */
export class CodexOutputSpeedMeter extends OutputSpeedMeter {
  constructor(options = {}) {
    super(options)
    this.currentItem = null
    this.block = null
    this.completedItems = new Set()
    this.observedItems = new Set()
    this.seenItems = new Set()
  }

  event(method, params) {
    if (this.state === 'done' || !params || typeof params !== 'object') return

    if (method === 'item/started') {
      const item = params.item
      if (!item || !validId(item.id) || typeof item.type !== 'string' || !item.type) return
      if (textTypes.has(item.type)) {
        if (this.completedItems.has(item.id) || this.currentItem === item.id) return
        this.seenItems.add(item.id)
        this.currentItem = item.id
        this.block = null
        this.start()
      } else if (item.type !== 'userMessage') {
        this.currentItem = null
        this.block = null
        this.pause({ discard: true })
      }
      return
    }

    if (method === 'item/completed') {
      const item = params.item
      if (!item || !validId(item.id) || !textTypes.has(item.type) || this.completedItems.has(item.id)) return
      const previouslySeen = this.seenItems.has(item.id)
      this.completedItems.add(item.id)
      this.seenItems.add(item.id)
      if (item.id === this.currentItem) {
        this.pause()
        this.block = null
      } else if (!previouslySeen && (this.currentItem === null || this.completedItems.has(this.currentItem))) {
        // A snapshot-only answer after a completed response has no usable speed.
        this.currentItem = item.id
        this.block = null
        this.pause({ discard: true })
      }
      return
    }

    if (method === 'turn/completed') {
      const items = params.turn?.items
      if (!Array.isArray(items)) return
      const last = items.findLast((item) => item && textTypes.has(item.type))
      if (last && (!validId(last.id) || last.id !== this.currentItem || !this.observedItems.has(last.id))) {
        this.pause({ discard: true })
        this.currentItem = null
        this.block = null
      }
      return
    }

    const isPart = method === 'item/reasoning/summaryPartAdded'
    if (!deltaMethods.has(method) && !isPart) return
    const id = params.itemId
    if (!validId(id) || this.completedItems.has(id)) return
    if (!isPart && (typeof params.delta !== 'string' || !params.delta.length)) return
    this.seenItems.add(id)
    if (this.currentItem !== id) {
      this.currentItem = id
      this.block = null
      this.start()
    }
    const blockMethod = isPart ? 'item/reasoning/summaryTextDelta' : method
    const index = blockMethod === 'item/reasoning/summaryTextDelta' ? params.summaryIndex
      : blockMethod === 'item/reasoning/textDelta' ? params.contentIndex : null
    const block = JSON.stringify([blockMethod, index ?? null])
    if (this.block !== block) {
      this.block = block
      this.startBlock()
    }
    if (!isPart) {
      this.observedItems.add(id)
      this.push(params.delta)
    }
  }
}
