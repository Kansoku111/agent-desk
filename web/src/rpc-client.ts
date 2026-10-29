// Request/reply bookkeeping is owned by one socket generation. A stale close
// or reply must never settle requests belonging to its replacement.
export class TransportError extends Error {
  readonly code = 'CONNECTION_LOST'
}

export class RequestError extends Error {
  readonly code = 'REQUEST_REJECTED'
}

/** Explain an older server when a newer UI calls an unavailable action. */
export function requestErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.startsWith('unknown request:')
    ? 'Agent Desk が古いまま動いています。作業が終わってから Agent Desk を起動し直してください。'
    : message
}

type Socket = { readyState: number; send(data: string): void }
type Pending = {
  resolve(value: unknown): void
  reject(error: Error): void
  timer?: ReturnType<typeof setTimeout>
}

export class RpcClient {
  private socket: Socket | null = null
  private sequence = 0
  private pending = new Map<number, Pending>()

  attach(socket: Socket) {
    if (this.socket === socket) return
    this.rejectAll(new TransportError('接続が切り替わりました'))
    this.socket = socket
  }

  detach(socket: Socket) {
    if (this.socket !== socket) return
    this.socket = null
    this.rejectAll(new TransportError('接続が切れました'))
  }

  request<T = unknown>(type: string, params: Record<string, unknown> = {}, timeoutMs = 0): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== 1) {
        reject(new TransportError('サーバーに接続していません'))
        return
      }
      const id = ++this.sequence
      const entry: Pending = { resolve: (value) => resolve(value as T), reject }
      this.pending.set(id, entry)
      if (timeoutMs > 0) entry.timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new TransportError('受領の確認がタイムアウトしました。再接続後に確認します'))
      }, timeoutMs)
      try {
        this.socket.send(JSON.stringify({ ...params, id, type }))
      } catch {
        this.pending.delete(id)
        clearTimeout(entry.timer)
        reject(new TransportError('送信中に接続が切れました'))
      }
    })
  }

  /** Returns true for reply frames, including late replies whose request timed out. */
  receive(frame: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown }, socket: Socket) {
    if (this.socket !== socket || typeof frame.id !== 'number') return false
    const entry = this.pending.get(frame.id)
    if (entry) {
      this.pending.delete(frame.id)
      clearTimeout(entry.timer)
      if (frame.ok === true) entry.resolve(frame.result)
      else entry.reject(new RequestError(typeof frame.error === 'string' ? frame.error : 'リクエストに失敗しました'))
    }
    return true
  }

  private rejectAll(error: Error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }
}
