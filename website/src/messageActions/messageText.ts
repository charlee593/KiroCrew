/**
 * The text a message action is handed: the message as the reader sees it.
 *
 * By default the RENDERED plain text, not the markdown source: a link gives its
 * label, not its address, and markup the renderer hides stays hidden. Markdown is a
 * separate, approved format. Either way the text is cut to the action's
 * `maxChars` in UTF-16 units, never inside a surrogate pair.
 *
 * @module messageActions/messageText
 */
import { markdownToCleanHtml } from '../components/markdown/richTextClipboard'

const BLOCKS = new Set([
  'P', 'DIV', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'HR', 'DL', 'DT', 'DD', 'FIGURE',
])

/** The rendered plain text of a markdown message. */
export function renderedPlainText(markdown: string): string {
  const html = markdownToCleanHtml(markdown)
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html')
  const parts: string[] = []
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? '')
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as Element
    if (el.tagName === 'BR') { parts.push('\n'); return }
    const block = BLOCKS.has(el.tagName)
    if (block) parts.push('\n')
    if (el.tagName === 'TD' || el.tagName === 'TH') parts.push('\t')
    for (const child of Array.from(el.childNodes)) walk(child)
    if (block) parts.push('\n')
  }
  walk(doc.body)
  return parts.join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n\t/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** `text` cut to at most `max` UTF-16 units, never splitting a surrogate pair. */
export function truncateUnits(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  let end = max
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return { text: text.slice(0, end), truncated: true }
}

/** The text for one invocation, in the action's approved format. */
export function messageTextFor(markdown: string, format: 'plain' | 'markdown', maxChars: number): { text: string; truncated: boolean } {
  return truncateUnits(format === 'markdown' ? markdown : renderedPlainText(markdown), maxChars)
}
