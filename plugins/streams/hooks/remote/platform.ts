// The few system commands the remote runs, per platform. Plain functions with no engine in them: each says what to
// run, and the caller runs it with $.process.run at its own call site (the engine follows $ only within a file).
// Windows is not supported yet: every command for it is undefined, so a caller says so instead of running a Mac path.

export type Platform = 'darwin' | 'linux' | 'win32'

/** The platform, from the `OS` variable (Windows sets `Windows_NT`) and `uname -s` (macOS `Darwin`, Linux `Linux`). */
export const platformOf = (osEnv: string | undefined, uname: string | undefined): Platform =>
  osEnv === 'Windows_NT' ? 'win32' : /^linux/i.test((uname ?? '').trim()) ? 'linux' : 'darwin'

/** Opens a URL in the default browser. */
export const openArgv = (p: Platform, url: string): string[] | undefined =>
  p === 'darwin' ? ['/usr/bin/open', url] : p === 'linux' ? ['xdg-open', url] : undefined

/**
 * Waits `seconds` in a process: the engine counts a hook's own waits against its 10 s budget but not a $ call in
 * flight, so a held prompt sleeps in a process (index.tsx `awaitAnswer`).
 */
export const sleepArgv = (p: Platform, seconds: number): string[] | undefined => (p === 'win32' ? undefined : ['sleep', String(seconds)])

export const mkdirArgv = (p: Platform, dir: string): string[] | undefined => (p === 'win32' ? undefined : ['mkdir', '-p', dir])

/**
 * Decodes base64 text at `from` into the bytes at `to`. BSD base64 (macOS) writes the file itself; GNU base64 (Linux)
 * writes to stdout, so a shell redirects it: the paths go as arguments, never into the script.
 */
export const decodeArgv = (p: Platform, from: string, to: string): string[] | undefined =>
  p === 'darwin' ? ['/usr/bin/base64', '-D', '-i', from, '-o', to] : p === 'linux' ? ['sh', '-c', 'base64 -d -- "$1" > "$2"', 'sh', from, to] : undefined

export const removeArgv = (p: Platform, file: string): string[] | undefined => (p === 'win32' ? undefined : ['rm', '-f', file])

/** Removes the folders directly in `dir` last changed over `days` days ago: the files of old prompts from a phone. */
export const pruneArgv = (p: Platform, dir: string, days: number): string[] | undefined =>
  p === 'win32' ? undefined : ['find', dir, '-mindepth', '1', '-maxdepth', '1', '-type', 'd', '-mtime', `+${days}`, '-exec', 'rm', '-rf', '{}', '+']
