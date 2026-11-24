import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../web/src/styles.css'

const skills = [
  { name: 'alpha', description: 'Alpha', scope: 'user', file: '/alpha', target: '/alpha', root: '.agents/skills', active: true, userInvocable: true, modelInvocable: true },
  { name: 'zeta', description: 'Zeta', scope: 'project', file: '/zeta', target: '/zeta', root: '.agents/skills', active: true, userInvocable: true, modelInvocable: true },
  ...[0, 1, 2, 3].map((i) => ({ name: `skill${i}`, description: 'More', scope: 'user', file: `/s${i}`, target: `/s${i}`, root: '.agents/skills', active: true, userInvocable: true, modelInvocable: true })),
]
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
      if (input.patch.skillButtons) server.settings.skillButtons = [...input.patch.skillButtons]
      for (const [name, on] of Object.entries(input.patch.favoriteSkills ?? {})) {
        const list = server.settings.skillButtons.filter((entry: string) => entry !== name)
        server.settings.skillButtons = on ? [...server.settings.skillButtons.filter((entry: string) => entry !== name), name] : list
      }
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
const pointer = (target: Element, type: string, clientX: number) =>
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: 'touch', clientX, clientY: 10 }))
const run = async () => {
  server = { app: { myPc: '/fixture' }, settings: { skillButtons: [], workspaces: ['/fixture'], lastWorkspace: '/fixture', projectNames: {} } }
  store.setState({ server: structuredClone(server) })
  localStorage.removeItem('agent-desk.skill-button')
  let selected = ''
  root.render(<><SkillsSettings /><SkillPicker source={{ kind: 'dsh', workspace: '/fixture' }} onSelect={(name) => { selected = name }} /></>)
  await tick()
  check(document.querySelector('button[aria-label="Skills"]'), 'plain list button without favorites')
  click('button[aria-label="zeta をお気に入りに追加"]')
  await tick()
  check(document.querySelector('.skill-group h3')?.textContent?.startsWith('お気に入り'), 'favorite group first in settings')
  check(document.querySelector('.skill-group .skill-title strong')?.textContent === 'zeta', 'favorite first in settings')
  click('button[aria-label="zeta を入力"]')
  check(selected === 'zeta', 'one favorite: a tap puts it in')
  click('button[aria-label="Skills の一覧"]')
  await tick()
  check(pickerNames().slice(0, 2).join(',') === 'zeta,alpha', 'favorite first in picker')
  click('.skill-picker-row button[aria-label="alpha をお気に入りに追加"]')
  await tick()
  check(!document.querySelector('.skill-picker-row button[aria-label="alpha を入力"]'), 'favorite button does not select the skill')
  click('button[aria-label="Skills の一覧"]')
  await tick()
  check(document.querySelectorAll('.skill-dots b').length === 2, 'two favorites show the slide dots')
  selected = ''
  const chip = document.querySelector('.skill-current')!
  pointer(chip, 'pointerdown', 100)
  pointer(chip, 'pointermove', 150)
  await tick()
  check(document.querySelector('.skill-slider .on')?.textContent === 'alpha', 'sliding right highlights the next favorite')
  pointer(chip, 'pointerup', 150)
  ;(chip as HTMLButtonElement).click()
  await tick()
  check(selected === 'alpha', 'letting go puts in the highlighted favorite, once')
  check(!document.querySelector('.skill-slider'), 'strip closes after letting go')
  selected = ''
  click('button[aria-label="alpha を入力"]')
  check(selected === 'alpha', 'a tap puts in the last chosen favorite')
  const grip = document.querySelector<HTMLButtonElement>('button[aria-label="alpha の順番を変える（上下キー）"]')!
  grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  await tick()
  check(server.settings.skillButtons.join(',') === 'alpha,zeta', 'settings reorder the favorites')
  for (let i = 0; i < 3; i++) click(`button[aria-label="skill${i} をお気に入りに追加"]`)
  await tick()
  check(document.querySelector<HTMLButtonElement>('button[aria-label="お気に入りは5個までです"]')?.disabled, 'a sixth favorite is refused')
  return 'favorites, slide, reorder and limit passed'
}
Object.assign(window, { skillFavoritesTest: { run } })
store.connect()
