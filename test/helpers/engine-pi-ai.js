// pi-ai's retry check from the copy the installed dsh runs, which is where
// retry-hook.js takes it from: dsh-llm-pi-ai nests its own pi-ai when the app's
// is another version, and the two lists of transient failures differ.
import { createRequire, findPackageJSON } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dsh = createRequire(path.join(root, 'node_modules/@deepseek-ai/dsh/package.json'))
const manifest = findPackageJSON('@earendil-works/pi-ai', pathToFileURL(dsh.resolve('@deepseek-ai/dsh-llm-pi-ai')))

export const { isRetryableAssistantError } = await import(pathToFileURL(path.join(path.dirname(manifest), 'dist/utils/retry.js')).href)
