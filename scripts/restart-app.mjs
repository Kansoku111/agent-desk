// Starts Agent Desk again once the server that asked for it has exited, on that
// server's port and token (server/app-restart.js). scripts/launch.mjs does the
// start: dependencies, a build when sources changed, then the server.
// Its log is <data folder>/app-update/restart.log.
//   node restart-app.mjs <restart-plan.json>
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { systemSteps, waitForExit } from './apply-update.mjs'

export async function main(planFile) {
  const plan = JSON.parse(await fsp.readFile(planFile, 'utf8'))
  // It holds the window token; nothing needs it once read.
  await fsp.rm(planFile, { force: true })
  await fsp.writeFile(plan.files.restartLog, `[${new Date().toISOString()}] restarting from ${plan.root}\n`)
  const log = (line) => fs.appendFileSync(plan.files.restartLog, `${line}\n`)
  try {
    await waitForExit(plan.pid, { log })
    await systemSteps(log).launch(plan)
    log('done')
  } catch (error) {
    log(`restart failed: ${error.message}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv[2])
}
