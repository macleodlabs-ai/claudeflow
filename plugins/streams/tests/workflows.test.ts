import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { Workflow } from '../types'
import { afterTaskNotice, agentEnded, agentSeen, fromJournal, fromRunFile, launched, metaOf, ownerOf, phasesOf, runFileOf, workflowLines, workflowView, type Workflows } from '../hooks/streams/workflows'
import { statusOf } from '../hooks/status'
import { ENGINE, T, SESSION_DIR, DIR, SCRIPT_PATH, SCRIPT, run, live, JOURNAL, RECORD, session, PANE, drawn } from './kit/workflows'

// A Workflow run is many agents the session's agent list never names: without this, every one of them was filed in
// whatever stream happened to be current, and the run showed as nothing but noise. These tests pin that a run is its
// own stream, with a skeleton of its phases filled as its agents go, and that its end is read from its own record.

describe('a run in the session', () => {
  test("is filed as its own stream, and its agents' calls land there, not in the stream that was current", ENGINE, async ($, on) => {
    const files: Record<string, string> = {}
    const { clock } = session(on, files)
    await $.prompt.submit({ text: '#billing why is the invoice total off?', wait: false, origin: { kind: 'composer' } })
    await $.tool.call({ tool: 'Workflow', tool_use_id: 'u1', script: SCRIPT } as never)
    // An agent of the run: an id no stream knows, calling tools while the run goes.
    await $.tool.call({ tool: 'Read', tool_use_id: 'u2', file_path: 'a.ts', agentId: 'a1' } as never)
    await $.tool.call({ tool: 'Read', tool_use_id: 'u3', file_path: 'b.ts', agentId: 'a2' } as never)
    await clock.advance(2000)
    expect(await drawn($, 60, /^⚙|^ {2}[●✓✗○] (Map|Verify|Fix|wave)/)).toEqual(['⚙ RUNNING 0:02 audit ▱▱▱▱▱▱▱▱▱▱ ≈0/2 agents', '  ● wave 1 0/2'])
    // The run's stream runs with its two agents; billing, current all along, got none of them.
    const cards = await drawn($, 60, /^(RUNNING|DONE) · /)
    expect(cards.sort()).toEqual(['DONE · 0 rows · 0 agents · 2s ago', 'RUNNING · 0 rows · 2 agents · 2s ago'])
    // The journal appears: labels and phases replace the waves on the next read.
    files[`${DIR}/journal.jsonl`] = JOURNAL.split('\n').slice(0, 4).join('\n')
    await clock.advance(3000)
    expect(await drawn($, 60, /^ {2}[●✓✗○] (Map|Verify|Fix|wave)/)).toEqual(['  ● Map 1/2 · ○ Verify · ○ Fix'])
    // The end notice, then the record: the final word. An agent the run ended as completed while still counted
    // running (a2 here) is done with it.
    files[`${SESSION_DIR}/workflows/wf_abc-123.json`] = RECORD
    await $.prompt.submit({ text: '<task-notification><task-id>w1</task-id><status>completed</status></task-notification>', wait: false, origin: { kind: 'task-notification' } })
    expect(await drawn($, 60, /^⚙|^ {2}[●✓✗○] (Map|Verify|Fix|wave)/)).toEqual(['⚙ DONE 4:10 audit ▰▰▰▰▰▰▰▰▰▰ 4/4 ✗1 agents', '  ✓ Map 2/2 · ✓ Verify 1/1 refuted 1 · ✗ Fix 0/1 ✗1'])
  })
})
