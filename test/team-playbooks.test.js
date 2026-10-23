import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeTeamConfig, teamConfig } from '../server/team-config.js'
import { planSettingsUpdate, DEFAULT_SETTINGS } from '../server/settings.js'
import { parsePlaybooks, parsePolicies, POLICY_MAX, readPlaybook } from '../server/team-playbooks.js'

test('policies and playbooks are saved trimmed, with an id each', () => {
  const [policy] = parsePolicies([{ name: ' 節約 ', text: ' 低枠を使う \n' }])
  assert.equal(policy.name, '節約')
  assert.equal(policy.text, '低枠を使う')
  assert.match(policy.id, /^[A-Za-z0-9-]+$/)
  assert.equal(parsePolicies([{ id: 'keep-1', name: 'A', text: '' }])[0].id, 'keep-1')
  const [playbook] = parsePlaybooks([{ id: 'b1', name: '大改修', description: '大きな改修', body: '手順' }])
  assert.deepEqual(playbook, { id: 'b1', name: '大改修', description: '大きな改修', body: '手順' })
})

test('a policy or playbook needs a unique name and stays within its limits', () => {
  assert.throws(() => parsePolicies([{ name: '', text: 'x' }]), /名前を入力/)
  assert.throws(() => parsePolicies([{ name: 'A', text: '' }, { name: 'a', text: '' }]), /重複/)
  assert.throws(() => parsePolicies([{ name: 'A', text: 'x'.repeat(POLICY_MAX + 1) }]), /文字まで/)
  assert.throws(() => parsePlaybooks('x'), /配列/)
})

test('settings.update saves the policies and playbooks', () => {
  const { settings } = planSettingsUpdate(structuredClone(DEFAULT_SETTINGS), {
    teamGuidesBase: { teamPolicies: [], teamPlaybooks: [] },
    teamPolicies: [{ id: 'p1', name: 'Claude中心', text: '設計は Claude' }],
    teamPlaybooks: [{ id: 'b1', name: '調査', description: '', body: '分け方' }],
  }, Date.now())
  assert.equal(settings.teamPolicies[0].name, 'Claude中心')
  assert.equal(settings.teamPlaybooks[0].body, '分け方')
  assert.deepEqual(DEFAULT_SETTINGS.teamPolicies, [])
})

test('a team remembers the policy it started with', () => {
  assert.equal(teamConfig({}).policy, null)
  assert.equal(mergeTeamConfig({}, { policy: 'p1' }).policy, 'p1')
  assert.equal(mergeTeamConfig({ policy: 'p1' }, { policy: null }).policy, null)
  assert.throws(() => mergeTeamConfig({}, { policy: 'no spaces' }), /方針/)
})

test('the playbook tool answers with the body, or the names there are', () => {
  const playbooks = [{ id: 'b1', name: '大改修', description: '', body: '手順' }]
  assert.equal(readPlaybook(playbooks, ' 大改修 '), '# Playbook: 大改修\n\n手順')
  assert.equal(readPlaybook(playbooks, '調査'), 'No playbook named "調査". Playbooks: "大改修"')
  assert.equal(readPlaybook([], 'x'), 'The user has no playbooks.')
})

test('a name is kept on one line, and a repeated id gets a new one', () => {
  assert.equal(parsePlaybooks([{ name: '大改修\n## 追加', description: '', body: '' }])[0].name, '大改修 ## 追加')
  const [first, second] = parsePolicies([{ id: 'same', name: 'A', text: '' }, { id: 'same', name: 'B', text: '' }])
  assert.equal(first.id, 'same')
  assert.notEqual(second.id, 'same')
})
