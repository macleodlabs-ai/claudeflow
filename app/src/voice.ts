// Dictation for the composer: the browser's own speech recognition, typing into the box so the words can be edited
// before they are sent. Where the browser has none (some home-screen apps), the 🎤 is not offered and the keyboard's
// own mic still works.

type Recognition = {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
  start(): void
  stop(): void
}

export function dictation(onText: (text: string) => void, onChange: () => void) {
  const w = globalThis as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
  let rec: Recognition | undefined
  const stop = () => {
    rec?.stop()
    rec = undefined
    onChange()
  }
  return {
    isOffered: !!Ctor,
    isListening: () => !!rec,
    stop: () => rec && stop(),
    toggle() {
      if (rec || !Ctor) return stop()
      rec = new Ctor()
      rec.lang = navigator.language || 'en-US'
      rec.continuous = true
      rec.interimResults = false
      // Only finished phrases are typed: a half-heard word never lands in the box.
      rec.onresult = e => {
        for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i]!.isFinal) onText(e.results[i]![0]!.transcript.trim())
      }
      rec.onend = () => {
        rec = undefined
        onChange()
      }
      rec.onerror = rec.onend
      rec.start()
      onChange()
    },
  }
}
