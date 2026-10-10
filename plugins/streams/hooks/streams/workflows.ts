import type { Workflow, WorkflowAgent } from '../../types'
import { clockOf, oneLine } from '../classify'

// Workflow tool runs as data: the script's meta, what each agent's tool call, end, the run's journal and its final
// record do to a run, and the lines and phone card a run draws as. No engine in sight: flows.ts runs these.
//
// What the engine gives (types: tool.call's `agentId`): a workflow's agents carry ids `$.agent.list()` never names,
// and pass no `agent.spawn`. So an id no stream knows, seen while a workflow runs, is taken for that workflow's.

export type Workflows = Record<string, Workflow>

// ── the script's meta ──────────────────────────────────────────────────────────────────────────────

/** Reads one JS literal (object, array, string, number, true, false, null) from `src` at `at`; no expressions. */
function literalAt(src: string, at: number): { value: unknown; end: number } | undefined {
  let i = at
  const skip = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i] as string)) i++
      if (src.startsWith('//', i)) i = src.indexOf('\n', i) < 0 ? src.length : src.indexOf('\n', i)
      else if (src.startsWith('/*', i)) i = src.indexOf('*/', i) < 0 ? src.length : src.indexOf('*/', i) + 2
      else return
    }
  }
  const value = (): unknown => {
    skip()
    const c = src[i]
    if (c === '{') {
      i++
      const out: Record<string, unknown> = {}
      for (;;) {
        skip()
        if (src[i] === '}') return i++, out
        let key: unknown
        if (src[i] === "'" || src[i] === '"') key = value()
        else {
          key = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))?.[0]
          if (typeof key === 'string') i += key.length
        }
        if (typeof key !== 'string') throw new Error('key')
        skip()
        if (src[i++] !== ':') throw new Error(':')
        out[key] = value()
        skip()
        if (src[i] === ',') i++
        else if (src[i] !== '}') throw new Error('}')
      }
    }
    if (c === '[') {
      i++
      const out: unknown[] = []
      for (;;) {
        skip()
        if (src[i] === ']') return i++, out
        out.push(value())
        skip()
        if (src[i] === ',') i++
        else if (src[i] !== ']') throw new Error(']')
      }
    }
    if (c === "'" || c === '"' || c === '`') {
      let s = ''
      for (i++; i < src.length && src[i] !== c; i++) {
        if (c === '`' && src.startsWith('${', i)) throw new Error('template')
        if (src[i] !== '\\') s += src[i]
        else s += ({ n: '\n', t: '\t', r: '\r' } as Record<string, string>)[src[++i] as string] ?? src[i]
      }
      if (src[i++] !== c) throw new Error('string')
      return s
    }
    const word = /^(-?\d+(?:\.\d+)?|true|false|null)/.exec(src.slice(i))?.[0]
    if (!word) throw new Error('value')
    i += word.length
    return JSON.parse(word)
  }
  try {
    return { value: value(), end: i }
  } catch {
    return undefined
  }
}

export type WorkflowMeta = { name: string; description?: string; phases: string[] }

/**
 * A Workflow script's `export const meta = { name, description, phases }`, read as the literal the tool requires it
 * to be: never run. Undefined when there is none or it is not a plain literal with a name.
 */
export function metaOf(script: string): WorkflowMeta | undefined {
  const m = /export\s+const\s+meta\s*(?::[^=]+)?=\s*/.exec(script)
  if (!m) return undefined
  const got = literalAt(script, m.index + m[0].length)?.value as Record<string, unknown> | undefined
  if (!got || typeof got !== 'object' || typeof got.name !== 'string' || !got.name.trim()) return undefined
  const phases = Array.isArray(got.phases)
    ? got.phases.flatMap(p => (typeof p === 'string' ? [p] : p && typeof (p as { title?: unknown }).title === 'string' ? [(p as { title: string }).title] : []))
    : []
  return { name: got.name.trim(), ...(typeof got.description === 'string' ? { description: got.description } : {}), phases }
}

// ── what changes a run ─────────────────────────────────────────────────────────────────────────────

/** Runs kept per session: older finished ones are dropped. */
const KEEP = 10

/** The runs with a new one started: what the Workflow tool's answer names. */
export function launched(m: Workflows, w: Pick<Workflow, 'taskId' | 'name' | 'streamId' | 'phases' | 'startedAt'> & Partial<Workflow>): Workflows {
  const run: Workflow = { status: 'running', agents: {}, inferred: true, ...w }
  const kept = Object.values(m)
    .filter(x => x.taskId !== w.taskId)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, KEEP - 1)
  return { ...Object.fromEntries(kept.map(x => [x.taskId, x])), [w.taskId]: run }
}

/**
 * The run an agent works for: the one that has it, or, for an id no stream knows (`isKnown` false), the run started
 * last of those still running. Undefined for an ordinary subagent, or when no run is going.
 */
export function ownerOf(m: Workflows, agentId: string, isKnown: boolean): Workflow | undefined {
  const runs = Object.values(m)
  const has = runs.find(r => r.agents[agentId])
  if (has || isKnown) return has
  return runs.filter(r => r.status === 'running').sort((a, b) => b.startedAt - a.startedAt)[0]
}

const withAgent = (m: Workflows, taskId: string, id: string, f: (a: WorkflowAgent | undefined) => WorkflowAgent | undefined): Workflows => {
  const run = m[taskId]
  if (!run) return m
  const was = run.agents[id]
  const now = f(was)
  if (!now || now === was) return m
  return { ...m, [taskId]: { ...run, agents: { ...run.agents, [id]: now } } }
}

/** One step of an agent seen live (a tool call, or `isTool` false for a row): started on first sight, counted after. */
export const agentSeen = (m: Workflows, taskId: string, id: string, now: number, isTool: boolean): Workflows =>
  withAgent(m, taskId, id, a => {
    const base: WorkflowAgent = a ?? { id, status: 'running', startedAt: now, lastAt: now, tools: 0 }
    return isTool || !a ? { ...base, lastAt: now, tools: base.tools + (isTool ? 1 : 0) } : a
  })

/** An agent's loop ended: its turn's reason says how. */
export const agentEnded = (m: Workflows, taskId: string, id: string, ok: boolean, now: number): Workflows =>
  withAgent(m, taskId, id, a => (a && a.status === 'running' ? { ...a, status: ok ? 'done' : 'error', endedAt: now } : a))

/** What a checking agent concluded, from its structured output (an object, its JSON, or a cut JSON preview). */
export function verdictOf(result: unknown): string | undefined {
  if (typeof result === 'string') {
    try {
      return verdictOf(JSON.parse(result))
    } catch {
      const v = /"verdict"\s*:\s*"([^"]{1,24})"/.exec(result)?.[1] ?? /"pass(?:ed)?"\s*:\s*(true|false)/.exec(result)?.[1]
      return v === 'true' ? 'pass' : v === 'false' ? 'fail' : v?.toLowerCase()
    }
  }
  if (!result || typeof result !== 'object') return undefined
  const r = result as Record<string, unknown>
  if (typeof r.verdict === 'string' && r.verdict.trim()) return oneLine(r.verdict, 24).toLowerCase()
  const pass = typeof r.passed === 'boolean' ? r.passed : r.pass
  return typeof pass === 'boolean' ? (pass ? 'pass' : 'fail') : undefined
}

/**
 * A run with its journal read (`journal.jsonl` in its transcript dir: `started` with the agent's label and phase,
 * then `result` or `failed`). The journal is the run's own word, so its labels and ends win; a run it names is no
 * longer inferred. Unchanged, the same run.
 */
export function fromJournal(run: Workflow, text: string, now: number): Workflow {
  let agents = run.agents
  let seen = false
  for (const line of text.split('\n')) {
    let j: Record<string, unknown>
    try {
      j = JSON.parse(line)
    } catch {
      continue
    }
    seen ||= j.type === 'launched' || j.type === 'started'
    const id = typeof j.agentId === 'string' ? j.agentId : ''
    if (!id) continue
    const was: WorkflowAgent = agents[id] ?? { id, status: 'running', startedAt: now, lastAt: now, tools: 0 }
    let next = was
    if (j.type === 'started') {
      next = { ...was, ...(typeof j.label === 'string' ? { label: j.label } : {}), ...(typeof j.phase === 'string' ? { phase: j.phase } : {}) }
    } else if (j.type === 'result' || j.type === 'failed') {
      const verdict = j.type === 'result' ? verdictOf(j.result) : undefined
      next = { ...was, status: j.type === 'result' ? 'done' : 'error', endedAt: was.endedAt ?? now, ...(verdict ? { verdict } : {}) }
    }
    if (JSON.stringify(next) !== JSON.stringify(was) || !agents[id]) agents = { ...agents, [id]: next }
  }
  if (agents === run.agents && (!seen || !run.inferred)) return run
  return { ...run, agents, inferred: run.inferred && !seen }
}

const STATE: Record<string, WorkflowAgent['status']> = { done: 'done', completed: 'done', failed: 'error', error: 'error', killed: 'error' }

/**
 * A finished run reconciled with its record (`workflows/wf_<runId>.json`, written as the run ends): every agent's
 * label, phase, state, tool calls and verdict, the phases, and how the run ended. Malformed, the run as it was.
 */
export function fromRunFile(run: Workflow, json: string): Workflow {
  let f: Record<string, unknown>
  try {
    f = JSON.parse(json)
  } catch {
    return run
  }
  const progress = Array.isArray(f.workflowProgress) ? (f.workflowProgress as Record<string, unknown>[]) : []
  const listed = progress.filter(p => p.type === 'workflow_agent' && typeof p.agentId === 'string')
  if (!listed.length && !Array.isArray(f.phases)) return run
  const agents: Record<string, WorkflowAgent> = { ...run.agents }
  for (const p of listed) {
    const id = p.agentId as string
    const was = agents[id]
    const startedAt = typeof p.startedAt === 'number' ? p.startedAt : (was?.startedAt ?? run.startedAt)
    const verdict = verdictOf(p.resultPreview) ?? was?.verdict
    agents[id] = {
      id,
      status: STATE[String(p.state)] ?? was?.status ?? 'running',
      startedAt,
      lastAt: was?.lastAt ?? startedAt,
      ...(typeof p.durationMs === 'number' ? { endedAt: startedAt + p.durationMs } : was?.endedAt !== undefined ? { endedAt: was.endedAt } : {}),
      tools: typeof p.toolCalls === 'number' ? p.toolCalls : (was?.tools ?? 0),
      ...(typeof p.label === 'string' ? { label: p.label } : was?.label ? { label: was.label } : {}),
      ...(typeof p.phaseTitle === 'string' ? { phase: p.phaseTitle } : was?.phase ? { phase: was.phase } : {}),
      ...(verdict ? { verdict } : {}),
    }
  }
  const phases = Array.isArray(f.phases) ? (f.phases as { title?: unknown }[]).flatMap(p => (typeof p?.title === 'string' ? [p.title] : [])) : run.phases
  const status = f.status === 'completed' ? 'completed' : f.status === 'failed' ? 'failed' : f.status === 'killed' ? 'killed' : run.status
  const endedAt = typeof f.startTime === 'number' && typeof f.durationMs === 'number' ? f.startTime + f.durationMs : run.endedAt
  return { ...run, agents, phases, status, ...(endedAt !== undefined ? { endedAt } : {}), inferred: false }
}

/**
 * The runs after a background task's notification: one naming a run's task id with a `<status>` ends it, and its
 * agents still counted running end with it. Also says which run ended, so its record can be read.
 */
export function afterTaskNotice(m: Workflows, text: string, now: number): { runs: Workflows; ended?: string } {
  const ids = [...text.matchAll(/<task-id>([^<]+)<\/task-id>/g)].map(x => x[1])
  const said = /<status>([^<]+)<\/status>/.exec(text)?.[1]?.trim().toLowerCase()
  const run = ids.map(id => m[id as string]).find(r => r && r.status === 'running')
  if (!run || !said) return { runs: m }
  const status: Workflow['status'] = said === 'completed' ? 'completed' : said === 'failed' || said === 'error' ? 'failed' : 'killed'
  const agents = Object.fromEntries(
    Object.entries(run.agents).map(([id, a]) => [id, a.status === 'running' ? { ...a, status: status === 'completed' ? ('done' as const) : ('error' as const), endedAt: now } : a]),
  )
  return { runs: { ...m, [run.taskId]: { ...run, status, endedAt: now, agents } }, ended: run.taskId }
}

/** Where a run's record is written as it ends: beside its script, `<session>/workflows/wf_<runId>.json`. */
export function runFileOf(run: Pick<Workflow, 'runId' | 'scriptPath' | 'transcriptDir'>): string | undefined {
  if (!run.runId) return undefined
  const file = `${run.runId.startsWith('wf_') ? run.runId : `wf_${run.runId}`}.json`
  const fromScript = run.scriptPath && /\/workflows\/scripts\/[^/]+$/.test(run.scriptPath) ? run.scriptPath.replace(/\/scripts\/[^/]+$/, '') : undefined
  const fromDir = run.transcriptDir && /\/subagents\/workflows\/[^/]+\/?$/.test(run.transcriptDir) ? run.transcriptDir.replace(/\/subagents\/workflows\/[^/]+\/?$/, '/workflows') : undefined
  const dir = fromScript ?? fromDir
  return dir ? `${dir}/${file}` : undefined
}

// ── how a run reads ────────────────────────────────────────────────────────────────────────────────

/** One of a run's agents as the phone lists it under its phase: a short id, the label cut short, clocks as times. */
export type AgentView = { id: string; label?: string; status: WorkflowAgent['status']; tools: number; startedAt: number; endedAt?: number; verdict?: string }

export type PhaseView = { title: string; done: number; total: number; err: number; verdicts?: Record<string, number>; agents?: AgentView[] }

/** What the phone is told of a run: counts and times, nothing that changes on its own. */
export type WorkflowView = {
  name: string
  taskId: string
  status: Workflow['status']
  startedAt: number
  endedAt?: number
  agents: { run: number; done: number; err: number }
  phases: PhaseView[]
  /** The counts are what the plugin saw, not the run's own record, and phases are waves of start times. */
  inferred: boolean
}

/** Agents that start within this long of the one before are one wave. */
export const WAVE_GAP_MS = 5000
/** Agents a phase lists on the phone, failures first: a wide fan-out must not swell every snapshot. */
export const PHASE_AGENTS = 24

/**
 * The run's agents grouped: by phase once the run named them (in `meta.phases` order, phases with none yet kept as
 * the skeleton), else into waves by start time, honestly called waves. Before any agent starts, the bare skeleton.
 */
function groupsOf(run: Workflow): [string, WorkflowAgent[]][] {
  const agents = Object.values(run.agents).sort((a, b) => a.startedAt - b.startedAt)
  const isNamed = agents.some(a => a.phase)
  const groups = new Map<string, WorkflowAgent[]>()
  if (isNamed || !agents.length) {
    for (const t of run.phases) groups.set(t, [])
    for (const a of agents) groups.set(a.phase ?? 'other', [...(groups.get(a.phase ?? 'other') ?? []), a])
  } else {
    let wave = 0
    let last = -Infinity
    for (const a of agents) {
      if (a.startedAt - last > WAVE_GAP_MS) wave++
      last = a.startedAt
      groups.set(`wave ${wave}`, [...(groups.get(`wave ${wave}`) ?? []), a])
    }
  }
  return [...groups]
}

const countsOf = (title: string, list: WorkflowAgent[]): PhaseView => {
  const verdicts: Record<string, number> = {}
  for (const a of list) if (a.verdict) verdicts[a.verdict] = (verdicts[a.verdict] ?? 0) + 1
  return {
    title,
    done: list.filter(a => a.status === 'done').length,
    total: list.length,
    err: list.filter(a => a.status === 'error').length,
    ...(Object.keys(verdicts).length ? { verdicts } : {}),
  }
}

export const phasesOf = (run: Workflow): PhaseView[] => groupsOf(run).map(([title, list]) => countsOf(title, list))

const agentView = (a: WorkflowAgent): AgentView => ({
  id: a.id.slice(0, 8),
  ...(a.label ? { label: oneLine(a.label, 80) } : {}),
  status: a.status,
  tools: a.tools,
  startedAt: a.startedAt,
  ...(a.endedAt !== undefined ? { endedAt: a.endedAt } : {}),
  ...(a.verdict ? { verdict: a.verdict } : {}),
})

export const workflowView = (run: Workflow): WorkflowView => {
  const agents = Object.values(run.agents)
  return {
    name: run.name,
    taskId: run.taskId,
    status: run.status,
    startedAt: run.startedAt,
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    agents: { run: agents.filter(a => a.status === 'running').length, done: agents.filter(a => a.status === 'done').length, err: agents.filter(a => a.status === 'error').length },
    // Each phase lists its agents for the phone's phase list; when the list is cut, failures are kept.
    phases: groupsOf(run).map(([title, list]) => ({
      ...countsOf(title, list),
      agents: [...list.filter(a => a.status === 'error'), ...list.filter(a => a.status !== 'error')].slice(0, PHASE_AGENTS).map(agentView),
    })),
    inferred: run.inferred,
  }
}

/** A stream's run to show: the one running, else the one started last. */
export const runOf = (m: Workflows, streamId: string): Workflow | undefined =>
  Object.values(m)
    .filter(r => r.streamId === streamId)
    .sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) || b.startedAt - a.startedAt)[0]

const WORD: Record<Workflow['status'], string> = { running: 'RUNNING', completed: 'DONE', failed: 'FAILED', killed: 'STOPPED' }

/** A phase as one short part: `✓ Map 8/8`, `● Verify 4/8 ✗1`, `○ Fix`; verdicts after, `pass 3 fail 1`. */
const phasePart = (p: PhaseView): string => {
  const finished = p.done + p.err
  const glyph = p.total === 0 ? '○' : finished < p.total ? '●' : p.err ? '✗' : '✓'
  const verdicts = p.verdicts ? ` ${Object.entries(p.verdicts).map(([v, n]) => `${v} ${n}`).join(' ')}` : ''
  return p.total === 0 ? `${glyph} ${p.title}` : `${glyph} ${p.title} ${p.done}/${p.total}${p.err ? ` ✗${p.err}` : ''}${verdicts}`
}

/**
 * A run's lines, fitted to `width` columns: its status, clock, name, a progress bar and the agents finished, then
 * its phases packed onto as few indented lines as fit. The terminal draws these, counting the clock as it draws.
 *
 *   ⚙ RUNNING 4:12 audit ▰▰▰▰▰▰▱▱ 12/16 agents
 *     ✓ Map 8/8 · ● Verify 4/8 ✗1 · ○ Fix
 */
export function workflowLines(v: WorkflowView, now: number, width: number): string[] {
  const { run, done, err } = v.agents
  const total = run + done + err
  const cells = width >= 60 ? 10 : 4
  const filled = total ? Math.round(((done + err) / total) * cells) : 0
  const bar = '▰'.repeat(filled) + '▱'.repeat(cells - filled)
  const count = `${v.inferred ? '≈' : ''}${done + err}/${total}${err ? ` ✗${err}` : ''}`
  const head = `⚙ ${WORD[v.status]} ${clockOf((v.endedAt ?? now) - v.startedAt)}`
  const tail = ` ${bar} ${count} agents`
  const room = width - head.length - tail.length - 1
  const lines = [room >= 4 ? `${head} ${oneLine(v.name, room)}${tail}` : oneLine(`${head} ${bar} ${count}`, width)]
  let line = ''
  for (const part of v.phases.map(phasePart)) {
    const next = line ? `${line} · ${part}` : `  ${part}`
    if (line && next.length > width) {
      lines.push(line)
      line = `  ${part}`
    } else line = next
  }
  if (line) lines.push(line)
  // Cut, not collapsed: the phase lines keep their indent.
  return lines.map(l => (l.length > width ? `${l.slice(0, width - 1)}…` : l))
}
