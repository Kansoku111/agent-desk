// A headless dsh that answers one prompt: the child of a bridged subagent whose
// target is DSH (subagent-bridge.js). Kept apart from the bridge so its only
// dependencies are the dsh binary and its environment.
import { spawn } from 'node:child_process'
import { runtimeHookArgs } from './dsh-compatibility.js'
import { dshBin } from './paths.js'
import { dshEnv } from './dsh-env.js'

const STDERR_TAIL = 4000

/**
 * @param {object} options
 * @param {object} options.paths - appPaths()
 * @param {string} options.workspace
 * @param {string} options.prompt
 * @param {string} options.mode - the child's permission mode (never wider than its parent's)
 * @param {string} options.patchFile - the child's model layer (dsh-config.js dshChildPatch)
 * @param {AbortSignal} [options.signal] - aborting stops the dsh
 * @returns {Promise<string>} what the child printed
 */
export function runDshChild({ paths, workspace, prompt, mode, patchFile, signal }) {
  return new Promise((resolve, reject) => {
    const layers = [paths.homePatch, patchFile].flatMap((file) => ['--patch', file])
    const child = spawn(process.execPath, [...runtimeHookArgs(), dshBin, '--profile', 'headless', ...layers, '--approval-policy', 'never', '-'], {
      cwd: workspace,
      env: dshEnv(paths, mode),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stop = () => child.kill()
    if (signal?.aborted) stop()
    else signal?.addEventListener('abort', stop, { once: true })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = (stderr + chunk).slice(-STDERR_TAIL) })
    child.on('error', reject)
    child.on('close', (code, closeSignal) => {
      signal?.removeEventListener('abort', stop)
      if (code === 0) resolve(stdout.trim() || '(the subagent returned no text)')
      else reject(new Error(closeSignal ? `The subagent was stopped (${closeSignal}).` : `The subagent failed (exit ${code}).\n${stderr.trim()}`))
    })
    child.stdin.end(prompt)
  })
}
