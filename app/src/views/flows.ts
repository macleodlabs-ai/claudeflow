// Workflow runs and loops on a stream's card: the subline and progress line, the phase list (GitHub Actions style,
// failures pinned on top), a loop's details, the stream's Stop / Run now buttons, and the sticky summary.
// The snapshot carries times, never running clocks (the free plan's polling budget): every clock is counted here.
import { isArmed, type Snapshot, type State } from '../state'
import { clock, clockOf, esc, STATE_COLOR, timeOfDay, type Stream } from './util'

type Run = NonNullable<Stream['workflow']>
type Phase = Run['phases'][number]
type Agent = NonNullable<Phase['agents']>[number]
type Loop = NonNullable<Stream['loop']>

const WORD: Record<string, string> = { running: 'running', completed: 'done', failed: 'failed', killed: 'stopped' }
const finished = (p: Phase) => p.done + p.err
const total = (w: Run) => w.agents.run + w.agents.done + w.agents.err

/** The phase a run is in: the first with agents still going, else the last that had any. */
export const phaseNow = (w: Run): Phase | undefined =>
  w.phases.find(p => p.total > 0 && finished(p) < p.total) ?? [...w.phases].reverse().find(p => p.total > 0) ?? w.phases[0]

/**
 * `Verify · 11/16 · ✗1`: where the run is, how many agents are done, what broke. Done never counts the failed, as
 * in the phase rows, so the card and its phases agree. `≈` while the counts are only what the session saw.
 */
export function runSub(w: Run): string {
  const where = w.status === 'running' ? (phaseNow(w)?.title ?? 'starting') : (WORD[w.status] ?? 'ended')
  return [where, `${w.inferred ? '≈' : ''}${w.agents.done}/${total(w)}`, w.agents.err ? `✗${w.agents.err}` : ''].filter(Boolean).join(' · ')
}

/**
 * `in 4:10 · 3 quiet · ✓ 12:04`: how long until it fires, how long it has found nothing, when something last
 * changed. A countdown always reads `in m:ss` and a time of day is bare `HH:MM`, so the two never look alike.
 */
export function loopSub(l: Loop, now: number): string {
  const when = l.kind === 'monitor' ? 'watching' : l.nextAt !== undefined ? `in ${clockOf(Math.max(0, l.nextAt - now))}` : 'armed'
  return [when, l.noopStreak > 0 ? `${l.noopStreak} quiet` : '', l.lastChange ? `✓ ${timeOfDay(l.lastChange.at)}` : ''].filter(Boolean).join(' · ')
}

/** A card's line for its run (while it runs, or when there is no loop) or its loop; undefined for a plain stream. */
export function flowSub(x: Stream, now: number): string | undefined {
  if (x.workflow && (x.workflow.status === 'running' || !x.loop)) return runSub(x.workflow)
  return x.loop ? loopSub(x.loop, now) : undefined
}

/** The run's progress as a line in the stream's colour, failures in the error colour at its end. */
export function progress(w: Run): string {
  const n = total(w)
  const pct = (k: number) => (n ? Math.round((k / n) * 1000) / 10 : 0)
  return `<div class="prog" role="progressbar" aria-label="${esc(w.name)} agents finished" aria-valuemin="0" aria-valuemax="${n}" aria-valuenow="${w.agents.done + w.agents.err}">
    <i class="ok" style="width:${pct(w.agents.done)}%"></i><i class="bad" style="width:${pct(w.agents.err)}%"></i></div>`
}

/** A verdict as a status pill: pass-like reads done, fail-like reads error, anything else neutral. */
const verdictKind = (v: string) =>
  /^(pass|passed|ok|confirmed|approved|true|yes)$/i.test(v) ? 'done' : /^(fail|failed|refuted|rejected|false|no|error)$/i.test(v) ? 'error' : 'idle'
const pill = (kind: string, text: string) => `<span class="badge bg-${kind} k-${kind}">${esc(text)}</span>`

function agentRow(a: Agent, now: number, phase?: string): string {
  const took = clock((Number(a.endedAt) || now) - (Number(a.startedAt) || now))
  // The label gets the width; tools and time sit under it, so a phone never squeezes the label to a word a line.
  return `<div class="agent"><span class="dot" style="background:${STATE_COLOR[a.status] ?? 'var(--text-faint)'}"></span>
    <div class="what"><div>${esc(a.label ?? a.id)}</div><div class="last">${phase ? `${esc(phase)} · ` : ''}${Number(a.tools) || 0} tools · ${took}</div></div>
    ${a.verdict ? pill(verdictKind(a.verdict), a.verdict) : ''}</div>`
}

const phaseKind = (p: Phase) => (p.total === 0 ? 'idle' : finished(p) < p.total ? 'running' : p.err ? 'error' : 'done')

/** A phase is open by default while it runs or when it failed; a tap flips that (its key in `open`). */
export const isPhaseOpen = (s: State, key: string, p: Phase): boolean => (p.err > 0 || phaseKind(p) === 'running') !== s.open.includes(key)

function phaseRow(s: State, key: string, p: Phase, now: number): string {
  const pkey = `${key}|phase|${p.title}`
  const kind = phaseKind(p)
  const agents = p.agents ?? []
  const canOpen = agents.length > 0
  const isOpen = canOpen && isPhaseOpen(s, pkey, p)
  const verdicts = Object.entries(p.verdicts ?? {}).map(([v, n]) => pill(verdictKind(v), `${v} ${n}`)).join('')
  const act = canOpen ? `data-phase="${esc(pkey)}" role="button" tabindex="0" aria-expanded="${isOpen}"` : ''
  const more = p.total > agents.length && isOpen ? `<div class="meta">+${p.total - agents.length} more</div>` : ''
  return `<div class="phase ${isOpen ? 'open' : ''}"><div class="ph-head" ${act}>
      <span class="pdot ${kind === 'running' ? 'live' : ''}" style="background:${STATE_COLOR[kind]}"></span>
      <span class="ph-title">${esc(p.title)}</span><span class="meta">${p.total ? `${p.done}/${p.total}` : 'not started'}</span>
      ${p.err ? pill('error', `✗ ${p.err}`) : ''}${verdicts}<span class="grow"></span>${canOpen ? '<span class="chev" aria-hidden="true">▸</span>' : ''}</div>
    ${isOpen ? `<div class="ph-agents">${agents.map(a => agentRow(a, now)).join('')}${more}</div>` : ''}</div>`
}

/** The run: name, state and clock (the card draws its progress line), then failed agents pinned above the phases in their order. */
export function runDetail(s: State, key: string, w: Run, now: number): string {
  const failed = w.phases.flatMap(p => (p.agents ?? []).filter(a => a.status === 'error').map(a => agentRow(a, now, p.title)))
  const { run, done, err } = w.agents
  return `<div class="flow"><div class="flow-head"><span class="flow-label">⚙ ${esc(w.name)}</span>
      <span class="meta">${esc(WORD[w.status] ?? w.status)} · ${clockOf((w.endedAt ?? now) - w.startedAt)}</span></div>
    <div class="meta flow-counts">${run} running · ${done} done${err ? ` · ${err} failed` : ''}${w.inferred ? ' · ≈ as this session saw it' : ''}</div>
    ${failed.length ? `<div class="failed"><div class="flow-label bad">✗ ${failed.length} failed</div>${failed.join('')}</div>` : ''}
    <div class="phases">${w.phases.map(p => phaseRow(s, key, p, now)).join('')}</div></div>`
}

const CADENCE: Record<string, string> = { wakeup: 'paced by Claude', cron: 'on a schedule', monitor: 'watching until it ends' }

/** The loop: why, how often, when next, how long it has been quiet, and the last tick that changed something. */
export function loopDetail(l: Loop, now: number): string {
  const facts: [string, string][] = [
    ['Why', l.reason ?? ''],
    ['Cadence', l.every ?? CADENCE[l.kind] ?? ''],
    ['Next', l.nextAt !== undefined ? `${timeOfDay(l.nextAt)} · in ${clockOf(Math.max(0, l.nextAt - now))}` : ''],
    ['Quiet', l.noopStreak > 0 ? `${l.noopStreak} tick${l.noopStreak === 1 ? '' : 's'} found nothing` : ''],
    ['Last change', l.lastChange ? `${timeOfDay(l.lastChange.at)} “${l.lastChange.text}”` : ''],
  ]
  return `<div class="flow"><div class="flow-head"><span class="flow-label loop">↻ Loop</span><span class="meta">${esc(l.kind)}</span></div>
    <dl class="facts">${facts.filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>`
}

/**
 * Stop workflow and Stop loop take two taps, like Stop; Run now takes one (it only runs the loop's own prompt).
 * Stop loop is left out for a loop the session cannot end (a cron or monitor whose id it never learned).
 */
export function flowActions(s: State, key: string, x: Stream, now: number): string {
  const btns: string[] = []
  if (x.workflow?.status === 'running') {
    const arm = `${key}|stopTask`
    btns.push(`<button class="btn stop" data-stop-task="${esc(x.workflow.taskId)}" data-arm="${esc(arm)}">${isArmed(s, arm, now) ? 'Tap again to stop' : '■ Stop workflow'}</button>`)
  }
  if (x.loop) {
    const arm = `${key}|stopLoop`
    if (x.loop.kind !== 'monitor') btns.push(`<button class="btn ghost" data-run-tick="${esc(key)}">↻ Run now</button>`)
    if (x.loop.canStop !== false) btns.push(`<button class="btn stop" data-stop-loop="${esc(key)}" data-arm="${esc(arm)}">${isArmed(s, arm, now) ? 'Tap again to end' : '■ Stop loop'}</button>`)
  }
  return btns.length ? `<div class="actions flow-actions">${btns.join('')}</div>` : ''
}

/** Everything the card's body adds for its run and loop, above its agents and rows. */
export const flowDetail = (s: State, key: string, x: Stream, now: number): string =>
  x.workflow || x.loop ? `${x.workflow ? runDetail(s, key, x.workflow, now) : ''}${x.loop ? loopDetail(x.loop, now) : ''}${flowActions(s, key, x, now)}` : ''

/**
 * The sticky line above plan usage, Live-Activity style: `⚙ 11/16 agents · ✗ 1 failed · ↻ next in 4:10`, in words
 * so it reads at a glance and to a screen reader; empty when there is nothing.
 */
export function summaryLine(x: Snapshot, now: number): string {
  const runs = (x.streams ?? []).flatMap(st => (st.workflow?.status === 'running' ? [st.workflow] : []))
  const fails = Number(x.summary?.failures) || 0
  const next = x.summary?.nextTickAt
  const parts: string[] = []
  if (runs.length) {
    const done = runs.reduce((n, w) => n + w.agents.done, 0)
    parts.push(`<span class="ws">⚙ ${done}/${runs.reduce((n, w) => n + total(w), 0)} agents</span>`)
  }
  if (fails) parts.push(`<span class="bad">✗ ${fails} failed</span>`)
  if (next !== undefined) parts.push(`<span class="lp">↻ next in ${clockOf(Math.max(0, next - now))}</span>`)
  const said = `${runs.length} workflow${runs.length === 1 ? '' : 's'} running, ${fails} failed${next !== undefined ? `, next loop tick in ${clockOf(Math.max(0, next - now))}` : ''}`
  return parts.length ? `<div class="flowsum" role="status" aria-label="${said}" title="${said}">${parts.join('<span class="sep">·</span>')}</div>` : ''
}
