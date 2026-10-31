import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { FolderX, Loader2, Lock, Repeat, Pin } from 'lucide-react'
import { api } from '../../api/client'
import { isNotFoundError } from '../../api/apiError'
import { invalidateFoldersWhenIdle } from '../../api/chatFoldersWrite'
import { fetchSlots } from '../../store/dashboardSlice'
import { useAppDispatch, useAppStore } from '../../store'
import { gcSessionStorage } from '../../utils/storageGc'
import ErrorNotice from '../../components/ErrorNotice'
import { Btn } from '../../components/ui'
import { i18nT } from '../../i18n/t'
import { collectFolderSubtreeIds } from '../../utils/folderTree'
import { isMateManaged } from '../../utils/mateFolders'
import { isCrewmateChat } from '../../lib/agentMemorySource'
import type { ChatFolder } from '../../types'
import type { AgentInfo, Slot } from './types'
import { folderPath } from './FolderCleanupPanel'

/** Why a session in the tree is KEPT (never closed). Mirrors the folder
 *  cleanup's own refusals plus the lead's active-chat rule. */
type KeptReason = 'app' | 'member' | 'active'

/** One session the preview lists, with the flags the confirm must cover. */
interface SessionRow {
  key: string
  title: string
  path: string
  running: boolean
  /** An armed auto-nudge / monitor loop — closing it ends the loop. */
  loop: boolean
  pinned: boolean
}

/** Why a FOLDER in the tree is kept, beyond holding a kept session: the same
 *  reasons the server's cleanup keeps it (a setting the person chose, a channel
 *  folder, or a crewmate's folder). Overriding any of these would need a server
 *  change, so the preview only reports them. */
type FolderKeptReason = 'settings' | 'channel' | 'mate'

interface KeptFolder { id: string; path: string; reason: FolderKeptReason }
interface KeptSession { key: string; title: string; path: string; reason: KeptReason }
interface DeleteFolder { id: string; path: string }

/** The frozen preview: computed ONCE when the panel opens and never again, so a
 *  session or folder that appears while the panel is open is left alone and the
 *  confirm sends exactly what the person saw. */
interface Preview {
  subfolderCount: number
  toClose: SessionRow[]
  keptSessions: KeptSession[]
  keptFolders: KeptFolder[]
  foldersToDelete: DeleteFolder[]
}

/** Folder fields that mean the person configured the folder on purpose — the
 *  client mirror of `_KEEP_FIELDS` in `dashboard/chat_folder_cleanup.py`. An
 *  array field counts only when non-empty (Python treats `[]` as falsy; JS does
 *  not, so the length is checked here). */
function folderHasSetting(f: ChatFolder): boolean {
  return !!(f.project_dir || f.default_agent || f.default_destination_crew || f.color || f.icon)
    || (f.steering_dirs?.length ?? 0) > 0
    || (f.tags?.length ?? 0) > 0
}

/**
 * Compute the preview once from a snapshot of the folder list and live slots.
 * Pure, so it is called from a `useState` initializer and never recomputed.
 *
 * Mirrors the server's own keep-rules so the counts are honest: a folder is
 * kept (and every ancestor of it kept) when it holds or sits above a kept
 * session, OR when it carries a setting, is a channel folder, or is a mate's
 * folder — exactly what `removable_folder_ids` refuses. Everything else in the
 * subtree is offered for deletion.
 */
function buildPreview(
  folder: ChatFolder, folders: ChatFolder[], slots: Slot[],
  activeSlot: string | null, agents: readonly AgentInfo[], loopKeys: ReadonlySet<string>,
): Preview {
  const subtreeIds = collectFolderSubtreeIds(folders, folder.id)
  const byId = new Map(folders.map(f => [f.id, f]))

  const toClose: SessionRow[] = []
  const keptSessions: KeptSession[] = []
  // Folder ids that must stay, with every ancestor of them: a non-empty parent
  // cannot go. Seeded from kept sessions and the server's own folder keep-rules.
  const keptFolderIds = new Set<string>()
  const markChain = (fid: string | undefined) => {
    const seen = new Set<string>()
    let cur = fid ? byId.get(fid) : undefined
    while (cur && !seen.has(cur.id)) { seen.add(cur.id); keptFolderIds.add(cur.id); cur = cur.parent_id ? byId.get(cur.parent_id) : undefined }
  }

  // Folders kept for their own sake (setting / channel / mate), listed with a
  // reason. A mate's whole subtree is kept, matched by `isMateManaged`.
  const keptFolders: KeptFolder[] = []
  for (const id of subtreeIds) {
    const f = byId.get(id)
    if (!f) continue
    const reason: FolderKeptReason | null =
      isMateManaged(f, folders) ? 'mate'
      : f.channel ? 'channel'
      : folderHasSetting(f) ? 'settings'
      : null
    if (reason) { keptFolders.push({ id, path: folderPath(folders, id), reason }); markChain(id) }
  }

  for (const s of slots) {
    if (s.peer_id) continue
    const fid = s.folder_id
    if (!fid || !subtreeIds.has(fid)) continue
    const title = s.title || i18nT('pages.chatSidebar.untitled_session')
    const path = folderPath(folders, fid)
    const reason: KeptReason | null =
      s.app ? 'app'
      : isCrewmateChat(s.agent_kind, s.agent ?? '', agents) ? 'member'
      : s.key === activeSlot ? 'active'
      : null
    if (reason) { keptSessions.push({ key: s.key, title, path, reason }); markChain(fid); continue }
    toClose.push({ key: s.key, title, path, running: !!s.running, loop: loopKeys.has(s.key), pinned: !!s.pinned })
  }

  const foldersToDelete: DeleteFolder[] = [...subtreeIds]
    .filter(id => !keptFolderIds.has(id))
    .map(id => ({ id, path: folderPath(folders, id) }))
    .sort((a, b) => a.path.localeCompare(b.path))

  keptFolders.sort((a, b) => a.path.localeCompare(b.path))
  return { subfolderCount: subtreeIds.size - 1, toClose, keptSessions, keptFolders, foldersToDelete }
}

/**
 * The folder ⋮ → "Close sessions and delete…" panel, for ONE folder and every
 * folder under it. A superset of {@link FolderCleanupPanel}: it first lists the
 * sessions it will CLOSE (each exactly as the row's ✕ closes it — archived to
 * Older Sessions, revivable, nothing deleted) and the folders it will DELETE by
 * full path, then one confirm does both in order.
 *
 * Nothing changes until confirm. Confirm closes exactly the session keys the
 * preview showed, then removes the folder and its sub-folders through the
 * existing {@link api.cleanupChatFolders} with the subtree's ids and
 * `includeTopLevel` so the picked top-level folder can go. A session filed into
 * the tree after the preview is left alone (the close list is fixed), and the
 * cleanup re-checks occupancy under the folder-store lock, so a folder whose
 * session failed to close — or that gained a session after the preview — stays,
 * and every ancestor of it stays, with nothing moved to the top level.
 *
 * KEPT, never closed and listed as such: a session owned by an installed app
 * (`app`), a crew member's / mate's chat (`isCrewmateChat`), and the chat the
 * person is in right now (`activeSlot`). A kept session holds its folder chain.
 */
export default function CloseSessionsAndDeletePanel({
  folder, folders, slots, activeSlot, agents, loopKeys, onClose,
}: {
  folder: ChatFolder
  folders: ChatFolder[]
  slots: Slot[]
  activeSlot: string | null
  agents: readonly AgentInfo[]
  /** Slot keys carrying an armed loop (auto-nudge or structured monitor). */
  loopKeys: ReadonlySet<string>
  onClose: () => void
}) {
  const dispatch = useAppDispatch()
  const store = useAppStore()
  const queryClient = useQueryClient()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // FROZEN PREVIEW. Computed once, from the folder list and slots as they were
  // when the panel opened, and never recomputed: the `useState` initializer
  // runs on the first render only. So a session filed into the tree, or a
  // folder added, while the panel is open is NOT in `toClose`/`foldersToDelete`
  // and the confirm sends exactly what the person saw. (The server re-checks
  // occupancy under its lock anyway, but freezing here is what the preview
  // promise requires.)
  const [preview] = useState<Preview>(() => buildPreview(folder, folders, slots, activeSlot, agents, loopKeys))
  const { subfolderCount, toClose, keptSessions, keptFolders, foldersToDelete } = preview
  const runningCount = toClose.filter(s => s.running).length

  // Keys already closed by a prior run, and folder ids already deleted by a
  // prior run, so a retry after a partial run re-sends only what is left. The
  // frozen preview stays the source of truth for WHAT the action covers; these
  // only record progress through it. Refs, not state: they must not trigger a
  // render or reset the frozen preview, and the retry reads them synchronously.
  const succeeded = useRef<Set<string>>(new Set())
  const deletedFolders = useRef<Set<string>>(new Set())

  const run = useMutation({
    mutationFn: async () => {
      // Close each previewed session through the same DELETE the row's ✕ uses
      // (archive, revivable). A 404 means the slot is already gone — a second
      // confirm, or another tab closed it first — which is the end state this
      // action wants, so it counts as CLOSED, exactly as `chatSlice.deleteSlot`
      // treats it (`isNotFoundError` → done), and the same per-session storage
      // GC the row's close runs is run here. Only a genuine rejection counts as
      // a failure; it is kept and surfaced through ErrorNotice below. A key
      // closed on an earlier run is skipped, so a retry re-sends only failures.
      let failError: unknown = null
      let failedCloses = 0
      for (const row of toClose) {
        if (succeeded.current.has(row.key)) continue
        // The chat the person is in RIGHT NOW is never closed. Re-read the live
        // active key BEFORE EACH delete, not once: the panel stays mounted and
        // an `await` between iterations gives the person time to switch into a
        // later row, which would then be archived. The server's occupancy
        // re-check keeps a skipped session's folder chain.
        if (row.key === store.getState().chat.activeSlot) continue
        try {
          await api.deleteChatSlot(row.key)
          succeeded.current.add(row.key)
          gcSessionStorage(row.key)
        } catch (e) {
          if (isNotFoundError(e)) { succeeded.current.add(row.key); gcSessionStorage(row.key) }
          else { failedCloses += 1; failError ??= e }
        }
      }
      // The store still lists the closed slots; refresh so the cleanup's
      // occupancy read and the sidebar agree on what is live.
      await dispatch(fetchSlots())
      // Remove the folder and its sub-folders. `includeTopLevel` lets the
      // picked top-level folder go; the server re-checks occupancy under the
      // lock and deletes only the still-removable previewed ids, so a folder
      // holding a session that failed to close (and its ancestors) stays, and
      // so does one the server keeps for a reason only it knows (a saved cron
      // job files into it, or it is the default new-chat folder). The folders
      // the client already knows are kept are left out of `foldersToDelete`.
      //
      // Only the ids NOT already deleted on a prior attempt are sent, so a
      // retry's completeness is judged against what remained, not the original
      // set: a folder deleted in the first run must not count as "stayed" now.
      const remaining = foldersToDelete.map(f => f.id).filter(id => !deletedFolders.current.has(id))
      let deletedNow = 0
      if (remaining.length > 0) {
        const res = await api.cleanupChatFolders({ ids: remaining, includeTopLevel: true })
        for (const id of res.deleted ?? []) deletedFolders.current.add(id)
        deletedNow = res.deleted?.length ?? 0
      }
      return { failedCloses, failError, sent: remaining.length, deleted: deletedNow }
    },
    onSuccess: ({ failedCloses, failError, sent, deleted }) => {
      invalidateFoldersWhenIdle(queryClient)
      queryClient.invalidateQueries({ queryKey: ['folder-cleanup-preview'] })
      // Only a run where everything previewed was closed AND every folder sent
      // was deleted closes the panel. A session that genuinely would not close
      // is an ERROR the person can act on — surface it through ErrorNotice with
      // askAgent (the bare rejection is otherwise invisible), not a muted div.
      if (failedCloses > 0) {
        setError(failError instanceof Error ? failError.message : i18nT('pages.chatSidebar.some_sessions_stayed_open'))
        return
      }
      // A folder the server kept for a rule only it knows (a cron files into it,
      // the default new-chat folder, a channel name) is not an error — nothing
      // failed — so it stays a plain status notice, and the panel stays open.
      if (deleted < sent) { setNotice(i18nT('pages.chatSidebar.some_folders_stayed')); return }
      onClose()
    },
    onError: (e) => setError(e instanceof Error ? e.message : i18nT('components.errorBoundary.something_went_wrong')),
  })

  const nothingToDo = toClose.length === 0 && foldersToDelete.length === 0

  return (
    <div className="mx-2 mb-2 p-3 rounded-lg bg-bg border border-border shadow-md text-sm animate-rise" data-testid="close-and-delete-panel">
      <div className="font-medium text-text-strong mb-2">
        <FolderX size={14} className="lucide-inline" /> {i18nT('pages.chatSidebar.close_sessions_and_delete_title', { name: folder.name })}
      </div>
      <div className="text-muted text-[12px] mb-2">{i18nT('pages.chatSidebar.close_sessions_and_delete_explainer')}</div>

      {/* Totals, so the person reads the shape before the lists. */}
      <div className="text-[12px] text-text mb-2" data-testid="close-and-delete-totals">
        {i18nT('pages.chatSidebar.close_delete_totals', {
          subfolders: i18nT('pages.chatSidebar.n_subfolders', { count: subfolderCount }),
          sessions: i18nT('pages.chatSidebar.n_sessions', { count: toClose.length }),
          running: i18nT('pages.chatSidebar.n_running', { count: runningCount }),
        })}
      </div>
      {toClose.length > 0 && (
        <div className="mb-3">
          <div className="text-[11px] uppercase tracking-wide text-muted mb-1">{i18nT('pages.chatSidebar.sessions_to_close')}</div>
          <div className="max-h-40 overflow-y-auto rounded-md border border-border bg-bg-elevated p-1.5" data-testid="close-and-delete-sessions">
            {toClose.map(s => (
              <div key={s.key} className="flex items-center gap-1.5 text-[12px] text-muted py-0.5 px-1" data-testid="close-and-delete-session">
                <span className="truncate" title={`${s.path} / ${s.title}`}>{s.path ? `${s.path} / ` : ''}{s.title}</span>
                <span className="ml-auto shrink-0 inline-flex items-center gap-1.5">
                  {s.running && <span className="inline-flex items-center gap-0.5 text-[11px] text-warn-fg" title={i18nT('pages.chatSidebar.flag_turn_running')} data-testid="flag-running"><Loader2 size={11} className="animate-spin" aria-hidden="true" />{i18nT('pages.chatSidebar.flag_turn_running')}</span>}
                  {s.loop && <span className="inline-flex items-center gap-0.5 text-[11px] opacity-70" title={i18nT('pages.chatSidebar.flag_loop_will_end')} data-testid="flag-loop"><Repeat size={11} aria-hidden="true" />{i18nT('pages.chatSidebar.flag_loop_will_end')}</span>}
                  {s.pinned && <span className="inline-flex items-center gap-0.5 text-[11px] opacity-70" title={i18nT('pages.chatSidebar.flag_pinned')} data-testid="flag-pinned"><Pin size={11} aria-hidden="true" />{i18nT('pages.chatSidebar.flag_pinned')}</span>}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {keptSessions.length > 0 && (
        <div className="mb-3">
          <div className="text-[11px] uppercase tracking-wide text-muted mb-1">{i18nT('pages.chatSidebar.sessions_kept')}</div>
          <div className="max-h-28 overflow-y-auto rounded-md border border-border bg-bg-elevated p-1.5" data-testid="close-and-delete-kept">
            {keptSessions.map(s => (
              <div key={s.key} className="flex items-center gap-1.5 text-[12px] text-muted py-0.5 px-1" data-testid="close-and-delete-kept-row">
                <Lock size={11} className="shrink-0 opacity-60" aria-hidden="true" />
                <span className="truncate" title={`${s.path} / ${s.title}`}>{s.path ? `${s.path} / ` : ''}{s.title}</span>
                <span className="ml-auto shrink-0 text-[11px] opacity-60">
                  {s.reason === 'app' ? i18nT('pages.chatSidebar.kept_reason_app')
                    : s.reason === 'member' ? i18nT('pages.chatSidebar.kept_reason_member')
                    : i18nT('pages.chatSidebar.kept_reason_active')}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {foldersToDelete.length > 0 && (
        <div className="mb-3">
          <div className="text-[11px] uppercase tracking-wide text-muted mb-1">{i18nT('pages.chatSidebar.folders_to_delete')}</div>
          <div className="max-h-40 overflow-y-auto rounded-md border border-border bg-bg-elevated p-1.5" data-testid="close-and-delete-folders">
            {foldersToDelete.map(f => (
              <div key={f.id} className="flex items-center gap-1 text-[12px] text-muted py-0.5 px-1" data-testid="close-and-delete-folder">
                <span className="truncate" title={f.path}>{f.path}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {keptFolders.length > 0 && (
        <div className="mb-3">
          <div className="text-[11px] uppercase tracking-wide text-muted mb-1">{i18nT('pages.chatSidebar.folders_kept')}</div>
          <div className="max-h-28 overflow-y-auto rounded-md border border-border bg-bg-elevated p-1.5" data-testid="close-and-delete-kept-folders">
            {keptFolders.map(f => (
              <div key={f.id} className="flex items-center gap-1.5 text-[12px] text-muted py-0.5 px-1" data-testid="close-and-delete-kept-folder">
                <Lock size={11} className="shrink-0 opacity-60" aria-hidden="true" />
                <span className="truncate" title={f.path}>{f.path}</span>
                <span className="ml-auto shrink-0 text-[11px] opacity-60">
                  {f.reason === 'settings' ? i18nT('pages.chatSidebar.folder_kept_settings')
                    : f.reason === 'channel' ? i18nT('pages.chatSidebar.folder_kept_channel')
                    : i18nT('pages.chatSidebar.folder_kept_mate')}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {nothingToDo && <div className="text-[12px] text-muted mb-2">{i18nT('pages.chatSidebar.nothing_to_close_or_delete')}</div>}

      {notice && <div className="text-[12px] text-muted mb-2" role="status" data-testid="close-and-delete-notice">{notice}</div>}
      <ErrorNotice message={error} askAgent className="mb-2" testId="close-and-delete-error" />

      <div className="flex flex-wrap items-center gap-2 justify-end">
        <Btn className="text-[12px] px-3 py-1" onClick={onClose}>{i18nT('pages.chatSidebar.cancel')}</Btn>
        {!nothingToDo && (
          <Btn
            danger
            className="text-[12px] px-2 py-1 whitespace-nowrap"
            data-testid="close-and-delete-confirm"
            disabled={run.isPending}
            onClick={() => { setError(''); setNotice(''); run.mutate() }}
          >{run.isPending
            ? i18nT('pages.chatSidebar.closing_and_deleting')
            : i18nT('pages.chatSidebar.close_n_delete_m', {
                sessions: i18nT('pages.chatSidebar.n_sessions', { count: toClose.length }),
                folders: i18nT('pages.chatSidebar.m_folders', { count: foldersToDelete.length }),
              })}</Btn>
        )}
      </div>
    </div>
  )
}
