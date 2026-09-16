import * as React from "react"
import { useNavigate } from "react-router-dom"
import { Editor, EditorContent, EditorContext, useEditor } from "@tiptap/react"

// --- Tiptap Core Extensions ---
import { StarterKit } from "@tiptap/starter-kit"
import { TaskItem, TaskList } from "@tiptap/extension-list"
import { TextAlign } from "@tiptap/extension-text-align"
import { Typography } from "@tiptap/extension-typography"
import { Highlight } from "@tiptap/extension-highlight"
import { Subscript } from "@tiptap/extension-subscript"
import { Superscript } from "@tiptap/extension-superscript"
import { Selection } from "@tiptap/extensions"
import { getHierarchicalIndexes, TableOfContents, type TableOfContentDataItem } from "@tiptap/extension-table-of-contents"

// --- Custom Extensions ---
import { MarkdownConversion } from '@/extensions/markdown-conversion'
import { LinkClick } from '@/extensions/link-click'

// --- UI Primitives ---
import { Button } from "@/components/tiptap-ui-primitive/button"
import { Spacer } from "@/components/tiptap-ui-primitive/spacer"
import {
  Toolbar,
  ToolbarGroup,
  ToolbarSeparator,
} from "@/components/tiptap-ui-primitive/toolbar"

// --- Tiptap Node ---
import { AssetImage, SELECTION_AWARENESS_FIELD } from "@/components/tiptap-node/image-node/image-node-extension"
import { HorizontalRule } from "@/components/tiptap-node/horizontal-rule-node/horizontal-rule-node-extension"
import { NoteLink, noteTitleFor, type NoteLinkApi } from "@/components/tiptap-node/note-link-node/note-link-node-extension"
import { Table } from "@/components/tiptap-node/table-node/table-node-extension"
import "@/components/tiptap-node/blockquote-node/blockquote-node.scss"
import "@/components/tiptap-node/code-block-node/code-block-node.scss"
import "@/components/tiptap-node/horizontal-rule-node/horizontal-rule-node.scss"
import "@/components/tiptap-node/list-node/list-node.scss"
import "@/components/tiptap-node/image-node/image-node.scss"
import "@/components/tiptap-node/note-link-node/note-link-node.scss"
import "@/components/tiptap-node/heading-node/heading-node.scss"
import "@/components/tiptap-node/paragraph-node/paragraph-node.scss"
import "@/components/tiptap-node/table-node/table-node.scss"

// --- Tiptap UI ---
import { HeadingDropdownMenu } from "@/components/tiptap-ui/heading-dropdown-menu"
import { ImageUploadButton, type ImageUploadFn } from "@/components/tiptap-ui/image-upload-button"
import { ListDropdownMenu } from "@/components/tiptap-ui/list-dropdown-menu"
import { BlockquoteButton } from "@/components/tiptap-ui/blockquote-button"
import { CodeBlockButton } from "@/components/tiptap-ui/code-block-button"
import { TableButton } from "@/components/tiptap-ui/table-button"
import {
  ColorHighlightPopover,
  ColorHighlightPopoverContent,
  ColorHighlightPopoverButton,
} from "@/components/tiptap-ui/color-highlight-popover"
import {
  LinkPopover,
  LinkContent,
  LinkButton,
  onLinkPopoverOpenRequest,
} from "@/components/tiptap-ui/link-popover"
import { MarkButton } from "@/components/tiptap-ui/mark-button"
import { TextAlignButton } from "@/components/tiptap-ui/text-align-button"
import { UndoRedoButton } from "@/components/tiptap-ui/undo-redo-button"

// --- Custom UI ---
import { CollaborationStatusMenu, type ActiveUser } from "@/components/custom-ui/collaboration-dropdown-menu"
import { SidePanelButton } from "@/components/custom-ui/side-panel-button"
import { MoreActionsButton } from "@/components/custom-ui/more-actions-button"
import { SidePanel } from "@/components/custom-ui/side-panel"
import { type NodeId } from "@/components/custom-ui/file-browser"
import { ToC } from "@/components/custom-ui/table-of-contents"
import { FileExplorerDropdownMenu } from "@/components/custom-ui/file-explorer-dropdown-menu"
import { FileTreeHost, type FileTreeHostHandle } from "@/components/custom-ui/file-browser/file-tree-host"
import { AssetPreviewPane } from "@/components/custom-ui/asset-preview/asset-preview-pane"
import { FileExplorerToolbar } from "@/components/custom-ui/file-explorer-toolbar"
import {
  NoteTabBar,
  type NoteTabBarHandle,
} from "@/components/custom-ui/note-tab-bar"
import { NewTabView } from "@/components/custom-ui/new-tab-view/new-tab-view"
import { NoteQuickSwitcher } from "@/components/custom-ui/note-quick-switcher/note-quick-switcher"
import { MoveToPicker } from "@/components/custom-ui/move-to-picker/move-to-picker"
import { SharedNoteBar, SyncStatusIndicator, ViewOnlyBanner, EditingIdentityBubble, type SyncStatus, type SharedPermission } from "@/components/custom-ui/shared-note-bar"

// -- Context Menu ---
import { ContextMenu } from "@/components/custom-ui/context-menu"
import { resolveSpec, type MenuRoute } from "@/components/custom-ui/context-menu/menu-router";
import { whenAnyPathIncludes, whenDomMatches, whenToolbar, whenEditor, whenEditorPanel, whenTabbar } from "@/components/custom-ui/context-menu/predicates";
import { headingSpec, imageSpec, noteLinkSpec, tableSpec, defaultSpec, editorSpec, textSpec, toolbarSpec, toolbarMoreSpec, tabbarSpec } from "@/components/custom-ui/context-menu/specs";

// --- Collaboration ---
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { WebrtcProvider } from "y-webrtc"

// --- Icons ---
import { ArrowLeftIcon } from "@/components/tiptap-icons/arrow-left-icon"
import { HighlighterIcon } from "@/components/tiptap-icons/highlighter-icon"
import { LinkIcon } from "@/components/tiptap-icons/link-icon"
import { RiHome4Line, RiListUnordered, RiSearchLine, RiNodeTree } from "@remixicon/react"
import { NoteGraph } from "@/components/custom-ui/note-graph/note-graph"

// --- Hooks ---
import { useIsMobile } from "@/hooks/use-mobile"
import { useNotePresence } from "@/hooks/use-note-presence"
import { useUnreadNoteIds, markNoteViewed } from "@/hooks/use-unread-notes"
import { useWindowSize } from "@/hooks/use-window-size"
import { useCursorVisibility } from "@/hooks/use-cursor-visibility"
import type { NotebookFileSystemApi } from "@/components/custom-ui/file-browser/use-notebook-filesystem"
import { useFileCommands } from "@/components/custom-ui/file-browser/use-file-commands"

// --- Components ---
import { ThemeToggle } from "./theme-toggle"
import { SettingsMenu } from "@/components/custom-ui/settings-menu/settings-menu"
import { useEditorSettings, lineWidths, editorFonts } from "@/components/custom-ui/ui-store/editor-settings-store"

// --- Lib ---
import { handleImageUpload } from "@/lib/tiptap-utils"
import { getOrCreateYDoc, SIGNALING_SERVERS } from "@/lib/yjs-utils"
import { setNoteTitle, getNoteLinkAccess, setNoteLinkAccess, getNoteOwnerName, setNoteOwnerName, isNoteLinkAccessInherited, setNoteLinkAccessInherited, type LinkAccess } from "@/lib/note-meta"
import { getImageAsset } from "@/lib/image-assets"
import { getOrCreateGuestIdentity, setGuestName } from "@/lib/guest-identity"
import { P2PImageAssetTransfer } from "@/lib/p2p-image-assets"
import { downloadFile } from "@/lib/download-file"
import { exportNoteContent, fileExtensionForFormat, mimeTypeForFormat, type NoteExportFormat } from "@/lib/note-export"
import { importNoteContent, type NoteImportItem } from "@/lib/note-import"
import { NoteImageRefIndex } from "@/lib/note-image-refs"

// --- Styles ---
import "./editor.scss"
import "@/components/custom-ui/table-of-contents/table-of-contents.scss"

import { useInlineTitleVisible, useToolbarVisible } from "@/components/custom-ui/ui-store/ui-store"
import { findNode, findAssetNode, setNodeLinkAccess, touchNodeModifiedAt, collectLeaves, type FileTreeSortOrder } from "@/components/custom-ui/file-browser/tree"

function pathSegments(path: string | undefined, fallbackName: string) {
  return (path || fallbackName)
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
}

const MemorizedToC = React.memo(ToC)

const MainToolbarContent = ({
  editor,
  onHighlighterClick,
  onLinkClick,
  isMobile,
  uploadImage,
  getActiveTitle,
  rightSlot,
}: {
  editor: Editor | null
  onHighlighterClick: () => void
  onLinkClick: () => void
  isMobile: boolean
  uploadImage: ImageUploadFn
  getActiveTitle: () => string
  rightSlot?: React.ReactNode
}) => {
  return (
    <>
      <Spacer />

      <ToolbarGroup>
        <UndoRedoButton action="undo" />
        <UndoRedoButton action="redo" />
      </ToolbarGroup>

      <ToolbarSeparator />

      <ToolbarGroup>
        <HeadingDropdownMenu levels={[1, 2, 3, 4]} portal={isMobile} />
        <ListDropdownMenu
          types={["bulletList", "orderedList", "taskList"]}
          portal={isMobile}
        />
        <BlockquoteButton />
        <CodeBlockButton />
      </ToolbarGroup>

      <ToolbarSeparator />

      <ToolbarGroup>
        <MarkButton type="bold" />
        <MarkButton type="italic" />
        <MarkButton type="strike" />
        <MarkButton type="code" />
        <MarkButton type="underline" />
        {!isMobile ? (
          <ColorHighlightPopover />
        ) : (
          <ColorHighlightPopoverButton onClick={onHighlighterClick} />
        )}
        {!isMobile ? <LinkPopover autoOpenOnLinkActive={false} /> : <LinkButton onClick={onLinkClick} />}
      </ToolbarGroup>

      <ToolbarSeparator />

      <ToolbarGroup>
        <MarkButton type="superscript" />
        <MarkButton type="subscript" />
      </ToolbarGroup>

      <ToolbarSeparator />

      <ToolbarGroup>
        <TextAlignButton align="left" />
        <TextAlignButton align="center" />
        <TextAlignButton align="right" />
        <TextAlignButton align="justify" />
      </ToolbarGroup>

      <ToolbarSeparator />

      <ToolbarGroup>
        <ImageUploadButton text="Add" upload={uploadImage} />
        <TableButton />
      </ToolbarGroup>

      <ToolbarSeparator />

      <ToolbarGroup>
        <MoreActionsButton editor={editor} spec={toolbarMoreSpec} extraContext={{ getActiveTitle }} />
      </ToolbarGroup>

      {rightSlot ?? <Spacer />}

      {isMobile && <ToolbarSeparator />}
    </>
  )
}

const MobileToolbarContent = ({
  type,
  onBack,
}: {
  type: "highlighter" | "link"
  onBack: () => void
}) => (
  <>
    <ToolbarGroup>
      <Button data-style="ghost" onClick={onBack}>
        <ArrowLeftIcon className="tiptap-button-icon" />
        {type === "highlighter" ? (
          <HighlighterIcon className="tiptap-button-icon" />
        ) : (
          <LinkIcon className="tiptap-button-icon" />
        )}
      </Button>
    </ToolbarGroup>

    <ToolbarSeparator />

    {type === "highlighter" ? (
      <ColorHighlightPopoverContent />
    ) : (
      <LinkContent />
    )}
  </>
)

function useAwarenessUsers(
  providerRef: React.RefObject<WebrtcProvider | null>,
  providerReady: boolean,
  providerGeneration: number,
  scopeKey: string | null,
) {
  const [scopedUsers, setScopedUsers] = React.useState<{
    scopeKey: string | null
    users: ActiveUser[]
  }>({ scopeKey: null, users: [] })

  React.useEffect(() => {
    setScopedUsers({ scopeKey, users: [] })

    if (!providerReady || !scopeKey) return

    const provider = providerRef.current
    if (!provider) return

    const awareness = provider.awareness
    let disposed = false

    const recompute = () => {
      // Map<clientId, state>
      const list: ActiveUser[] = Array.from(awareness.getStates().entries()).map(
        ([clientId, state]) => {
          const u = (state?.user ?? {}) as { name?: string; color?: string }
          return {
            id: String(clientId),
            name: u.name ?? "Anonymous",
            color: u.color,
            active: true,
            isYou: clientId === awareness.clientID,
          }
        }
      )
      if (!disposed) {
        setScopedUsers({ scopeKey, users: list })
      }
    }

    recompute()
    awareness.on("change", recompute)
    return () => {
      disposed = true
      awareness.off("change", recompute)
    }
    // providerGeneration deliberately included: see its declaration for why
    // providerReady alone can miss a reconnect that swaps the underlying
    // provider object without an intervening render.
  }, [providerRef, providerReady, providerGeneration, scopeKey])

  if (!providerReady || scopedUsers.scopeKey !== scopeKey) {
    return []
  }

  return scopedUsers.users
}

export type SimpleEditorProps = {
  notebookId: string
  noteId?: string | null
  title?: string
  onTitleChange?: (title: string) => void
  theme?: "light" | "dark" | "system",
  collaborationEnabled?: boolean
  fileSystem: NotebookFileSystemApi
  rootNodeId: NodeId | null
  hasNotebookContext: boolean
  onNavigateNote: (noteId: string) => void
  onCloseLastNote?: () => void
  onNotebookCreated?: (notebookId: string, welcomeNoteId: string) => void
  showNoteTabs?: boolean
  showNotebookLockIndicator?: boolean
  allowFileCreation?: boolean
  initialLinkAccess?: LinkAccess
  /** Prevent the Yjs meta from upgrading linkAccess beyond "view". */
  viewOnly?: boolean
  /**
   * Renders the minimal shared-note shell instead of the full workspace:
   * no file tree/notebook switcher/tabs, a provenance + presence bar in
   * their place, and an actually-enforced read-only state for view links.
   */
  isSharedView?: boolean
  /**
   * Shows the file tree side panel even in a shared view — for a shared
   * *notebook* link (multiple notes to browse), unlike a shared single-note
   * link where there's nothing to browse. The notebook-switcher/manage-
   * notebooks entry point stays hidden either way; isSharedView still
   * governs the permission model.
   */
  showFileBrowser?: boolean
}



export function SimpleEditor({
  notebookId,
  noteId,
  title,
  onTitleChange,
  theme: _theme = "system",
  collaborationEnabled = true,
  fileSystem,
  rootNodeId,
  hasNotebookContext,
  onNavigateNote,
  onCloseLastNote,
  onNotebookCreated,
  showNoteTabs = false,
  showNotebookLockIndicator = true,
  allowFileCreation = true,
  initialLinkAccess = "restricted",
  viewOnly = false,
  isSharedView = false,
  showFileBrowser = false,
}: SimpleEditorProps) {
  const isMobile = useIsMobile()
  const { height } = useWindowSize()
  const navigate = useNavigate()
  const fs = fileSystem
  const setFileTree = fs.setTree
  const [mobileView, setMobileView] = React.useState<
    "main" | "highlighter" | "link"
  >("main")
  const toolbarRef = React.useRef<HTMLDivElement>(null)
  const [currentUser, setCurrentUser] = React.useState(getOrCreateGuestIdentity)
  const [ownerName, setOwnerNameState] = React.useState<string | undefined>(undefined)
  const [syncStatus, setSyncStatus] = React.useState<SyncStatus>("offline")
  const [lastSyncedAt, setLastSyncedAt] = React.useState<Date | null>(null)
  const providerRef = React.useRef<WebrtcProvider | null>(null)
  const imageTransferRef = React.useRef<P2PImageAssetTransfer | null>(null)
  const imageRefIndexRef = React.useRef<NoteImageRefIndex | null>(null)
  // Read fresh by the NoteLink node view/suggestion on every lookup instead
  // of being an extension option, so a note being renamed or created
  // elsewhere in the notebook doesn't force `extensions` to be recreated
  // (which would remount this editor). Kept current below, after
  // `handleSelectNote` exists.
  const noteLinkApiRef = React.useRef<NoteLinkApi | null>(null)
  // `.configure()` deep-merges plain option objects, which would clone a
  // ref passed directly and disconnect it from `noteLinkApiRef` above — so
  // NoteLink is configured with this stable getter instead, which always
  // reads the ref's latest value via closure at call time.
  const getNoteLinkApi = React.useCallback(() => noteLinkApiRef.current, [])
  // Read inside the provider effect's cleanup to tell "switching to another
  // public note" (keep the signaling socket warm) apart from "collaboration
  // is actually turning off" (fully disconnect). Updated during render so the
  // cleanup, which runs with a stale closure, sees the upcoming value.
  const collaborationActiveRef = React.useRef(false)
  const forceReconnectRef = React.useRef(false)
  const [providerReady, setProviderReady] = React.useState(false)
  // Bumped every time a *new* WebrtcProvider object is actually created
  // (reconnects included). A reconnect's effect cleanup+setup both run
  // synchronously in the same flush, so providerReady itself goes
  // false-then-true without an intervening render — extensions below,
  // which only depends on providerReady, would never see that as a change
  // and would keep the CollaborationCaret plugin bound to the destroyed
  // provider's now-dead awareness object forever (content still syncs, via
  // the stable Y.Doc, but the caret silently stops — usually the reported
  // "text updates but no caret, fixed by a refresh" symptom). This
  // generation counter has no such coalescing problem: it strictly
  // increments once per real provider, so including it below forces
  // extensions to always rebuild against whichever provider is current.
  const [providerGeneration, setProviderGeneration] = React.useState(0)
  const [reconnectNonce, setReconnectNonce] = React.useState(0)
  const wrapperRef = React.useRef<HTMLDivElement | null>(null); // For layout measurements
  const editorAreaRef = React.useRef<HTMLDivElement | null>(null); // For context menu container
  const fileTreeRef = React.useRef<FileTreeHostHandle | null>(null)
  const noteTabBarRef = React.useRef<NoteTabBarHandle | null>(null)
  const titleInputRef = React.useRef<HTMLInputElement | null>(null)
  const pendingTitleSelectionNoteIdRef = React.useRef<NodeId | null>(null)
  const activeTitleNoteIdRef = React.useRef<NodeId | null>(null)

  const [isLeftSidePanelOpen, setIsLeftSidePanelOpen] = React.useState(true)
  const [isRightSidePanelOpen, setIsRightSidePanelOpen] = React.useState(false)
  const [rightPanelView, setRightPanelView] = React.useState<"outline" | "graph">("outline")

  const [items, setItems] = React.useState<TableOfContentDataItem[]>([])
  const [selectedNoteId, setSelectedNoteId] = React.useState<NodeId | undefined | null>(noteId);
  const [previewNodeId, setPreviewNodeId] = React.useState<NodeId | null>(null)
  // Virtual "New tab" pills: ids of every one currently open in the strip,
  // and which one (if any) is the one currently shown in the editor area.
  // Switching to a different real note/asset just deactivates the current
  // one (it stays open, like a real tab) — only its own actions (create,
  // find, close) remove it from `newTabIds`.
  const [newTabIds, setNewTabIds] = React.useState<string[]>([])
  const [activeNewTabId, setActiveNewTabId] = React.useState<string | null>(null)
  const [isQuickSwitcherOpen, setIsQuickSwitcherOpen] = React.useState(false)
  // Doc position of the note link being retargeted via the context menu's
  // "Edit link" action; non-null while its note picker is open.
  const [editingNoteLinkPos, setEditingNoteLinkPos] = React.useState<number | null>(null)
  const [moveToNoteIds, setMoveToNoteIds] = React.useState<NodeId[] | null>(null)

  const [editorReady, setEditorReady] = React.useState(false)
  const [linkAccess, setLinkAccess] = React.useState<LinkAccess>(initialLinkAccess)
  // True once Yjs meta has delivered a real value (IDB load or P2P sync).
  // Until then we default the verb to "Viewing" to avoid showing "Editing"
  // prematurely on notes that turn out to be view-only.
  const [permissionConfirmed, setPermissionConfirmed] = React.useState(false)
  const [fileTreeSortOrder, setFileTreeSortOrder] = React.useState<FileTreeSortOrder>("name-asc")

  const hasActiveNote = hasNotebookContext && !!selectedNoteId
  const previewNode = previewNodeId ? findNode(fs.tree, previewNodeId).node : null
  const activeTabId = typeof (previewNodeId ?? selectedNoteId) === "string"
    ? previewNodeId ?? selectedNoteId
    : null
  const activeTitleNoteId = typeof noteId === "string"
    ? noteId
    : typeof selectedNoteId === "string"
      ? selectedNoteId
      : null
  const activeTitle = React.useMemo(() => {
    if (activeTitleNoteId) {
      const { node } = findNode(fs.tree, activeTitleNoteId)
      if (node && !node.isFolder) {
        return node.name.trim() || "Untitled"
      }
    }

    return title?.trim() || "Untitled"
  }, [activeTitleNoteId, fs.tree, title])
  const [titleDraft, setTitleDraft] = React.useState(activeTitle)
  const editorSettings = useEditorSettings()
  const toolbarVisible = useToolbarVisible();
  const inlineTitleVisible = useInlineTitleVisible();

  React.useEffect(() => {
    activeTitleNoteIdRef.current = activeTitleNoteId
  }, [activeTitleNoteId])

  const note = React.useMemo(() => {
    if (!noteId || !notebookId) return undefined;
    const { doc, idb } = getOrCreateYDoc(notebookId, noteId);
    return { doc, idb }
  }, [notebookId, noteId])

  const syncNoteLinkAccessToTree = React.useCallback(
    (id: NodeId | undefined | null, access: LinkAccess) => {
      if (!id || typeof id !== "string") return
      setFileTree((tree) => setNodeLinkAccess(tree, id, access))
    },
    [setFileTree],
  )

  const touchActiveNoteModifiedAt = React.useCallback(
    (props?: { transaction?: { docChanged?: boolean; getMeta: (key: string) => any } }) => {
      if (!noteId) return
      // y-prosemirror tags any transaction that applies an incoming Yjs
      // update — the note's initial sync on open as much as a live remote
      // edit — with isChangeOrigin. Only a genuine local keystroke lacks it,
      // so only that should bump the shared modifiedAt driving unread
      // badges; otherwise merely opening a note would mark it "edited" for
      // every other collaborator.
      const isSyncOrigin = Boolean(props?.transaction?.getMeta("y-sync$")?.isChangeOrigin)
      // editor.setEditable() (see the isEditable effect below — it flips
      // shortly after a shared note loads, once permission is confirmed)
      // fires this same onUpdate with a fresh no-op transaction that never
      // touched the doc. Require docChanged so that alone can't bump
      // modifiedAt either.
      const docChanged = props?.transaction?.docChanged === true
      if (docChanged && !isSyncOrigin) {
        setFileTree((tree) => touchNodeModifiedAt(tree, noteId))
      }
      // Still counts as "read" either way — we're watching this note live,
      // so switching away right after doesn't flag it unread.
      markNoteViewed(noteId)
    },
    [noteId, setFileTree],
  )

  // Keeps the active note's "viewed" timestamp in lockstep with its
  // modifiedAt in the shared tree, for as long as it stays active. A
  // collaborator's edit updates two separate things over the wire — the
  // tree's modifiedAt (via the notebook's index doc) and the note's own
  // content (via its own per-note doc) — and they don't necessarily arrive
  // together. touchActiveNoteModifiedAt only refreshes markNoteViewed when
  // *this* note's own editor processes an incoming content update; if the
  // tree's modifiedAt bump arrives first and we switch notes before the
  // content sync catches up, that onUpdate never fires and the note is left
  // looking unread despite having been open the whole time the edit happened.
  React.useEffect(() => {
    if (!noteId) return
    const node = findNode(fs.tree, noteId).node
    if (node && !node.isFolder && node.modifiedAt) {
      markNoteViewed(noteId, node.modifiedAt)
    }
  }, [fs.tree, noteId])

  React.useEffect(() => {
    if (!note?.doc) return

    // Opening a note counts as reading whatever's already in it, independent
    // of whether the editor's own onUpdate fires for the initial content sync.
    markNoteViewed(noteId)

    const meta = note.doc.getMap<any>("meta")

    // Always reflect this note's actual access on load, otherwise switching
    // from a shared note to a restricted one leaves the previous value stale.
    // Exception: a guest's local doc has no synced meta yet on first load, so
    // its default "restricted" would clobber the access level the share link
    // bootstrapped us with before the real value arrives over the wire and
    // kill the connection before it can sync.
    //
    // This also bites an *owner* opening a note they didn't personally
    // create — e.g. a collaborator added it elsewhere in a shared notebook.
    // Its structural tree entry has already synced (the notebook's own
    // WebRTC room), but this note's own per-note doc hasn't, since nothing
    // connects it until someone actually opens it — which nobody here ever
    // has. Reading straight from a still-empty local meta would default to
    // "restricted" and, since owners trust that immediately, permanently
    // block this note's own connection from ever starting. Fall back to the
    // tree's cached linkAccess hint (stamped at creation, see
    // useFileCommands) in that case instead of the bare default.
    const treeAccessHint = !meta.has("linkAccess") ? findNode(fs.tree, noteId ?? null).node?.linkAccess : undefined
    const initialAccess = meta.has("linkAccess") ? getNoteLinkAccess(meta) : (treeAccessHint ?? "restricted")
    // viewOnly pages never upgrade beyond "view" even if the note metadata says "edit"
    const cappedInitialAccess: LinkAccess = viewOnly && initialAccess === "edit" ? "view" : initialAccess
    // Only withhold "restricted" from a shared view when we have no concrete
    // information yet (meta key absent AND no tree hint) — that's the race
    // where the real value hasn't arrived over the wire yet and "restricted"
    // is just the bare default. If either the note's own meta or the tree
    // explicitly says "restricted", trust it immediately so collaboration
    // doesn't start for a note that is genuinely not shared.
    const hasExplicitAccess = meta.has("linkAccess") || treeAccessHint !== undefined
    if (!isSharedView || initialAccess !== "restricted" || hasExplicitAccess) {
      setPermissionConfirmed(true)
      setLinkAccess(cappedInitialAccess)
    }
    syncNoteLinkAccessToTree(noteId, initialAccess)

    // Backfill provenance for notes shared before owner-name recording existed,
    // or whose access was already non-restricted on creation (so the "first
    // person to change access" hook in handleLinkAccessChange never fired).
    if (!isSharedView && initialAccess !== "restricted" && !getNoteOwnerName(meta)) {
      setNoteOwnerName(meta, currentUser.name)
    }
    setOwnerNameState(getNoteOwnerName(meta))
    const storedTs = localStorage.getItem(`lastSyncedAt:${noteId}`)
    if (storedTs) setLastSyncedAt(new Date(Number(storedTs)))

    const observer = (event: any) => {
      if (event.keysChanged.has("ownerName")) {
        setOwnerNameState(getNoteOwnerName(meta))
      }

      if (!event.keysChanged.has("linkAccess")) return
      const rawAccess = getNoteLinkAccess(meta)
      syncNoteLinkAccessToTree(noteId, rawAccess)
      // Receiver ignores "restricted" updates to avoid not receiving more updates
      if (rawAccess === "restricted") return
      setPermissionConfirmed(true)
      setLinkAccess(viewOnly && rawAccess === "edit" ? "view" : rawAccess)
    }

    meta.observe(observer)

    return () => {
      meta.unobserve(observer)
    }
  }, [note?.doc, noteId, syncNoteLinkAccessToTree, isSharedView, viewOnly, currentUser.name])

  const collaborationActive = collaborationEnabled && linkAccess !== "restricted"
  collaborationActiveRef.current = collaborationActive
  const notePresence = useNotePresence(collaborationActive ? (fileSystem.indexProvider ?? null) : null)
  const unreadNoteIds = useUnreadNoteIds(fs.tree, noteId)
  const rootId = rootNodeId

  const isViewOnly = isSharedView && linkAccess === "view"
  const isRevoked = isSharedView && linkAccess === "restricted"
  // In a shared view, don't claim "edit" until Yjs has confirmed the actual
  // permission — prevents "Can edit" / "Editing" and an editable UI flashing
  // for view-only users during the window before the first meta sync.
  const sharedPermission: SharedPermission = isRevoked ? "revoked"
    : isViewOnly ? "view"
    : (isSharedView && !permissionConfirmed) ? "view"
    : "edit"
  const isEditable = sharedPermission === "edit"

  // Stable reference: a fresh closure here would flow into `extensions`'
  // deps via `ensureImageAssetNode` below and recreate the editor every render.
  const getNotebookId = React.useCallback(() => notebookId, [notebookId])

  const getNotebookLinkAccess = React.useCallback(() => fs.linkAccess ?? "restricted", [fs.linkAccess])

  const { createNote, createFolder, deleteNode, duplicateNote, ensureImageAssetNode } = useFileCommands(fs, {
    fallbackParentId: rootId,
    getNotebookId,
    getOrCreateYDoc,
    seedNote: "",
    getNotebookLinkAccess,
  })

  // Whenever the notebook's own link access changes (including on first
  // mount, to catch up notes that predate this notebook ever being shared),
  // sync every note that's still tracking it ("inherited") to match — new
  // notes are seeded this way too (see useFileCommands), but existing notes
  // need this to pick up later changes, and to actually stop being reachable
  // through their own /note/:notebookId/:noteId link once the notebook goes
  // restricted again. Notes someone explicitly (re)shared on their own via
  // the per-note Share menu are marked non-inherited and left alone.
  React.useEffect(() => {
    if (!hasNotebookContext) return
    const notebookAccess = fs.linkAccess ?? "restricted"
    const { noteIds } = collectLeaves(fs.tree)
    for (const id of noteIds) {
      const { doc } = getOrCreateYDoc(notebookId, id)
      const meta = doc.getMap<any>("meta")
      if (isNoteLinkAccessInherited(meta) && getNoteLinkAccess(meta) !== notebookAccess) {
        setNoteLinkAccess(meta, notebookAccess)
      }
    }
    // Deliberately not depending on fs.tree: this should re-sweep when the
    // notebook's own access level changes (or on mount), not on every
    // routine tree edit — new notes are handled at creation time instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fs.linkAccess, hasNotebookContext, notebookId])

  const resolveImageAsset = React.useCallback(async (assetId: string, name?: string | null) => {
    const assetName = name || assetId.slice(7, 15)
    const localAsset = await getImageAsset(assetId)
    if (localAsset) {
      ensureImageAssetNode(assetId, assetName)
      return localAsset.blob
    }

    const transferredAsset = await imageTransferRef.current?.requestAsset(assetId)
    if (transferredAsset) {
      ensureImageAssetNode(transferredAsset.id, assetName)
    }
    return transferredAsset?.blob ?? null
  }, [ensureImageAssetNode])

  // Create the Y-WebRTC provider AFTER mount (StrictMode safe)
  React.useEffect(() => {
    if (!collaborationActive) {
      imageTransferRef.current?.destroy()
      imageTransferRef.current = null
      imageRefIndexRef.current?.destroy()
      imageRefIndexRef.current = null
      // destroy() alone leaves the signaling websocket connected (it never
      // calls disconnect() internally), so the browser keeps hitting the
      // signaling server forever even after the note goes private.
      providerRef.current?.disconnect()
      providerRef.current?.destroy()
      providerRef.current = null
      setProviderReady(false)
      setSyncStatus("offline")
      return
    }



    const doc = note?.doc
    if (!doc) return

    let unsubscribeSyncStatus: (() => void) | undefined

    // provider is tied to this note's Y.Doc
    if (!providerRef.current) {
      const room = `nb:${notebookId}:n:${noteId}`
      const provider = new WebrtcProvider(room, doc, {
        signaling: SIGNALING_SERVERS,
        password: room
      })
      providerRef.current = provider
      setProviderGeneration((g) => g + 1)
      const imageRefIndex = new NoteImageRefIndex(doc)
      imageRefIndexRef.current = imageRefIndex
      imageTransferRef.current = new P2PImageAssetTransfer(
        provider.awareness,
        (assetId) => imageRefIndex.has(assetId)
      )
      setProviderReady(true)

      let connected = provider.connected
      let synced = provider.room?.synced ?? true
      // In shared view, "live" requires at least one other peer in awareness —
      // room.synced stays true after peers disconnect so we can't rely on it alone.
      let hasPeers = provider.awareness.getStates().size > 1
      const stampSyncedAt = (date: Date) => {
        setLastSyncedAt(date)
        if (noteId) localStorage.setItem(`lastSyncedAt:${noteId}`, String(date.getTime()))
      }
      const updateSyncStatus = () => {
        const isLive = connected && synced && (!isSharedView || hasPeers)
        if (isLive) {
          setSyncStatus("live")
          stampSyncedAt(new Date())
        } else if (isSharedView && !hasPeers) {
          setSyncStatus("offline")
          setLastSyncedAt(prev => {
            if (prev) return prev
            const now = new Date()
            if (noteId) localStorage.setItem(`lastSyncedAt:${noteId}`, String(now.getTime()))
            return now
          })
        } else {
          setSyncStatus("connecting")
        }
      }
      const handleStatus = (e: { connected: boolean }) => { connected = e.connected; updateSyncStatus() }
      const handleSynced = (e: { synced: boolean }) => { synced = e.synced; updateSyncStatus() }
      const handleAwareness = () => { hasPeers = provider.awareness.getStates().size > 1; updateSyncStatus() }
      // y-webrtc applies updates it receives from peers with the Room instance
      // as the transaction origin, so this only fires for content that actually
      // came in over the wire — local edits keep their own (different) origin.
      const handleDocUpdate = (_update: Uint8Array, origin: unknown) => {
        if (origin === provider.room) stampSyncedAt(new Date())
      }
      provider.on("status", handleStatus)
      provider.on("synced", handleSynced)
      provider.awareness.on("change", handleAwareness)
      doc.on("update", handleDocUpdate)
      setSyncStatus("connecting")
      unsubscribeSyncStatus = () => {
        provider.off("status", handleStatus)
        provider.off("synced", handleSynced)
        provider.awareness.off("change", handleAwareness)
        doc.off("update", handleDocUpdate)
      }
    }
    return () => {
      unsubscribeSyncStatus?.()
      imageTransferRef.current?.destroy()
      imageTransferRef.current = null
      imageRefIndexRef.current?.destroy()
      imageRefIndexRef.current = null
      // Only close the signaling socket if collaboration is actually turning
      // off for the next render, or a stalled connection forced a reconnect
      // (in which case the warm socket is presumably the stuck one). Plain
      // note-to-note switches skip disconnect() so the warm signaling socket
      // gets reused instead of re-handshaking with every signaling server.
      if (!collaborationActiveRef.current || forceReconnectRef.current) {
        forceReconnectRef.current = false
        providerRef.current?.disconnect()
      }
      providerRef.current?.destroy()
      providerRef.current = null
      setProviderReady(false)
      setSyncStatus("offline")
    }
    // only when the doc/ids truly change
  }, [note?.doc, notebookId, noteId, collaborationActive, reconnectNonce])

  // The public signaling servers (and the WebRTC handshake itself) are flaky
  // enough that the initial connection sometimes never completes — it sits
  // in "connecting" forever instead of erroring, so there's nothing to catch
  // and retry. Previously the only fix was manually reloading the tab, which
  // just re-runs this same provider setup from a clean slate. Do that
  // automatically instead: if we're still not live after a while, tear down
  // and recreate the provider to give the handshake a fresh attempt.
  React.useEffect(() => {
    if (!collaborationActive || syncStatus !== "connecting") return

    const timeout = setTimeout(() => {
      forceReconnectRef.current = true
      setReconnectNonce((n) => n + 1)
    }, 8000)

    return () => clearTimeout(timeout)
    // reconnectNonce is included so each retry re-arms its own watchdog —
    // syncStatus alone can flip offline->connecting within the same batched
    // commit as a reconnect, landing back on "connecting" without this effect
    // ever seeing it change.
  }, [collaborationActive, syncStatus, noteId, reconnectNonce])

  const collaborationScopeKey = collaborationActive && noteId
    ? `${notebookId}:${noteId}`
    : null
  const users = useAwarenessUsers(providerRef, providerReady, providerGeneration, collaborationScopeKey)

  // Stores the blob (handleImageUpload) and also files it into this notebook's
  // Assets folder, so the upload is visible/manageable from the file explorer.
  const uploadAndRegisterImage = React.useCallback(
    async (file: File, onProgress?: (event: { progress: number }) => void, abortSignal?: AbortSignal) => {
      const asset = await handleImageUpload(file, onProgress, abortSignal)
      ensureImageAssetNode(asset.assetId, file.name.replace(/\.[^/.]+$/, "") || "image")
      return asset
    },
    [ensureImageAssetNode],
  )

  const canCreateNodes = allowFileCreation && Boolean(rootId)

  const handleTreeCreate = React.useCallback((parentId: NodeId, isFolder: boolean) => {
    if (!canCreateNodes) return null
    if (isFolder) {
      return createFolder("New folder", parentId)
    }
    return createNote("Untitled", parentId)
  }, [canCreateNodes, createFolder, createNote])

  const handleToolbarCreateFolder = React.useCallback(() => {
    if (!canCreateNodes || !rootId) return
    void createFolder("New folder", rootId).then((createdId) => {
      fileTreeRef.current?.requestRename(createdId)
    })
  }, [canCreateNodes, createFolder, rootId])

  const extensions = React.useMemo(() => {
    // Collaboration extension brings its own undo/redo (Y.UndoManager), which
    // conflicts with StarterKit's built-in UndoRedo extension.
    const doc = note?.doc
    const base = [
      StarterKit.configure({
        horizontalRule: false,
        link: { openOnClick: false, enableClickSelection: true },
        undoRedo: doc ? false : undefined,
      }),
      HorizontalRule,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Highlight.configure({ multicolor: true }),
      AssetImage.configure({
        resolveAsset: resolveImageAsset,
        upload: uploadAndRegisterImage,
        awareness: collaborationActive && providerReady ? providerRef.current?.awareness : null,
      }),
      NoteLink.configure({ api: getNoteLinkApi }),
      Table,
      Typography,
      Superscript,
      Subscript,
      Selection,
      MarkdownConversion,
      LinkClick,
      TableOfContents.configure({
        getIndex: getHierarchicalIndexes,
        onUpdate(content) {
          setItems(content)
        },
      })
    ];

    // Collaboration extension is needed even if disabled, to enable use of Y.Doc
    if (doc) {
      // Cast the doc to any to avoid cross-package yjs type incompatibilities in TS.
      base.push(
        Collaboration.configure({
          document: doc as unknown as any
        })
      );

      // The CollaborationCaret extension need to wait for provider.awareness to be ready
      if (collaborationActive && providerReady){
        base.push(
          CollaborationCaret.configure({
            provider: providerRef.current,
            user: currentUser,
            // A collaborator selecting an image already gets a labeled
            // outline on the image itself (see AssetImage) — skip the
            // floating text-cursor caret for them so it doesn't show up
            // disconnected from the image right after it.
            render: (user: Record<string, any>, clientId?: number) => {
              const hasImageSelected =
                clientId != null &&
                Boolean(
                  providerRef.current?.awareness.getStates().get(clientId)?.[
                    SELECTION_AWARENESS_FIELD
                  ]
                )
              if (hasImageSelected) return document.createElement("span")

              const cursor = document.createElement("span")
              cursor.classList.add("collaboration-carets__caret")
              cursor.setAttribute("style", `border-color: ${user.color}`)

              const label = document.createElement("div")
              label.classList.add("collaboration-carets__label")
              label.setAttribute("style", `background-color: ${user.color}`)
              label.append(document.createTextNode(user.name))
              cursor.append(label)

              return cursor
            },
          }),
        );
      }
    }

    return base;
  }, [note?.doc, providerReady, providerGeneration, currentUser, collaborationActive, resolveImageAsset, uploadAndRegisterImage, getNoteLinkApi]);

  
  const editor = useEditor({
    // Creating the editor immediately during render fires extension callbacks
    // (e.g. TableOfContents' onUpdate) before this component has mounted,
    // which triggers "update on unmounted component" warnings. `editorReady`
    // already gates the UI that depends on the editor, so deferring creation
    // to mount is safe.
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editorProps: { attributes: { autocomplete: "off", autocorrect: "off", autocapitalize: "off", spellcheck: "false", "aria-label": "Main content area, start typing to enter text.", class: "simple-editor" } },
    extensions,
    onCreate: () => setEditorReady(true),
    onUpdate: touchActiveNoteModifiedAt,
    onDestroy: () => setEditorReady(false),
  }, [extensions, touchActiveNoteModifiedAt]);

  React.useEffect(() => {
    editor?.setEditable(isEditable)
  }, [editor, isEditable])

  React.useEffect(() => {
    setSelectedNoteId(noteId)
  }, [noteId])

  React.useEffect(() => {
    setTitleDraft(activeTitle)
  }, [activeTitle])

  const navigateToNote = React.useCallback(
    (id: NodeId) => {
      if (!id || typeof id !== "string") return

      setActiveNewTabId(null)
      setPreviewNodeId(null)
      setSelectedNoteId(id)

      if (id !== noteId) {
        onNavigateNote(id)
      }
    },
    [noteId, onNavigateNote],
  )

  const selectTitleWhenReady = React.useCallback((id: NodeId) => {
    pendingTitleSelectionNoteIdRef.current = id

    window.requestAnimationFrame(() => {
      if (pendingTitleSelectionNoteIdRef.current !== id) return
      if (activeTitleNoteIdRef.current !== id) return

      if (!inlineTitleVisible) {
        pendingTitleSelectionNoteIdRef.current = null
        editor?.commands.focus("start")
        return
      }

      const input = titleInputRef.current
      if (!input) return

      input.focus()
      input.select()
      pendingTitleSelectionNoteIdRef.current = null
    })
  }, [editor, inlineTitleVisible])

  React.useEffect(() => {
    if (!activeTitleNoteId) return
    if (pendingTitleSelectionNoteIdRef.current !== activeTitleNoteId) return

    selectTitleWhenReady(activeTitleNoteId)
  }, [activeTitleNoteId, titleDraft, selectTitleWhenReady])

  // Removes one "New tab" pill, deactivating it first if it was the active one.
  const closeNewTab = React.useCallback((id: string) => {
    setNewTabIds((ids) => ids.filter((x) => x !== id))
    setActiveNewTabId((current) => (current === id ? null : current))
  }, [])

  const handleOpenNewTab = React.useCallback(() => {
    const id = `new-tab-${Date.now()}-${Math.random().toString(36).slice(2)}`
    setPreviewNodeId(null)
    setNewTabIds((ids) => [...ids, id])
    setActiveNewTabId(id)
  }, [])

  const handleSelectNewTab = React.useCallback((id: string) => {
    setPreviewNodeId(null)
    setActiveNewTabId(id)
  }, [])

  const handleCloseActiveNewTab = React.useCallback(() => {
    if (activeNewTabId) closeNewTab(activeNewTabId)
  }, [activeNewTabId, closeNewTab])

  const createNoteAndSelectTitle = React.useCallback((mode: "replace" | "append" = "replace") => {
    if (!canCreateNodes || !rootId) return

    // If this note is being created from inside an active "New tab"
    // placeholder, that placeholder is being replaced by the real note.
    const newTabIdToConsume = activeNewTabId

    void createNote("Untitled", rootId).then((createdId) => {
      if (newTabIdToConsume) closeNewTab(newTabIdToConsume)
      noteTabBarRef.current?.openNote(createdId as string, mode)
      navigateToNote(createdId)
      selectTitleWhenReady(createdId)
    })
  }, [activeNewTabId, canCreateNodes, closeNewTab, createNote, navigateToNote, rootId, selectTitleWhenReady])

  const handleToolbarCreateNote = React.useCallback(() => {
    createNoteAndSelectTitle()
  }, [createNoteAndSelectTitle])

  const handleFindNote = React.useCallback(() => {
    setIsQuickSwitcherOpen(true)
  }, [])

  React.useEffect(() => {
    const handleNewNoteShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (event.key.toLowerCase() !== "n") return
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return

      event.preventDefault()
      event.stopPropagation()
      createNoteAndSelectTitle()
    }

    window.addEventListener("keydown", handleNewNoteShortcut, true)
    return () => window.removeEventListener("keydown", handleNewNoteShortcut, true)
  }, [createNoteAndSelectTitle])

  React.useEffect(() => {
    const handleFindNoteShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (event.key.toLowerCase() !== "p") return
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return

      event.preventDefault()
      event.stopPropagation()
      setIsQuickSwitcherOpen(true)
    }

    window.addEventListener("keydown", handleFindNoteShortcut, true)
    return () => window.removeEventListener("keydown", handleFindNoteShortcut, true)
  }, [])

  const handleSelectNote = React.useCallback(
    (id: NodeId) => {
      if (!id || typeof id !== "string") return
      // Assets-folder entries aren't notes; preview them in place of the
      // editor instead of opening a tab.
      if (findNode(fs.tree, id).node?.assetId) {
        setActiveNewTabId(null)
        setPreviewNodeId(id)
        return
      }
      noteTabBarRef.current?.openNote(id, "replace")
      navigateToNote(id)
    },
    [navigateToNote, fs.tree],
  )

  noteLinkApiRef.current = { tree: fs.tree, onNavigate: handleSelectNote }

  const handleOpenNoteInNewTab = React.useCallback(
    (id: NodeId) => {
      if (!id || typeof id !== "string") return
      if (findNode(fs.tree, id).node?.assetId) {
        noteTabBarRef.current?.openNote(id, "append")
        setActiveNewTabId(null)
        setPreviewNodeId(id)
        return
      }
      noteTabBarRef.current?.openNote(id, "append")
      navigateToNote(id)
    },
    [navigateToNote, fs.tree],
  )

  const handleOpenImageAssetInTab = React.useCallback(
    (assetId: string) => {
      const found = findAssetNode(fs.tree, assetId)
      if (found) handleOpenNoteInNewTab(found.node.id)
    },
    [fs.tree, handleOpenNoteInNewTab],
  )

  const handleDownloadNotes = React.useCallback(
    async (ids: NodeId[], format: NoteExportFormat) => {
      const ext = fileExtensionForFormat(format)
      const mimeType = mimeTypeForFormat(format)

      for (const id of ids) {
        const { node } = findNode(fs.tree, id)
        if (!node || node.isFolder) continue

        try {
          const content = await exportNoteContent(notebookId, id as string, format)
          downloadFile(`${node.name || "Untitled"}.${ext}`, content, mimeType)
        } catch (e) {
          console.error(`Failed to download note ${id}:`, e)
        }

        if (ids.length > 1) {
          await new Promise((resolve) => setTimeout(resolve, 150))
        }
      }
    },
    [fs.tree, notebookId],
  )

  const handleImportNotes = React.useCallback(
    async (items: NoteImportItem[], parentId?: NodeId) => {
      if (!canCreateNodes) return
      const importRootId = parentId ?? rootId
      if (!importRootId) return

      const folderCache = new Map<string, NodeId>()

      const findExistingFolder = (folderParentId: NodeId, name: string): NodeId | null => {
        const { node } = findNode(fs.tree, folderParentId)
        const existing = node?.children?.find((child) => child.isFolder && child.name === name)
        return existing?.id ?? null
      }

      const ensureImportFolder = async (folderParentId: NodeId, name: string, cacheKey: string) => {
        const cachedId = folderCache.get(cacheKey)
        if (cachedId) return cachedId

        const existingId = findExistingFolder(folderParentId, name)
        if (existingId) {
          folderCache.set(cacheKey, existingId)
          return existingId
        }

        const createdId = await createFolder(name, folderParentId)
        folderCache.set(cacheKey, createdId)
        return createdId
      }

      for (const item of items) {
        const { file } = item
        try {
          const segments = pathSegments(item.path, file.name)
          const folderSegments = segments.slice(0, -1)
          let targetParentId: NodeId = importRootId
          let cachePath = String(importRootId)

          for (const segment of folderSegments) {
            cachePath = `${cachePath}/${segment}`
            targetParentId = await ensureImportFolder(targetParentId, segment, cachePath)
          }

          const raw = await file.text()
          const title = file.name.replace(/\.[^./\\]+$/, "") || "Untitled"
          const newNoteId = await createNote(title, targetParentId)
          await importNoteContent(notebookId, newNoteId as string, file.name, raw, {
            title,
            createdAt: Date.now(),
          })
        } catch (e) {
          console.error(`Failed to import note from ${file.name}:`, e)
        }

        // Spaced across ticks for the same reason bulk delete/move are: see
        // handleMoveToFolder below.
        if (items.length > 1) {
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
      }
    },
    [canCreateNodes, createFolder, createNote, fs.tree, notebookId, rootId],
  )

  const handleOpenMoveTo = React.useCallback((ids: NodeId[]) => {
    setMoveToNoteIds(ids)
  }, [])

  const handleMoveToFolder = React.useCallback(
    async (folderId: string) => {
      const ids = moveToNoteIds ?? []
      // Spaced across ticks for the same reason bulk delete/drag-move are:
      // the tree/notebook persistence state round-trips through context on
      // each move, and batching the mutations synchronously crashes React.
      for (const id of ids) {
        fs.move(id, folderId)
        if (ids.length > 1) {
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
      }
      setMoveToNoteIds(null)
    },
    [moveToNoteIds, fs.move],
  )

  const handleSelectTab = React.useCallback(
    (id: string) => {
      if (findNode(fs.tree, id).node?.assetId) {
        setActiveNewTabId(null)
        setPreviewNodeId(id)
        return
      }
      navigateToNote(id)
    },
    [navigateToNote, fs.tree],
  )

  const handleCloseLastTab = React.useCallback(() => {
    setPreviewNodeId(null)
    onCloseLastNote?.()
  }, [onCloseLastNote])

  const handleNotebookCreated = React.useCallback(
    (createdNotebookId: string, welcomeNoteId: string) => {
      setSelectedNoteId(welcomeNoteId as NodeId)
      onNotebookCreated?.(createdNotebookId, welcomeNoteId)
    },
    [onNotebookCreated]
  )

  React.useEffect(() => {
    if (!onTitleChange) return
    if (!note?.doc) return

    let disposed = false
    const meta = note.doc.getMap<any>("meta")

    // Retrieve title from Y.Map and notify callback
    const emitTitle = () => {
      if (disposed) return
      if (!meta.has("title")) return

      const title = meta.get("title")
      onTitleChange(title)
    }

    const observer = (event: any, _transaction: any) => {
      if (!event.keysChanged.has("title")) return
      emitTitle()
    }

    meta.observe(observer)

    ;(async () => {
      try {
        await note.idb?.whenSynced
      } catch {}
      if (!disposed) emitTitle()
    })()

    return () => {
      disposed = true
      meta.unobserve(observer)
    }
  }, [note?.doc, note?.idb, onTitleChange])

  const handleRename = React.useCallback(
    (id: NodeId, newName: string) => {
      if (!id || !notebookId) return

      fs.rename(id, newName)
      // We just made this edit ourselves, so it's already "read" — otherwise
      // renaming a note and navigating away immediately flags it unread for
      // the very person who renamed it.
      markNoteViewed(id)

      const { node } = findNode(fs.tree, id)
      if (!node || node.isFolder || node.assetId) return

      const { doc } = id === noteId && note?.doc ? { doc: note.doc } : getOrCreateYDoc(notebookId, id)
      setNoteTitle(doc.getMap("meta"), newName)
    },
    [fs, fs.tree, notebookId, noteId, note?.doc]
  )

  const commitTitle = React.useCallback(() => {
    if (!activeTitleNoteId) return

    const nextTitle = titleDraft.trim() || "Untitled"
    setTitleDraft(nextTitle)

    if (nextTitle !== activeTitle) {
      handleRename(activeTitleNoteId, nextTitle)
    }
  }, [activeTitle, activeTitleNoteId, handleRename, titleDraft])

  React.useEffect(() => {
    return () => {
      imageTransferRef.current?.destroy()
      imageTransferRef.current = null
      imageRefIndexRef.current?.destroy()
      imageRefIndexRef.current = null
      providerRef.current?.disconnect()
      providerRef.current?.destroy()
      providerRef.current = null
      editor?.destroy()

      if (note?.doc) {
        note.doc.destroy()
      }
    }
  }, [note?.doc, note?.idb])

  const handleLinkAccessChange = React.useCallback((access: LinkAccess) => {
    setLinkAccess(access)
    syncNoteLinkAccessToTree(selectedNoteId, access)
    const meta = note?.doc?.getMap<any>("meta")
    if (meta) {
      setNoteLinkAccess(meta, access)
      // A deliberate per-note choice from this menu — stop tracking the
      // notebook's own access level for this note from now on.
      setNoteLinkAccessInherited(meta, false)
      // First person to actually share the note (flip it off "restricted")
      // is recorded as the owner for shared-view provenance.
      if (access !== "restricted" && !getNoteOwnerName(meta)) {
        setNoteOwnerName(meta, currentUser.name)
      }
    }
    // A deliberate sharing change is real activity on the note — unlike the
    // passive linkAccess reconciliation that runs on every open (see
    // setNodeLinkAccess), this one should count toward modifiedAt. We made
    // this change ourselves, so mark it viewed too, or navigating away right
    // after would immediately flag it unread for us.
    if (typeof selectedNoteId === "string") {
      setFileTree((tree) => touchNodeModifiedAt(tree, selectedNoteId))
      markNoteViewed(selectedNoteId)
    }
  }, [currentUser.name, note?.doc, selectedNoteId, setFileTree, syncNoteLinkAccessToTree])

  const handleGuestNameChange = React.useCallback((name: string) => {
    setGuestName(name)
    setCurrentUser((prev) => ({ ...prev, name }))
  }, [])


  const routes: MenuRoute[] = [
    { id: "tabbar", when: whenTabbar, spec: tabbarSpec, priority: 9_900 },
    { id: "toolbar", when: whenToolbar, spec: toolbarSpec, priority: 100 },
    // No text-selection requirement: right-clicking anywhere inside the
    // editor body (not just over a selection) should still offer Cut/Copy/Paste.
    { id: "text", when: whenEditor, spec: textSpec, priority: 10 },
    { id: "heading", when: whenAnyPathIncludes("heading"), spec: headingSpec, priority: 80 },
    // DOM-based (not posAtCoords-based) so it can't drift to a neighboring
    // image when the click lands on a resize handle near the node's edge.
    { id: "image", when: whenDomMatches(".asset-image-node"), spec: imageSpec, priority: 90 },
    { id: "note-link", when: whenDomMatches(".note-link-wrapper"), spec: noteLinkSpec, priority: 95 },
    { id: "table", when: whenAnyPathIncludes("table"), spec: tableSpec, priority: 70 },
    { id: "editor-panel", when: whenEditorPanel, spec: editorSpec, priority: 1 },
  ];

  const spec = React.useCallback((ctx: any) => {
    return resolveSpec(routes, defaultSpec, ctx)
  }, [routes, defaultSpec])

  // Save current user to localStorage and emit to editor
  React.useEffect(() => {
    if (!editor || !editorReady) return
    if (!providerRef.current?.awareness) return

    // no .focus() here
    if (typeof editor.commands.updateUser === "function") {
      editor.commands.updateUser(currentUser)
    }
    else {
      providerRef.current.awareness.setLocalStateField("user", currentUser)
    }
  }, [editor, editorReady, providerReady, currentUser])

  // Broadcast the currently viewed note to the notebook-level index room so
  // peers can open a background WebRTC provider for it and sync its content
  // into their IndexedDB even without navigating to it themselves.
  React.useEffect(() => {
    const indexProvider = fileSystem.indexProvider
    if (!collaborationActive || !noteId || !indexProvider) return
    indexProvider.awareness.setLocalStateField("editingNoteId", noteId)
    return () => {
      indexProvider.awareness.setLocalStateField("editingNoteId", null)
    }
  }, [fileSystem.indexProvider, collaborationActive, noteId])

  // Also broadcast user identity on the index awareness so peers can show
  // a named avatar next to whichever note this user is currently viewing.
  React.useEffect(() => {
    const indexProvider = fileSystem.indexProvider
    if (!collaborationActive || !indexProvider) return
    indexProvider.awareness.setLocalStateField("user", currentUser)
  }, [fileSystem.indexProvider, collaborationActive, currentUser])

  React.useEffect(() => {
    if (!editor || editor.isDestroyed) return
    editor.setOptions({ editorProps: { attributes: {
      autocomplete: "off", autocorrect: "off", autocapitalize: "off",
      spellcheck: String(editorSettings.spellcheck),
      "aria-label": "Main content area, start typing to enter text.",
      class: "simple-editor",
      style: `--editor-font-size: ${editorSettings.fontSize}px`,
    } } })
  }, [editor, editorSettings])

  const rect = useCursorVisibility({
    editor,
    ready: editorReady,
    overlayHeight: toolbarRef.current?.getBoundingClientRect().height ?? 0,
  })

  React.useEffect(() => {
    if (!isMobile && mobileView !== "main") {
      setMobileView("main")
    }
  }, [isMobile, mobileView])

  // On desktop the toolbar's LinkPopover handles this request itself; on
  // mobile the link editor is a toolbar view instead of a popover.
  React.useEffect(() => {
    if (!isMobile) return
    return onLinkPopoverOpenRequest(() => setMobileView("link"))
  }, [isMobile])

  const handleRetargetNoteLink = React.useCallback(
    (noteId: string) => {
      const pos = editingNoteLinkPos
      setEditingNoteLinkPos(null)
      if (!editor || pos == null) return
      const node = editor.state.doc.nodeAt(pos)
      if (node?.type.name !== "noteLink") return
      editor
        .chain()
        .focus()
        .command(({ tr }) => {
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, noteId, label: noteTitleFor(fs.tree, noteId) })
          return true
        })
        .run()
    },
    [editor, editingNoteLinkPos, fs.tree],
  )

  return (
    <div ref={wrapperRef} className="workspace">
      {isSharedView && (
        <>
          <div className="workspace-ribbon">
            {showFileBrowser ? (
              <div className="ribbon-top">
                <div className="side-panel-button">
                  <SidePanelButton
                    isOpen={isLeftSidePanelOpen}
                    onToggle={() => setIsLeftSidePanelOpen(v => !v)}
                    isFlipped={true}
                  />
                </div>
              </div>
            ) : (
              // No sidebar on a single-note share, so this is the only way home.
              <div className="ribbon-top">
                <Button
                  type="button"
                  data-style="ghost"
                  aria-label="Back to home"
                  tooltip="Back to home"
                  onClick={() => navigate("/")}
                >
                  <RiHome4Line className="tiptap-button-icon" />
                </Button>
              </div>
            )}
            <SettingsMenu name={currentUser.name} onNameChange={handleGuestNameChange} />
          </div>

          {!showFileBrowser && (
            <EditingIdentityBubble
              name={currentUser.name}
              color={currentUser.color}
              verb={sharedPermission === "edit" ? "Editing" : "Viewing"}
              onNameChange={handleGuestNameChange}
            />
          )}
        </>
      )}
      {!isSharedView && (
        <div className="workspace-ribbon">
          <div className="ribbon-top">
            <div className="side-panel-button">
              <SidePanelButton
                isOpen={isLeftSidePanelOpen}
                onToggle={() => setIsLeftSidePanelOpen(v => !v)}
                isFlipped={true}
              />
            </div>
          </div>
          <SettingsMenu name={currentUser.name} onNameChange={handleGuestNameChange} />
        </div>
      )}
      <div className="editor-wrapper">
        <div className="horizontal-main-container">
          {/* <div className={`side-panel-row ${isSidePanelOpen ? "is-open" : ""}`}>
          </div> */}
          {(!isSharedView || showFileBrowser) && (
            <SidePanel
              data-tt-role="sidepanel"
              isOpen={isLeftSidePanelOpen}
              onClose={() => setIsLeftSidePanelOpen(false)}
              width={288}
              side="left"
            >
              <div className="side-panel-header">
                <FileExplorerDropdownMenu
                  onNotebookCreated={handleNotebookCreated}
                  showNotebookLockIndicator={!showNotebookLockIndicator}
                  isShared={!isSharedView && fileSystem.linkAccess !== "restricted"}
                />
                <Button
                  type="button"
                  data-style="ghost"
                  tooltip="Find note"
                  onClick={handleFindNote}
                  aria-label="Find a note"
                >
                  <RiSearchLine className="tiptap-button-icon" />
                </Button>
              </div>
              <div className="side-panel-toolbar">
                <FileExplorerToolbar
                  onCreateNote={handleToolbarCreateNote}
                  onCreateFolder={handleToolbarCreateFolder}
                  onImportFiles={handleImportNotes}
                  onCollapseAll={fs.collapseAll}
                  sortOrder={fileTreeSortOrder}
                  onSortOrderChange={setFileTreeSortOrder}
                  disabled={!canCreateNodes}
                />
              </div>
              <div className="side-panel-container">
                <FileTreeHost
                  ref={fileTreeRef}
                  tree={fs.tree}
                  selectedId={previewNodeId ?? selectedNoteId}
                  onSelect={handleSelectNote}
                  onOpenInNewTab={handleOpenNoteInNewTab}
                  onToggle={fs.expandFolder}
                  onRename={canCreateNodes ? handleRename : undefined}
                  onDelete={canCreateNodes ? deleteNode : undefined}
                  onDuplicate={canCreateNodes ? duplicateNote : undefined}
                  onDownload={handleDownloadNotes}
                  onImportFiles={canCreateNodes ? handleImportNotes : undefined}
                  onMoveTo={canCreateNodes ? handleOpenMoveTo : undefined}
                  onCreate={handleTreeCreate}
                  onMove={canCreateNodes ? fs.move : undefined}
                  allowCreate={canCreateNodes}
                  allowMove={canCreateNodes}
                  sortOrder={fileTreeSortOrder}
                  notePresence={notePresence}
                  unreadNoteIds={unreadNoteIds}
                />
              </div>
              {isSharedView && (
                <div className="side-panel-identity-footer">
                  <EditingIdentityBubble
                    name={currentUser.name}
                    color={currentUser.color}
                    verb={sharedPermission === "edit" ? "Editing" : "Viewing"}
                    onNameChange={handleGuestNameChange}
                  />
                </div>
              )}
            </SidePanel>
          )}

          <div className="editor-column">
            <EditorContext.Provider value={{ editor }}>
              <div className="toolbar-stack">
                <div className="tab-bar" data-tt-role="tabbar">
                  <div className="tab-bar-main">
                    {isSharedView && !showFileBrowser ? (
                      <SharedNoteBar
                        ownerName={ownerName}
                        users={users}
                        syncStatus={syncStatus}
                        permission={sharedPermission}
                        lastSyncedAt={lastSyncedAt}
                      />
                    ) : (isSharedView || (showNoteTabs && !!onCloseLastNote)) ? (
                      <NoteTabBar
                        ref={noteTabBarRef}
                        key={notebookId}
                        notebookId={notebookId}
                        activeNoteId={activeTabId}
                        tree={fs.tree}
                        onSelectNote={handleSelectTab}
                        onCloseLastNote={handleCloseLastTab}
                        onNewTab={isSharedView ? undefined : handleOpenNewTab}
                        newTabIds={newTabIds}
                        activeNewTabId={activeNewTabId}
                        onSelectNewTab={handleSelectNewTab}
                        onCloseNewTab={closeNewTab}
                      />
                    ) : null}
                  </div>
                  <div className="tab-bar-right">
                    <ThemeToggle />
                    <SidePanelButton
                      isOpen={isRightSidePanelOpen}
                      onToggle={() => setIsRightSidePanelOpen(v => !v)}
                    />
                  </div>
                </div>

                {!previewNode && !activeNewTabId && (
                  isSharedView && (isViewOnly || isRevoked) ? (
                    <ViewOnlyBanner ownerName={ownerName} revoked={isRevoked} />
                  ) : (
                    // Stays mounted (just visually hidden) when toolbarVisible is false,
                    // since the format buttons inside also own the editor's keyboard
                    // shortcuts (e.g. mod+b) via useHotkeys - unmounting them would
                    // silently kill those shortcuts too.
                    <Toolbar
                      ref={toolbarRef}
                      data-tt-role="toolbar"
                      style={{
                        ...(isMobile
                          ? {
                            bottom: `calc(100% - ${height - rect.y}px)`,
                          }
                          : {}),
                        ...(toolbarVisible ? {} : { display: "none" }),
                      }}
                    >
                      {mobileView === "main" ? (
                        <MainToolbarContent
                          editor={editor}
                          onHighlighterClick={() => setMobileView("highlighter")}
                          onLinkClick={() => setMobileView("link")}
                          isMobile={isMobile}
                          uploadImage={uploadAndRegisterImage}
                          getActiveTitle={() => activeTitle}
                          rightSlot={isSharedView && showFileBrowser ? (
                            <SharedNoteBar
                              ownerName={ownerName}
                              users={users}
                              syncStatus={syncStatus}
                              permission={sharedPermission}
                              lastSyncedAt={lastSyncedAt}
                              embedded
                            />
                          ) : undefined}
                        />
                      ) : (
                        <MobileToolbarContent
                          type={mobileView === "highlighter" ? "highlighter" : "link"}
                          onBack={() => setMobileView("main")}
                        />
                      )}
                      {!isSharedView && (
                        <ToolbarGroup>
                          {collaborationActive && (
                            <SyncStatusIndicator syncStatus={syncStatus} lastSyncedAt={lastSyncedAt} />
                          )}
                          <CollaborationStatusMenu
                            users={users}
                            portal={isMobile}
                            notebookId={notebookId}
                            noteId={selectedNoteId}
                            onLinkAccessChange={handleLinkAccessChange}
                            linkAccess={linkAccess}
                          />
                        </ToolbarGroup>
                      )}
                    </Toolbar>
                  )
                )}
              </div>

              <div
                className={`simple-editor-main${previewNode || hasActiveNote || activeNewTabId ? "" : " simple-editor-main--empty"}`}
                ref={editorAreaRef}>
                {activeNewTabId ? (
                  <NewTabView
                    canCreateNote={canCreateNodes}
                    onCreateNote={createNoteAndSelectTitle}
                    onFindNote={handleFindNote}
                    onClose={handleCloseActiveNewTab}
                  />
                ) : previewNode && previewNode.assetId ? (
                  <AssetPreviewPane
                    assetId={previewNode.assetId}
                    name={previewNode.name}
                    resolveAsset={resolveImageAsset}
                    onClose={() => setPreviewNodeId(null)}
                  />
                ) : hasActiveNote ? (
                  <div className="simple-editor-content" style={{ "--editor-line-width": lineWidths.find(item => item.id === editorSettings.lineWidth)!.width, "--editor-font-family": editorFonts.find(item => item.id === editorSettings.font)!.family } as React.CSSProperties}>
                    {inlineTitleVisible && (
                      <input
                        ref={titleInputRef}
                        className="note-inline-title"
                        value={titleDraft}
                        placeholder="Untitled"
                        aria-label="Note title"
                        spellCheck={false}
                        readOnly={!isEditable}
                        onChange={(event) => setTitleDraft(event.target.value)}
                        onBlur={commitTitle}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter") return

                          event.preventDefault()
                          event.currentTarget.blur()
                          window.requestAnimationFrame(() => {
                            editor?.commands.focus("start")
                          })
                        }}
                      />
                    )}
                    <EditorContent
                      editor={editor}
                      role="presentation"
                      className="simple-editor-body"
                      data-tt-role="editor"
                    />
                  </div>
                ) : (
                  <div className="empty-content">
                    <p>Please select or create a note to start editing.</p>
                  </div>
                )}
                { editorReady && (
                  <ContextMenu
                    editor={editor}
                    container={wrapperRef.current}
                    spec={spec}
                    extraContext={{ openAssetInTab: handleOpenImageAssetInTab, getActiveTitle: () => activeTitle, editNoteLink: setEditingNoteLinkPos }}
                  />
                )}
              </div>
            </EditorContext.Provider>
          </div>

          <SidePanel
            data-tt-role="sidepanel"
            isOpen={isRightSidePanelOpen}
            onClose={() => setIsRightSidePanelOpen(false)}
            width={288}
            side="right"
          >
            <div className="side-panel-header toc-panel-header">
              <div className="note-panel-switch" role="group" aria-label="Right panel view">
                <button type="button" aria-pressed={rightPanelView === "outline"} onClick={() => setRightPanelView("outline")}>
                  <RiListUnordered /><span>Outline</span>
                </button>
                <button type="button" aria-pressed={rightPanelView === "graph"} onClick={() => setRightPanelView("graph")}>
                  <RiNodeTree /><span>Graph</span>
                </button>
              </div>
            </div>
            <div className={`toc-panel-body${rightPanelView === "graph" ? " toc-panel-body--graph" : ""}`}>
              {rightPanelView === "outline" ? <MemorizedToC editor={editor} items={items} /> : isRightSidePanelOpen && (
                <NoteGraph key={notebookId} notebookId={notebookId} tree={fs.tree} currentNoteId={activeTabId} onNavigate={handleSelectNote} />
              )}
            </div>
          </SidePanel>
        </div>
      </div>

      <NoteQuickSwitcher
        open={isQuickSwitcherOpen}
        tree={fs.tree}
        onSelect={(id) => {
          setIsQuickSwitcherOpen(false)
          if (activeNewTabId) closeNewTab(activeNewTabId)
          handleSelectNote(id)
        }}
        onClose={() => setIsQuickSwitcherOpen(false)}
      />

      <NoteQuickSwitcher
        open={editingNoteLinkPos !== null}
        tree={fs.tree}
        onSelect={handleRetargetNoteLink}
        onClose={() => setEditingNoteLinkPos(null)}
        placeholder="Link to note…"
      />

      <MoveToPicker
        open={moveToNoteIds !== null}
        tree={fs.tree}
        onSelect={handleMoveToFolder}
        onClose={() => setMoveToNoteIds(null)}
      />
    </div>
  )
}
