// Operating-system integration: native folder picker, "open in" actions,
// git status for the header, and the app window. Every external program is
// started with an argument array, never through a shell string.
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'

/** Opens a URL in the user's default browser. */
export function openExternal(url) {
  if (!/^https?:\/\//i.test(url)) return
  if (isWin) {
    // rundll32 avoids cmd.exe parsing of `&` in OAuth URLs.
    spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref()
  } else {
    spawn(isMac ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
  }
}

let picking = null

/**
 * Asks the user for a folder with the platform's own picker. While one
 * picker is open, another request waits for it instead of opening a second.
 * @param {{ title?: string, initial?: string | null }} [options]
 * @returns {Promise<string | null>} the folder, or null when cancelled.
 */
export function pickFolder(options) {
  picking ??= showFolderPicker(options).finally(() => {
    picking = null
  })
  return picking
}

async function showFolderPicker({ title = 'フォルダーを選択', initial = null } = {}) {
  try {
    if (isWin) {
      // The Explorer-style "Select Folder" dialog (see pick-folder.ps1).
      const script = fileURLToPath(new URL('./pick-folder.ps1', import.meta.url))
      const { stdout } = await run('powershell.exe', [
        '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script,
        '-Title', title,
        '-Initial', initial ?? '',
        '-OkLabel', 'フォルダーの選択',
      ], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 10 * 60_000,
      })
      return stdout.trim() || null
    }
    if (isMac) {
      const { stdout } = await run('osascript', ['-e', `POSIX path of (choose folder with prompt ${JSON.stringify(title)})`])
      return stdout.trim().replace(/\/$/, '') || null
    }
    const { stdout } = await run('zenity', ['--file-selection', '--directory', `--title=${title}`, ...(initial ? [`--filename=${initial}/`] : [])])
    return stdout.trim() || null
  } catch {
    return null
  }
}

function findWindowsTerminal() {
  if (!isWin || !process.env.LOCALAPPDATA) return null
  const candidate = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'wt.exe')
  return fs.existsSync(candidate) ? candidate : null
}

/** Which "open in" targets exist on this machine. */
export function openTargets() {
  return {
    files: true,
    terminal: isWin || isMac,
  }
}

export async function openIn(target, dir) {
  if (!fs.existsSync(dir)) throw new Error(`フォルダが見つかりません: ${dir}`)
  const detached = { detached: true, stdio: 'ignore' }
  if (target === 'files') {
    if (isWin) spawn('explorer.exe', [dir], detached).unref()
    else spawn(isMac ? 'open' : 'xdg-open', [dir], detached).unref()
    return
  }
  if (target === 'terminal') {
    if (isWin) {
      const wt = findWindowsTerminal()
      if (wt) {
        spawn(wt, ['-d', dir], detached).unref()
      } else {
        spawn('powershell.exe', ['-NoExit', '-Command', 'Set-Location -LiteralPath $env:AGENT_DESK_DIR'], {
          ...detached,
          env: { ...process.env, AGENT_DESK_DIR: dir },
        }).unref()
      }
      return
    }
    if (isMac) {
      spawn('open', ['-a', 'Terminal', dir], detached).unref()
      return
    }
  }
  throw new Error('この環境では開けません')
}

/**
 * Opens one file or folder.
 * @param {string} file - an existing absolute path.
 * @param {'open' | 'reveal'} how - the default app, or the file's place in Explorer/Finder.
 */
export function openFile(file, how) {
  const detached = { detached: true, stdio: 'ignore' }
  if (how === 'reveal') {
    if (isWin) {
      // explorer.exe parses its own command line: /select,"<path>" must reach it verbatim.
      spawn('explorer.exe', [`/select,"${file}"`], { ...detached, windowsVerbatimArguments: true }).unref()
    } else if (isMac) {
      spawn('open', ['-R', file], detached).unref()
    } else {
      spawn('xdg-open', [path.dirname(file)], detached).unref()
    }
    return
  }
  if (isWin) spawn('explorer.exe', [file], detached).unref()
  else spawn(isMac ? 'open' : 'xdg-open', [file], detached).unref()
}

/** Current branch and number of changed files, or null outside a git repo. */
export async function gitInfo(dir) {
  try {
    const options = { cwd: dir, windowsHide: true, timeout: 4000 }
    const [{ stdout: branch }, { stdout: status }] = await Promise.all([
      run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], options),
      run('git', ['status', '--porcelain'], options),
    ])
    return { branch: branch.trim(), changes: status.split('\n').filter(Boolean).length }
  } catch {
    return null
  }
}

/**
 * An installed Chromium browser. The app window prefers Edge (always present
 * on Windows); the agent's browser tool prefers Chrome.
 */
export function findChromium({ preferChrome = false } = {}) {
  const found = chromiumCandidates().filter(Boolean).filter((candidate) => fs.existsSync(candidate))
  if (preferChrome) return found.find((candidate) => /chrome/i.test(path.basename(candidate))) ?? found[0] ?? null
  return found[0] ?? null
}

function chromiumCandidates() {
  return isWin
    ? [
        process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]
    : isMac
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge']
}

/**
 * Opens the UI as a standalone app window (Edge/Chrome `--app` mode with its
 * own profile), falling back to the default browser.
 * @returns {import('node:child_process').ChildProcess | null}
 */
export function openAppWindow(url, profileDir) {
  const browser = findChromium()
  if (!browser) {
    openExternal(url)
    return null
  }
  const child = spawn(browser, [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    '--window-size=1320,880',
    '--no-first-run',
    '--no-default-browser-check',
  ], { detached: true, stdio: 'ignore' })
  child.unref()
  return child
}
