/**
 * Message actions: what an app sees on a click, and what it never sees.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_FRAME_TAG } from '../appFrame/frameProtocol'
import { FRAME_SANDBOX } from '../appFrame/sandboxFrame'
import { installFrameWindows, postFrom, sentTo, type Sent } from '../test/LinkPreviewFramesTestUtils'
import { INVOCATION_DEADLINE_MS, MessageActionPopover, READY_TIMEOUT_MS, setMessageActionMintForTest, type CancelReason } from './MessageActionLayer'
import { messageActionGrantLabel, resolveMessageActions, type ResolvedMessageAction } from './messageActionRegistry'
import { renderedPlainText, truncateUnits } from './messageText'

const copyToClipboard = vi.fn(async (_text: string) => true)
vi.mock('../utils/clipboard', () => ({ copyToClipboard: (t: string) => copyToClipboard(t) }))
const openExternal = vi.fn()
vi.mock('../hooks/useFrameOpenLink', async (orig) => ({ ...(await orig<object>()), openExternal: (u: string) => openExternal(u) }))

const app = (over: Record<string, unknown> = {}) => ({
  name: 'notes-app',
  displayName: 'Notes',
  enabled: true,
  version: '1.0.0',
  manifest: { contributes: { messageActions: [{ id: 'save', title: 'Save to notes', entry: 'dist/frame.mjs' }] } },
  messageActionGrant: {
    actions: [{ id: 'save', title: 'Save to notes', roles: ['assistant'], format: 'plain', maxChars: 32000, popover: { width: 360, maxHeight: 480 } }],
    staged: [],
  },
  ...over,
})

describe('resolveMessageActions', () => {
  it('offers only approved, still-declared actions of enabled apps', () => {
    expect(resolveMessageActions([app()]).map((a) => a.key)).toEqual(['notes-app:save'])
    expect(resolveMessageActions([app({ enabled: false })])).toEqual([])
    // Declared but not approved: the grant row is the authority.
    expect(resolveMessageActions([app({ messageActionGrant: { actions: [] } })])).toEqual([])
    expect(resolveMessageActions([app({ messageActionGrant: undefined })])).toEqual([])
    // Approved but no longer declared (or declared with a bad entry).
    expect(resolveMessageActions([app({ manifest: { contributes: { messageActions: [] } } })])).toEqual([])
    expect(resolveMessageActions([app({ manifest: { contributes: { messageActions: [{ id: 'save', entry: '../x.mjs' }] } } })])).toEqual([])
  })

  it('caps actions per app, clamps bounds and orders by app name', () => {
    const rows = ['a', 'b', 'c'].map((id) => ({ id, title: id.toUpperCase(), roles: ['assistant', 'user', 'bogus'], format: 'markdown', maxChars: 99999, popover: { width: 9000, maxHeight: 1 } }))
    const many = app({
      name: 'zeta', displayName: 'Zeta',
      manifest: { contributes: { messageActions: rows.map((r) => ({ id: r.id, entry: 'f.mjs' })) } },
      messageActionGrant: { actions: rows },
    })
    const out = resolveMessageActions([many, app()])
    expect(out.map((a) => a.key)).toEqual(['notes-app:save', 'zeta:a', 'zeta:b'])
    const z = out[1]
    expect(z.roles).toEqual(['assistant', 'user'])
    expect([z.format, z.maxChars, z.width, z.maxHeight]).toEqual(['markdown', 32000, 480, 120])
  })

  it('names a held-back entry in plain words', () => {
    const declared = [{ id: 'save', title: 'Save to notes' }]
    expect(messageActionGrantLabel('save:role:user', declared)).toContain('Save to notes')
    expect(messageActionGrantLabel('save:format:markdown', declared)).toContain('markdown')
    expect(messageActionGrantLabel('weird', declared)).toBe('weird')
  })
})

describe('message text', () => {
  it('is the rendered text: a link gives its label, not its address', () => {
    const text = renderedPlainText('# Title\n\nSee [the doc](https://secret.example.com/?token=abc) and **bold**.\n\n- one\n- two')
    expect(text).toContain('Title')
    expect(text).toContain('See the doc and bold.')
    expect(text).not.toContain('secret.example.com')
    expect(text).not.toContain('**')
    expect(text).toMatch(/one\s+two/)
  })
  it('never cuts a surrogate pair', () => {
    expect(truncateUnits('ab\u{1F4DD}c', 3)).toEqual({ text: 'ab', truncated: true })
    expect(truncateUnits('abc', 3)).toEqual({ text: 'abc', truncated: false })
  })
})

describe('MessageActionPopover', () => {
  beforeAll(() => installFrameWindows())
  const action: ResolvedMessageAction = resolveMessageActions([app()])[0]
  const mint = vi.fn(async () => ({ frame: '/app-frame/notes-app/messageActions/save/fid/tok', frameId: 'fid', capability: 'cap-1', ttl: 900 }))
  beforeEach(() => {
    setMessageActionMintForTest(mint)
    copyToClipboard.mockClear()
    openExternal.mockClear()
    mint.mockClear()
  })
  afterEach(() => {
    setMessageActionMintForTest()
    vi.useRealTimers()
  })

  async function openFrame(onClose: (r?: CancelReason) => void = vi.fn(), markdown = 'Hello [docs](https://secret.example.com/x)') {
    const anchor = document.createElement('div')
    anchor.textContent = 'bubble'
    document.body.appendChild(anchor)
    const other = document.createElement('div')
    other.textContent = 'Other message with a secret'
    document.body.appendChild(other)
    const reason: { current: CancelReason } = { current: 'closed' }
    const view = render(<MessageActionPopover req={{ action, source: { markdown, role: 'assistant' }, anchor }} reasonRef={reason} onClose={onClose} />)
    const el = await waitFor(() => {
      const f = document.querySelector<HTMLIFrameElement>('iframe[data-message-action-frame]')
      if (!f) throw new Error('no frame yet')
      return f
    })
    await waitFor(() => expect(sentTo(el)[0]).toMatchObject({ type: 'init' }))
    return { el, view, onClose }
  }
  const from = (el: HTMLIFrameElement, type: string, data: Sent = {}) =>
    act(() => postFrom({ [APP_FRAME_TAG]: 1, type, ...data }, el.contentWindow))
  const invokeOf = (el: HTMLIFrameElement) => sentTo(el).find((m) => m.type === 'message.invoke') as Sent

  it('loads the shared sandbox and hands over this message only, as rendered text', async () => {
    const { el } = await openFrame()
    expect(el.getAttribute('sandbox')).toBe(FRAME_SANDBOX)
    expect(el.getAttribute('src')).toBe('/app-frame/notes-app/messageActions/save/fid/tok')
    expect(sentTo(el)[0]).toMatchObject({ type: 'init', capability: 'cap-1' })
    from(el, 'ready')
    const inv = invokeOf(el)
    expect(inv).toMatchObject({ text: 'Hello docs', format: 'plain', truncated: false, role: 'assistant', deadlineMs: INVOCATION_DEADLINE_MS })
    expect(typeof inv.invocationId).toBe('string')
    const everything = JSON.stringify(sentTo(el))
    expect(everything).not.toContain('secret')
    expect(everything).not.toContain('Other message')
    expect(screen.getByTestId('message-action-attribution').textContent).toContain('Notes')
  })

  it('acks a current offer, refuses a stale or out-of-order one, and copies only on click', async () => {
    const { el } = await openFrame()
    from(el, 'ready')
    const id = invokeOf(el).invocationId
    from(el, 'result.offer', { invocationId: id, seq: 1, kind: 'copy', value: 'note link' })
    expect(sentTo(el).at(-1)).toEqual(expect.objectContaining({ type: 'result.ack', invocationId: id, seq: 1 }))
    expect(copyToClipboard).not.toHaveBeenCalled()
    from(el, 'result.offer', { invocationId: id, seq: 1, kind: 'copy', value: 'again' })
    expect(sentTo(el).at(-1)).toEqual(expect.objectContaining({ type: 'result.error', code: 'stale' }))
    from(el, 'result.offer', { invocationId: 'forged', seq: 2, kind: 'copy', value: 'x' })
    expect(sentTo(el).at(-1)).toEqual(expect.objectContaining({ type: 'result.error', code: 'stale' }))
    from(el, 'result.offer', { invocationId: id, seq: 3, kind: 'open', value: 'javascript:alert(1)' })
    expect(sentTo(el).at(-1)).toEqual(expect.objectContaining({ type: 'result.error', code: 'not_allowed' }))
    fireEvent.click(screen.getByTestId('message-action-copy'))
    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith('note link'))
    expect(screen.queryByTestId('message-action-open')).toBeNull()
    from(el, 'result.offer', { invocationId: id, seq: 4, kind: 'open', value: 'https://notes.example.com/n/1' })
    const open = screen.getByTestId('message-action-open')
    expect(open.textContent).toContain('notes.example.com')
    fireEvent.click(open)
    expect(openExternal).toHaveBeenCalledWith('https://notes.example.com/n/1')
  })

  it('cancels the open invocation when the popover closes', async () => {
    const { el, view } = await openFrame()
    from(el, 'ready')
    const id = invokeOf(el).invocationId
    const sent = sentTo(el)
    view.unmount()
    expect(sent.find((m) => m.type === 'invoke.cancel')).toEqual(expect.objectContaining({ invocationId: id, reason: 'closed' }))
    expect(sent.at(-1)).toEqual(expect.objectContaining({ type: 'dispose' }))
    expect(document.querySelector('iframe[data-message-action-frame]')).toBeNull()
  })

  it('ends the invocation at its deadline, which each resize extends', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const onClose = vi.fn()
    const { el } = await openFrame(onClose)
    from(el, 'ready')
    const id = invokeOf(el).invocationId
    act(() => { vi.advanceTimersByTime(INVOCATION_DEADLINE_MS - 1000) })
    from(el, 'invocation.resize', { invocationId: id, width: 300, height: 9999 })
    act(() => { vi.advanceTimersByTime(INVOCATION_DEADLINE_MS - 1000) })
    expect(onClose).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(2000) })
    expect(onClose).toHaveBeenCalledWith('deadline')
  })

  it('says the app did not respond when the frame never gets ready', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { el } = await openFrame()
    act(() => { vi.advanceTimersByTime(READY_TIMEOUT_MS + 10) })
    expect(screen.getByTestId('message-action-failed').textContent).toContain('Notes')
    from(el, 'ready')
    expect(invokeOf(el)).toBeUndefined()
  })

  it('ignores messages from any other window, and a close for another invocation', async () => {
    const onClose = vi.fn()
    const { el } = await openFrame(onClose)
    act(() => postFrom({ [APP_FRAME_TAG]: 1, type: 'ready' }, window))
    expect(invokeOf(el)).toBeUndefined()
    from(el, 'ready')
    from(el, 'invocation.close', { invocationId: 'other' })
    expect(onClose).not.toHaveBeenCalled()
    from(el, 'invocation.close', { invocationId: invokeOf(el).invocationId })
    expect(onClose).toHaveBeenCalledWith('closed')
  })
})
