/** How far a finger moves before the swipe decides it is sideways (a swipe) or up and down (a scroll). */
export const LOCK_PX = 8
/** A clear move this far the swipe's way goes, however slow. */
export const SWIPE_DONE_PX = 48
/** A flick goes from this far, when the finger is still moving the swipe's way at FLICK_SPEED (px/ms). */
export const FLICK_PX = 16
export const FLICK_SPEED = 0.3

/**
 * Whether a swipe that ended at `dx` (signed toward its way: negative for left) with the finger moving at `v` px/ms
 * goes. A swipe that ends moving back the other way is a change of mind and stays.
 */
export const swipeGoes = (dx: number, v: number, way: -1 | 1): boolean => {
  const d = dx * way
  const speed = v * way
  if (speed < -FLICK_SPEED) return false
  return d >= SWIPE_DONE_PX || (d >= FLICK_PX && speed >= FLICK_SPEED)
}

/** Which way a move first leans, once past LOCK_PX: sideways, a scroll, or not yet known. */
export const lockOf = (dx: number, dy: number): 'side' | 'scroll' | undefined =>
  Math.max(Math.abs(dx), Math.abs(dy)) < LOCK_PX ? undefined : Math.abs(dx) > Math.abs(dy) ? 'side' : 'scroll'
