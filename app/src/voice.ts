// Dictation for the composer: the browser's own speech recognition, typing into the box as it hears, so the words can
// be edited before they are sent, with the microphone's level for a soundwave. Where the browser has none (some
// home-screen apps), the 🎤 is not offered and the keyboard's own mic still works.

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

/** What dictation tells the composer: a finished phrase, the phrase still being heard, the mic level, and on/off. */
export type DictationHooks = {
  onFinal(text: string): void
  onPartial(text: string): void
  onLevels(levels: number[]): void
  onChange(): void
}

/** The soundwave's bars. */
export const WAVE_BARS = 5

export function dictation(h: DictationHooks) {
  const w = globalThis as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
  let rec: Recognition | undefined
  let isOn = false
  let audio: { stream: MediaStream; ctx: AudioContext; frame: number } | undefined

  /** The mic's level, a bar per band, each frame; where the mic cannot be read, the wave simply stays still. */
  async function listenLevels() {
    const stream = await navigator.mediaDevices?.getUserMedia({ audio: true }).catch(() => undefined)
    if (!stream || !isOn) return stream?.getTracks().forEach(t => t.stop())
    const ctx = new AudioContext()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 64
    ctx.createMediaStreamSource(stream).connect(analyser)
    const bins = new Uint8Array(analyser.frequencyBinCount)
    const draw = () => {
      analyser.getByteFrequencyData(bins)
      const per = Math.floor(bins.length / WAVE_BARS)
      h.onLevels(Array.from({ length: WAVE_BARS }, (_, i) => Math.min(1, bins.slice(i * per, (i + 1) * per).reduce((a, b) => a + b, 0) / per / 160)))
      if (audio) audio.frame = requestAnimationFrame(draw)
    }
    audio = { stream, ctx, frame: requestAnimationFrame(draw) }
  }

  function stopLevels() {
    if (!audio) return
    cancelAnimationFrame(audio.frame)
    audio.stream.getTracks().forEach(t => t.stop())
    void audio.ctx.close().catch(() => {})
    audio = undefined
    h.onLevels(Array(WAVE_BARS).fill(0))
  }

  return {
    isOffered: !!Ctor,
    isListening: () => isOn,
    start() {
      if (isOn || !Ctor) return
      isOn = true
      const r = new Ctor()
      rec = r
      r.lang = navigator.language || 'en-US'
      r.continuous = true
      r.interimResults = true
      // A finished phrase is typed for good; the phrase still being heard shows as it changes.
      r.onresult = e => {
        let partial = ''
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const text = e.results[i]![0]!.transcript.trim()
          if (e.results[i]!.isFinal) h.onFinal(text)
          else partial += (partial ? ' ' : '') + text
        }
        h.onPartial(partial)
      }
      // Stopped by us or by the browser (silence, an error): the last phrase has arrived by now.
      r.onend = () => {
        if (rec !== r) return
        rec = undefined
        isOn = false
        stopLevels()
        h.onPartial('')
        h.onChange()
      }
      r.onerror = r.onend
      r.start()
      void listenLevels()
      h.onChange()
    },
    /** Stops listening; the phrase in flight still lands (onend comes after the last result). */
    stop() {
      if (!isOn) return
      isOn = false
      rec?.stop()
      stopLevels()
      h.onChange()
    },
  }
}
