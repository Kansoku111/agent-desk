import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../web/src/styles.css'

const skills = [
  { name: 'alpha', description: 'Alpha', scope: 'user', file: '/alpha', target: '/alpha', root: '.agents/skills', active: true, userInvocable: true, modelInvocable: true },
  { name: 'zeta', description: 'Zeta', scope: 'project', file: '/zeta', target: '/zeta', root: '.agents/skills', active: true, userInvocable: true, modelInvocable: true },
]
let favorites: Record<string, boolean> = {}
let server: any
class Socket {
  static CLOSING = 2
  readyState = 1
  onmessage?: (event: { data: string }) => void
  onopen?: () => void
  constructor() { queueMicrotask(() => this.onopen?.()) }
  send(body: string) {
    const input = JSON.parse(body)
    let result: any = {}
    if (input.type === 'skills.list' || input.type === 'skills.overview') result = { skills }
    if (input.type === 'settings.update') {
      favorites = { ...favorites, ...input.patch.favoriteSkills }
      server.settings.favoriteSkills = { ...favorites }
      store.setState({ server: structuredClone(server) })
      result = { settings: server.settings }
    }
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: input.id, ok: true, result }) }), 0)
  }
}
Object.assign(window, { WebSocket: Socket })
sessionStorage.setItem('agent-desk-token', 'fixture')
const store = await import('../../web/src/store')
const { SkillPicker } = await import('../../web/src/components/SkillPicker')
const { SkillsSettings } = await import('../../web/src/components/settings/SkillsSettings')
const root = createRoot(document.getElementById('root')!)
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 80))
const check = (value: unknown, label: string) => { if (!value) throw new Error(label) }
const click = (selector: string) => { const button = document.querySelector<HTMLButtonElement>(selector); check(button, selector); button!.click() }
const pickerNames = () => [...document.querySelectorAll('.skill-picker-row .menu-label')].map((row) => row.textContent)
const run = async () => {
  favorites = {}
  server = { app: { myPc: '/fixture' }, settings: { favoriteSkills: {}, workspaces: ['/fixture'], lastWorkspace: '/fixture', projectNames: {} } }
  store.setState({ server: structuredClone(server) })
  let selected = ''
  root.render(<><SkillsSettings /><SkillPicker workspace="/fixture" onSelect={(name) => { selected = name }} /></>)
  await tick()
  click('button[aria-label="zeta をお気に入りに追加"]')
  await tick()
  check(document.querySelector('.skill-group h3')?.textContent === 'お気に入り', 'favorite group first in settings')
  check(document.querySelector('.skill-group .skill-title strong')?.textContent === 'zeta', 'favorite first in settings')
  click('button[aria-label="Skills"]')
  await tick()
  check(pickerNames().join(',') === 'zeta,alpha', 'favorite first in picker')
  click('.skill-picker-row button[aria-label="zeta のお気に入りを解除"]')
  await tick()
  check(pickerNames().join(',') === 'alpha,zeta', 'picker updates after removal')
  check(document.querySelector('.skill-group h3')?.textContent !== 'お気に入り', 'settings updates after removal')
  click('.skill-picker-row button[aria-label="zeta をお気に入りに追加"]')
  await tick()
  check(pickerNames().join(',') === 'zeta,alpha', 'picker favorites without selecting')
  check(!selected, 'favorite button does not select the skill')
  click('button[aria-label="Skills"]')
  click('button[aria-label="Skills"]')
  await tick()
  check(pickerNames().join(',') === 'zeta,alpha', 'order survives reopening')
  click('.skill-picker-row .menu-item')
  check(selected === 'zeta', 'select still invokes the chosen name')
  return 'settings and picker favorite, remove, reopen and select passed'
}
Object.assign(window, { skillFavoritesTest: { run } })
store.connect()
