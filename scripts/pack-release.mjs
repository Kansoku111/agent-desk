// Packs release/AgentDesk-<version>.zip: the app as an install runs it, UI
// built, without dependencies (npm install fetches them). The release workflow
// (.github/workflows/release.yml) attaches it to the GitHub release, where the
// in-app update finds it (server/app-update.js). Also writes release/notes.md,
// the version's section of CHANGELOG.md.
//   npm run build && node scripts/pack-release.mjs [--tag v<version>]
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const fail = (message) => {
  console.error(`pack-release: ${message}`)
  process.exit(1)
}

const tagAt = process.argv.indexOf('--tag')
const tag = tagAt >= 0 ? process.argv[tagAt + 1] : null
if (tag && tag !== `v${version}`) fail(`tag ${tag} does not match package.json version ${version}`)

const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
const section = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|(?![\\s\\S]))`, 'm').exec(changelog)
if (!section) fail(`CHANGELOG.md has no section for ${version}`)

if (!fs.existsSync(path.join(root, 'web', 'dist', 'index.html'))) fail('web/dist is missing; run npm run build first')

// What an install holds, as the updater (scripts/updater) also ships it.
const ENTRIES = [
  'assets', 'docs', 'scripts', 'server', 'web',
  'AgentDesk.cmd', 'CHANGELOG.md', 'LICENSE', 'README.md', 'README.en.md', 'THIRD_PARTY_NOTICES.md',
  'package.json', 'package-lock.json',
]
// Sources of the updater exe, not part of the app.
const LEFT_OUT = [path.join('scripts', 'updater')]

const release = path.join(root, 'release')
const stage = path.join(release, 'stage')
const app = path.join(stage, 'AgentDesk')
fs.rmSync(stage, { recursive: true, force: true })
fs.mkdirSync(app, { recursive: true })
for (const entry of ENTRIES) {
  fs.cpSync(path.join(root, entry), path.join(app, entry), {
    recursive: true,
    preserveTimestamps: true,
    filter: (source) => !LEFT_OUT.includes(path.relative(root, source)),
  })
}

const zip = path.join(release, `AgentDesk-${version}.zip`)
fs.rmSync(zip, { force: true })
if (process.platform === 'win32') {
  // bsdtar (Windows 10 and later) writes a zip when the name ends in .zip.
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  execFileSync(tar, ['-a', '-c', '-f', zip, '-C', stage, 'AgentDesk'], { stdio: 'inherit' })
} else {
  execFileSync('zip', ['-q', '-r', zip, 'AgentDesk'], { cwd: stage, stdio: 'inherit' })
}
fs.rmSync(stage, { recursive: true, force: true })

fs.writeFileSync(path.join(release, 'notes.md'), section[1].trim() + '\n')
console.log(`${zip} (${(fs.statSync(zip).size / 1024 / 1024).toFixed(1)} MB)`)
