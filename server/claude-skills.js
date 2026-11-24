// The skills Claude Code itself offers as `/name`, for the CL task picker. Claude Code
// has no command that lists them, so its folders are read the way it reads them:
// <claudeHome>/skills/<name>/SKILL.md and the project's .claude/skills. A personal
// skill wins over a project one of the same name (Claude Code's order). Plugin and
// managed skills are not listed; typing their name still works in the terminal.
import fsp from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'yaml'

function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) return {}
  try {
    const meta = parse(match[1])
    return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : null
  } catch {
    return null
  }
}

async function readRoot(root) {
  let entries
  try { entries = await fsp.readdir(root, { withFileTypes: true }) } catch { return [] }
  const found = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || entry.isFile()) continue
    let text
    try { text = await fsp.readFile(path.join(root, entry.name, 'SKILL.md'), 'utf8') } catch { continue }
    const meta = frontmatter(text)
    if (!meta || meta['user-invocable'] === false) continue
    const name = typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : entry.name
    found.push({ name, description: typeof meta.description === 'string' ? meta.description : '' })
  }
  return found
}

export async function listClaudeSkills(workspace, claudeHome) {
  const winners = new Map()
  for (const root of [path.join(claudeHome, 'skills'), path.join(workspace, '.claude', 'skills')]) {
    for (const skill of await readRoot(root)) if (!winners.has(skill.name)) winners.set(skill.name, skill)
  }
  return [...winners.values()].sort((a, b) => a.name.localeCompare(b.name))
}
