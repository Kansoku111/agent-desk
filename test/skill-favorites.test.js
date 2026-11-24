import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import ts from 'typescript'
import { listClaudeSkills } from '../server/claude-skills.js'
import { DEFAULT_SETTINGS, migrateSettings, planSettingsUpdate } from '../server/settings.js'

const update = (current, patch) => planSettingsUpdate(current, patch, 0).settings

test('starred skills migrate to the ordered button list, keeping the first five', () => {
  assert.deepEqual(migrateSettings({}).skillButtons, [])
  assert.deepEqual(DEFAULT_SETTINGS.skillButtons, [])
  const legacy = migrateSettings({ favoriteSkills: { a: true, b: true, c: true, d: true, e: true, f: true } })
  assert.deepEqual(legacy.skillButtons, ['a', 'b', 'c', 'd', 'e'])
  // A save that already has the list keeps it as it is.
  assert.deepEqual(migrateSettings({ skillButtons: ['z'], favoriteSkills: { a: true } }).skillButtons, ['z'])
})

test('the button list is replaced in order, mirrored for older readers, and validated', () => {
  const initial = migrateSettings({})
  const next = update(initial, { skillButtons: ['zeta', 'alpha'] })
  assert.deepEqual(next.skillButtons, ['zeta', 'alpha'])
  assert.deepEqual(next.favoriteSkills, { zeta: true, alpha: true })
  assert.deepEqual(update(next, { skillButtons: ['alpha', 'zeta'] }).skillButtons, ['alpha', 'zeta'])
  assert.deepEqual(migrateSettings(JSON.parse(JSON.stringify(next))).skillButtons, ['zeta', 'alpha'])
  for (const skillButtons of [null, {}, [''], [' '], [1], ['a', 'a'], ['x'.repeat(1001)], ['a', 'b', 'c', 'd', 'e', 'f']]) {
    assert.throws(() => update(initial, { skillButtons }))
  }
  assert.deepEqual(initial.skillButtons, [])
})

test('name toggles from an older page add at the end, remove, and respect the limit', () => {
  const initial = migrateSettings({})
  const first = update(initial, { favoriteSkills: { zeta: true } })
  const second = update(first, { favoriteSkills: { alpha: true } })
  assert.deepEqual(second.skillButtons, ['zeta', 'alpha'])
  assert.deepEqual(update(second, { favoriteSkills: { zeta: false } }).skillButtons, ['alpha'])
  const full = update(initial, { skillButtons: ['a', 'b', 'c', 'd', 'e'] })
  assert.throws(() => update(full, { favoriteSkills: { f: true } }), /5個まで/)
  for (const patch of [null, [], { '': true }, { skill: 'yes' }]) assert.throws(() => update(initial, { favoriteSkills: patch }))
  const special = update(initial, { favoriteSkills: JSON.parse('{"__proto__":true}') })
  assert.deepEqual(special.skillButtons, ['__proto__'])
  assert.equal(Object.hasOwn(special.favoriteSkills, '__proto__'), true)
})

test('Claude Code skills come from its own folders, personal ones first', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-skills-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const home = path.join(dir, 'home'), workspace = path.join(dir, 'project')
  const skill = async (root, folder, body) => {
    await fs.mkdir(path.join(root, folder), { recursive: true })
    await fs.writeFile(path.join(root, folder, 'SKILL.md'), body)
  }
  await skill(path.join(home, 'skills'), 'shared', '---\nname: shared\ndescription: personal\n---\nbody')
  await skill(path.join(workspace, '.claude', 'skills'), 'shared', '---\nname: shared\ndescription: project\n---\nbody')
  await skill(path.join(workspace, '.claude', 'skills'), 'review', '---\nname: code-review-local\ndescription: Review\n---\n')
  await skill(path.join(workspace, '.claude', 'skills'), 'plain', 'No frontmatter')
  await skill(path.join(workspace, '.claude', 'skills'), 'auto', '---\nname: auto\nuser-invocable: false\n---\n')
  await skill(path.join(workspace, '.claude', 'skills'), 'broken', '---\nname: [\n---\n')
  await skill(path.join(workspace, '.claude', 'skills'), '.hidden', '---\nname: hidden\n---\n')
  assert.deepEqual(await listClaudeSkills(workspace, home), [
    { name: 'code-review-local', description: 'Review' },
    { name: 'plain', description: '' },
    { name: 'shared', description: 'personal' },
  ])
  assert.deepEqual(await listClaudeSkills(path.join(dir, 'missing'), path.join(dir, 'none')), [])
})

const source = await fs.readFile(new URL('../web/src/components/SkillPicker.tsx', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } })
const picker = {}
new Function('require', 'exports', outputText)(() => ({}), picker)

test('each kind of task gets the skill in the form its agent reads', () => {
  const { insertSkill } = picker
  assert.deepEqual(insertSkill('dsh', 'fix this', 3, 3, 'review'), { text: 'fix /review this', caret: 11 })
  assert.deepEqual(insertSkill('codex', 'fix', 3, 3, 'review'), { text: 'fix $review ', caret: 12 })
  assert.deepEqual(insertSkill('codex', '', 0, 0, 'review'), { text: '$review ', caret: 8 })
  // Claude Code runs a command only at the start; a leading skill is swapped, other text stays.
  assert.deepEqual(insertSkill('claude', 'please check', 6, 6, 'review'), { text: '/review please check', caret: 8 })
  assert.deepEqual(insertSkill('claude', '/old please', 0, 0, 'review', ['old', 'review']), { text: '/review please', caret: 8 })
  assert.deepEqual(insertSkill('claude', '/usr/bin is odd', 0, 0, 'review', ['review']), { text: '/review /usr/bin is odd', caret: 8 })
})
