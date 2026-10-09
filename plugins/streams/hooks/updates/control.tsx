import type { ElementTable, RenderElement } from 'claude-code'

import type { Update } from './versions'

/** The ⬆ update button while any installed plugin has a newer release; a progress word while one installs. */
export function updateControl(ui: ElementTable, updates: readonly Update[], isUpdating: boolean): RenderElement | null {
  const { Button, Text } = ui
  if (isUpdating) return <Text color="#ffd33d" bold>⟳ updating…</Text>
  if (!updates.length) return null
  const label = updates.length === 1 ? `⬆ update ${updates[0]?.id.split('@')[0]} ${updates[0]?.to}` : `⬆ update ${updates.length} plugins`
  // Its press is answered by the updates module's ui.press hook on this key: the install lives there.
  return <Button key="update" label={label} hotkey="u" onPress={() => {}} />
}
