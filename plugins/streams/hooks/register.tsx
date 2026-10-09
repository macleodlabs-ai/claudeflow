import type { Register } from 'claude-code'

import { mem } from './state'
import { wireSession } from './streams/session'
import { wireWorker } from './streams/worker'
import { wireRouting } from './streams/routing'
import { wireFiling } from './streams/filing'
import { wireUpdates } from './updates/check'
import { wireRemote } from './remote/index'
import { wireBar } from './ui/bar'
import { wireTranscript } from './ui/transcript'
import { wirePane } from './ui/pane'

// Wires the session's events to the modules that answer them. The engine follows `$` only within a file, so
// each module registers its own hooks; this file only says which, and in what order.
//
// Order matters where two modules share an event: the first registered runs first and passes the rest on
// with next(e). So the session's restore runs before the worker files history; the band's `status` check
// runs before a prompt is filed; and `/streams <verb>` reaches the module that owns the verb (import, update,
// phone, status) before the pane answers a bare `/streams`.
export const register: Register = (on, options) => {
  mem.isDiagnosing = options.diagnostics === true
  mem.defaultStyle = options.chatStyle === 'compact' ? 'compact' : 'full'

  wireSession(on)
  wireWorker(on)
  wireUpdates(on)
  wireRemote(on, { relayUrl: typeof options.relayUrl === 'string' ? options.relayUrl.trim() : '' })
  wireBar(on)
  wireRouting(on)
  wireFiling(on)
  wireTranscript(on)
  wirePane(on)
}
