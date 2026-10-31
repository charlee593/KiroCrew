/**
 * A message's app actions, as rows of its More menu.
 *
 * Each row names the action and the app it belongs to, so the click that hands
 * the app this message's text is the consent for it. The rows sit in More, never
 * as row buttons: the message footer keeps its two-control limit whatever apps
 * are installed.
 *
 * @module messageActions/MessageActionMenuItems
 */
import { useSyncExternalStore } from 'react'
import { AppWindow } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuSeparator } from '../components/ui/dropdown-menu'
import { i18nT } from '../i18n/t'
import {
  getMessageActions,
  openMessageAction,
  subscribeMessageActions,
  type MessageRole,
  type ResolvedMessageAction,
} from './messageActionRegistry'

export const NO_ACTIONS: readonly ResolvedMessageAction[] = []

/** The approved actions offered on a message of this role. */
export function useMessageActionsFor(role: MessageRole, enabled = true): readonly ResolvedMessageAction[] {
  const all = useSyncExternalStore(subscribeMessageActions, getMessageActions, () => NO_ACTIONS)
  if (!enabled) return NO_ACTIONS
  return all.filter((a) => a.roles.includes(role))
}

export default function MessageActionMenuItems({ actions, messageRole, markdown, anchor }: {
  actions: readonly ResolvedMessageAction[]
  messageRole: MessageRole
  /** The message as shown, in markdown. */
  markdown: string
  /** The message bubble: the popover anchors to it. */
  anchor: () => HTMLElement | null
}) {
  if (!actions.length || !markdown.trim()) return null
  return (
    <>
      <DropdownMenuSeparator />
      {actions.map((a) => (
        <DropdownMenuItem
          key={a.key}
          data-testid="message-action-item"
          data-message-action={a.key}
          aria-label={i18nT('components.messageActions.item_label', { title: a.title, app: a.appLabel })}
          onSelect={() => {
            const el = anchor()
            if (el) openMessageAction({ action: a, source: { markdown, role: messageRole }, anchor: el })
          }}
        >
          {/* Layout and the touch floor live on this span: the primitive owns its own classes. */}
          <span className="flex flex-col gap-0.5 [@media(hover:none)]:min-h-7">
            <span className="flex items-center gap-2">
              <AppWindow className="lucide-inline shrink-0" />
              <span>{a.title}</span>
            </span>
            <span className="text-[11px] leading-4 text-muted pl-[21px]">{a.appLabel}</span>
          </span>
        </DropdownMenuItem>
      ))}
    </>
  )
}
