// A reply's markdown, drawn small and safe: everything is escaped first, then fenced code, inline code, bold, italics
// and headings are marked up on the escaped text. Links show their words; nothing becomes a live link or an image.
import { esc } from './util'

const inline = (s: string): string =>
  s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>')
    .replace(/\[([^\]\n]+)\]\((?:[^()\s]|\([^()\s]*\))+\)/g, '$1')

/** A markdown text as HTML for a full-view row. */
export function md(text: string): string {
  const out: string[] = []
  // Split on fences: odd parts are code, drawn as they are.
  const parts = text.split(/^```[^\n]*\n?/m)
  parts.forEach((part, i) => {
    if (i % 2 === 1) return void out.push(`<pre class="code"><code>${esc(part.replace(/\n$/, ''))}</code></pre>`)
    const lines = esc(part).split('\n').map(line => {
      const h = /^(#{1,6})\s+(.*)$/.exec(line)
      if (h) return `<b class="h">${inline(h[2]!)}</b>`
      const item = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line)
      if (item) return `${item[1]}<span class="li">${item[2] === '-' || item[2] === '*' ? '•' : item[2]}</span> ${inline(item[3]!)}`
      return inline(line)
    })
    out.push(lines.join('\n'))
  })
  return out.join('')
}
