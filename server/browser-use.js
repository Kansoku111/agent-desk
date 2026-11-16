import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const version = '1.0.0'
export const browserUseInstallCommand = `uv tool install browser-use==${version}`

// Only pass OS essentials to the optional tool. In particular, credentials and
// Browser Use's ambient daemon/endpoint settings must not follow the dsh process.
export function browserUseEnv(env = process.env) {
  const allowed = /^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|TEMP|TMP|TMPDIR|LANG|LC_.*)$/
  return {
    ...Object.fromEntries(Object.entries(env).filter(([key]) => allowed.test(key.toUpperCase()))),
    ANONYMIZED_TELEMETRY: 'false',
    PYTHON_DOTENV_DISABLED: '1',
  }
}

export async function findBrowserUse(home) {
  const windows = process.platform === 'win32'
  const name = windows ? 'browser-use.exe' : 'browser-use'
  const override = process.env.AGENT_DESK_BROWSER_USE
  const bins = [
    path.join(home, 'browser-use', windows ? 'Scripts' : 'bin'),
    process.env.UV_TOOL_BIN_DIR,
    ...((process.env.PATH ?? '').split(path.delimiter)),
    path.join(os.homedir(), '.local', 'bin'),
  ]
  const candidates = override ? [override] : bins.filter(dir => dir && path.isAbsolute(dir)).map(dir => path.join(dir, name))
  let found = false
  for (const candidate of new Set(candidates)) {
    if (!path.isAbsolute(candidate)) continue
    try {
      await access(candidate, constants.X_OK)
    } catch {
      continue
    }
    found = true
    try {
      const { stdout } = await run(candidate, ['--version'], {
        cwd: home, env: browserUseEnv(), timeout: 4000, windowsHide: true,
      })
      if (stdout.trim().split(/\s+/).slice(0, 2).join(' ') === `browser-use ${version}`) {
        return { command: candidate, status: 'ready', installCommand: browserUseInstallCommand }
      }
    } catch {}
  }
  return { command: null, status: found ? 'unsupported' : 'missing', installCommand: browserUseInstallCommand }
}
