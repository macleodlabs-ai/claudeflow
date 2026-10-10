import { afterEach, describe, expect, test } from 'bun:test'
import { dictation } from '../src/voice'

type Result = { isFinal: boolean; 0: { transcript: string }; length: 1 }
let last: FakeRec | undefined
class FakeRec {
  lang = ''
  continuous = false
  interimResults = false
  onresult: ((e: { resultIndex: number; results: Result[] }) => void) | null = null
  onend: (() => void) | null = null
  onerror: (() => void) | null = null
  stopped = false
  constructor() {
    last = this
  }
  start() {}
  stop() {
    this.stopped = true
  }
  hear(...rs: [string, boolean][]) {
    this.onresult?.({ resultIndex: 0, results: rs.map(([t, f]) => ({ isFinal: f, 0: { transcript: t }, length: 1 })) })
  }
}
const g = globalThis as unknown as { webkitSpeechRecognition?: unknown }
afterEach(() => delete g.webkitSpeechRecognition)

const watch = () => {
  const seen = { finals: [] as string[], partials: [] as string[], changes: 0 }
  const d = dictation({ onFinal: t => seen.finals.push(t), onPartial: t => seen.partials.push(t), onLevels: () => {}, onChange: () => seen.changes++ })
  return { d, seen }
}

describe('dictation', () => {
  test('words show as they are heard, then land for good once the phrase is final', () => {
    // Live transcription: the person sees what is heard while speaking, not only after.
    g.webkitSpeechRecognition = FakeRec
    const { d, seen } = watch()
    d.start()
    expect(last!.interimResults).toBe(true)
    last!.hear(['deploy the', false])
    last!.hear(['deploy the relay', true], ['now', false])
    expect(seen.partials).toEqual(['deploy the', 'now'])
    expect(seen.finals).toEqual(['deploy the relay'])
  })

  test('stopping lets the phrase in flight land before it says it is off', () => {
    // Releasing a held mic mid-word must not lose the last words.
    g.webkitSpeechRecognition = FakeRec
    const { d, seen } = watch()
    d.start()
    d.stop()
    expect(d.isListening()).toBe(false)
    expect(last!.stopped).toBe(true)
    last!.hear(['last words', true])
    last!.onend!()
    expect(seen.finals).toEqual(['last words'])
    expect(seen.partials.at(-1)).toBe('')
  })

  test('with no speech recognition in the browser the mic is not offered', () => {
    expect(watch().d.isOffered).toBe(false)
  })
})
