type Delivery = {
  /** Asks the server to paste the message and press Enter; rejects when it could not be handed over. */
  send(text: string): Promise<unknown>
  /** The field's text now, which may have grown while the message was on its way. */
  read(): string
  clear(): void
  fail(message: string): void
}

/**
 * Sends a message to Claude Code. The field is emptied only once the server took
 * the message, and only if nothing new was typed meanwhile; on a failure (offline,
 * rejected) the text stays and the reason is shown.
 */
export async function sendTerminalMessage(delivery: Delivery, text: string): Promise<boolean> {
  try {
    // A server from before an update answers null even when it sent the message: only a rejection is a failure.
    await delivery.send(text)
  } catch (error) {
    delivery.fail(error instanceof Error ? error.message : String(error))
    return false
  }
  if (text && delivery.read() === text) delivery.clear()
  return true
}
