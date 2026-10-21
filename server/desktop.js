// Pure parts of the desktop tool: key names and the mapping between
// screenshot pixels and physical screen pixels. desktop-mcp.js does the I/O.

/** Screenshots are scaled down to fit this box (never up), which keeps image tokens near ~1.2K. */
export const VIEW_MAX = { width: 1280, height: 800 }

/** The size a display's screenshot is sent at, and its scale from physical pixels. */
export function viewFor(display, max = VIEW_MAX) {
  const scale = Math.min(1, max.width / display.width, max.height / display.height)
  return {
    width: Math.max(1, Math.round(display.width * scale)),
    height: Math.max(1, Math.round(display.height * scale)),
  }
}

/** Physical screen pixel for a point in a display's screenshot; throws when it lies outside the image. */
export function toScreen(display, x, y) {
  const view = viewFor(display)
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x と y は数値で指定してください')
  if (x < 0 || y < 0 || x >= view.width || y >= view.height) {
    throw new Error(`(${x}, ${y}) はスクリーンショットの範囲外です（幅 ${view.width}、高さ ${view.height}）`)
  }
  return {
    x: display.x + Math.min(display.width - 1, Math.round(x * display.width / view.width)),
    y: display.y + Math.min(display.height - 1, Math.round(y * display.height / view.height)),
  }
}

/** A physical screen point in a display's screenshot pixels. */
export function toView(display, x, y) {
  const view = viewFor(display)
  return {
    x: Math.round((x - display.x) * view.width / display.width),
    y: Math.round((y - display.y) * view.height / display.height),
  }
}

/** The display holding a rectangle's center, else the nearest one. */
export function displayFor(displays, rect) {
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  let best = displays[0]
  let bestDistance = Infinity
  for (const display of displays) {
    const dx = Math.max(display.x - cx, 0, cx - (display.x + display.width))
    const dy = Math.max(display.y - cy, 0, cy - (display.y + display.height))
    const distance = dx * dx + dy * dy
    if (distance < bestDistance) {
      best = display
      bestDistance = distance
    }
  }
  return best
}

const F_KEYS = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`f${i + 1}`, 0x70 + i]))

/** Windows virtual-key codes by name; single letters and digits are handled separately. */
export const KEY_CODES = {
  ctrl: 0x11, control: 0x11,
  shift: 0x10,
  alt: 0x12, option: 0x12,
  win: 0x5b, windows: 0x5b, super: 0x5b, meta: 0x5b, cmd: 0x5b, command: 0x5b,
  enter: 0x0d, return: 0x0d,
  esc: 0x1b, escape: 0x1b,
  tab: 0x09,
  space: 0x20,
  backspace: 0x08,
  delete: 0x2e, del: 0x2e,
  insert: 0x2d, ins: 0x2d,
  home: 0x24, end: 0x23,
  pageup: 0x21, pgup: 0x21, pagedown: 0x22, pgdn: 0x22,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  arrowup: 0x26, arrowdown: 0x28, arrowleft: 0x25, arrowright: 0x27,
  printscreen: 0x2c, prtsc: 0x2c,
  capslock: 0x14, numlock: 0x90, scrolllock: 0x91, pause: 0x13,
  menu: 0x5d, apps: 0x5d, contextmenu: 0x5d,
  volumeup: 0xaf, volumedown: 0xae, volumemute: 0xad,
  // Japanese keyboard: 半角/全角 toggles the IME, 変換, 無変換.
  kanji: 0x19, hankaku: 0x19, zenkaku: 0x19, henkan: 0x1c, convert: 0x1c, muhenkan: 0x1d, nonconvert: 0x1d,
  plus: '+', minus: '-',
  ...F_KEYS,
}

/**
 * Parses "ctrl+shift+t" or a space-separated sequence ("ctrl+a ctrl+c") into combos.
 * Each key is a virtual-key number, or a one-character string the keyboard layout must resolve.
 */
export function parseKeys(spec) {
  const text = String(spec ?? '').trim()
  if (!text) throw new Error('keys を指定してください（例: "ctrl+s"、"alt+tab"、"enter"）')
  return text.split(/\s+/).map((combo) => {
    // A "+" right before the end (or alone) is the plus key itself: "ctrl++".
    const parts = combo.split(/\+(?!$)/)
    return parts.map((part) => {
      const lower = part.toLowerCase()
      const named = KEY_CODES[lower]
      if (named !== undefined) return named
      if (/^[a-z]$/.test(lower)) return lower.toUpperCase().charCodeAt(0)
      if (/^[0-9]$/.test(lower)) return lower.charCodeAt(0)
      if ([...part].length === 1) return part
      throw new Error(`知らないキー名です: "${part}"`)
    })
  })
}
