import { describe, expect, test } from 'bun:test'
import { currentOf, initial, keyOf, reduce, stepOf, type Snapshot, type State } from '../src/state'
import { switcher } from '../src/views/page'

const snap = (id: string, project: string): Snapshot => ({
  v: 1,
  session: { id, account: 'macleod', project, busy: false },
  at: 0,
  streams: [],
  status: [],
  limits: [],
  updates: [],
  permissions: [],
})

const withProjects = (...projects: string[]): State =>
  projects.reduce((s, p, i) => reduce(s, { type: 'snapshot', room: 'r', snapshot: snap(`s${i}`, p), now: 0 }), initial())

describe('switching project from the header', () => {
  test('a swipe steps to the next or previous session and wraps round, so every project is a swipe away', () => {
    let s = withProjects('claudeflow', 'tensorlot', 'vault')
    expect(stepOf(s, 0, 1)).toBe(keyOf('r', 's1'))
    expect(stepOf(s, 0, -1)).toBe(keyOf('r', 's2'))
    s = reduce(s, { type: 'choose', key: stepOf(s, 0, -1)! })
    expect(stepOf(s, 0, 1)).toBe(keyOf('r', 's0'))
  })

  test('with one session there is nothing to switch to: the header is just its project name', () => {
    const s = withProjects('claudeflow')
    expect(stepOf(s, 0, 1)).toBe(undefined)
    expect(switcher(s, 0)).toBe('claudeflow')
  })

  test('the header names the shown project, and holding it lists every session to jump to', () => {
    let s = withProjects('claudeflow', 'tensorlot')
    expect(switcher(s, 0)).toContain('claudeflow')
    expect(switcher(s, 0)).not.toContain('switch-menu')
    s = reduce(s, { type: 'switch', open: true })
    const menu = switcher(s, 0)
    expect(menu).toContain(`data-session="${keyOf('r', 's1')}"`)
    expect(menu).toContain('tensorlot')
  })

  test('choosing a session from the list shows it and closes the list', () => {
    let s = reduce(withProjects('claudeflow', 'tensorlot'), { type: 'switch', open: true })
    s = reduce(s, { type: 'choose', key: keyOf('r', 's1') })
    expect(currentOf(s, 0)?.snapshot.session.project).toBe('tensorlot')
    expect(s.isSwitchOpen).toBe(false)
  })
})
