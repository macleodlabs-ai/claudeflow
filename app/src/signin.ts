// How this device signs in, in its own words: Face ID on an iPhone, Windows Hello on Windows, the screen lock on
// Android. Without a built-in authenticator (most Linux, some Windows) a passkey still works from a phone or a security
// key; with no WebAuthn at all, a guest can keep a key in this browser instead (passkey.ts, watch only).

/** What a guest is told to use, and which ways in this browser offers. */
export type SignIn = {
  /** The platform's name for its sign-in, as a sentence would use it: "Join with {term}". */
  term: string
  /** WebAuthn is there: a passkey can be made (built in, a phone, or a security key). */
  canPasskey: boolean
  /** A built-in authenticator (Face ID, Touch ID, Windows Hello, the screen lock) is there. */
  hasPlatform: boolean
}

/** The built-in sign-in's name on this platform, read from its user agent. */
export function platformTerm(ua: string, touchPoints = 0): string {
  if (/iPhone|iPod|iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'Face ID'
  if (/Macintosh/.test(ua)) return 'Touch ID'
  if (/Android/.test(ua)) return 'your screen lock'
  if (/Windows/.test(ua)) return 'Windows Hello'
  return "your device's sign-in"
}

/** The way in, in words: the built-in one, else a phone or security key, else this browser. */
export const signInOf = (ua: string, touchPoints: number, canPasskey: boolean, hasPlatform: boolean): SignIn => ({
  term: !canPasskey ? 'this browser' : hasPlatform ? platformTerm(ua, touchPoints) : 'your phone or security key',
  canPasskey,
  hasPlatform,
})

/** What this browser offers, asked once at start (the platform check is async). */
export async function detectSignIn(): Promise<SignIn> {
  const pkc = (globalThis as { PublicKeyCredential?: { isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean> } }).PublicKeyCredential
  const canPasskey = !!pkc && typeof navigator.credentials?.create === 'function'
  const hasPlatform = canPasskey && !!(await pkc?.isUserVerifyingPlatformAuthenticatorAvailable?.().catch(() => false))
  return signInOf(navigator.userAgent, navigator.maxTouchPoints ?? 0, canPasskey, hasPlatform)
}
