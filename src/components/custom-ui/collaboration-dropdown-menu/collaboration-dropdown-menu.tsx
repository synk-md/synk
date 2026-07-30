import * as React from "react"
import type { LinkAccess } from "@/lib/note-meta"

// --- Icons ---
import { ChevronDownIcon } from "@/components/tiptap-icons/chevron-down-icon"
import {
  RiGroupLine,
  RiEdit2Line,
  RiGlobalLine,
  RiEyeLine,
  RiLock2Line,
  RiCloseLine,
} from "@remixicon/react"

// --- Tiptap UI ---
import { useCollaborationStatusMenu, type ActiveUser } from "@/components/custom-ui/collaboration-dropdown-menu"

// --- UI Primitives ---
import type { ButtonProps } from "@/components/tiptap-ui-primitive/button"
import { Button } from "@/components/tiptap-ui-primitive/button"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem
} from "@/components/tiptap-ui-primitive/dropdown-menu"

import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/tiptap-ui-primitive/tooltip"

import "./collaboration-dropdown-menu.scss"

export interface CollaborationStatusMenuProps
  extends Omit<ButtonProps, "type"> {
  users: ActiveUser[]
  /**
   * Hide the current user from the active list/avatars. Useful if your
   * presence provider returns "you" along with collaborators.
   */
  hideCurrentUser?: boolean
  /**
   * Optional: render dropdown in a portal (follows your other menus)
   */
  portal?: boolean
  /**
   * Called when the dropdown opens/closes
   */
  onOpenChange?: (isOpen: boolean) => void
  /**
   * Optional: click handler for an "Invite…" quick action (only shown if provided)
   */
  onInviteClick?: () => void
  /**
   * Optional custom label for the trigger button
   * @default "Collab"
   */
  label?: string

  /** Notebook id for sharing context */
  notebookId?: string

  /** Note id for sharing context */
  noteId?: string | null

  /** The current access mode for the note */
  linkAccess?: LinkAccess

  /** Callback when the access mode changes */
  onLinkAccessChange?: (access: LinkAccess) => void
}

const getInitials = (name: string) => {
  const parts = name.trim().split(/\s+/).slice(0, 2)
  return parts.map(p => p[0]?.toUpperCase() ?? "").join("")
}

export const PresenceDot: React.FC<{ active?: boolean; color?: string }> = ({
  active = true,
  color,
}) => {
  const className = `presence-dot ${active ? "presence-dot--active" : "presence-dot--inactive"
    }`

  // Allow custom color override (e.g. per user) while keeping layout in CSS
  const style = color ? { backgroundColor: color } : undefined

  return <span className={className} style={style} aria-hidden />
}

type OverflowBubbleProps = {
  count: number
} & React.ComponentProps<typeof Button>

const OverflowBubble: React.FC<OverflowBubbleProps> = ({
  count,
  style,
  ...props
}) => (
  <Button
    className="tiptap-button avatar-bubble overflow-bubble"
    type="button"
    role="button"
    {...props}
    style={style}
    aria-label={
      props["aria-label"] ?? `View all ${count} additional active users`
    }
  >
    <span>+{count}</span>
  </Button>
)

export const Avatar: React.FC<{ name: string; color?: string }> = ({
  name,
  // color,
}) => {
  const initials = getInitials(name)

  return (
    <Tooltip placement="bottom">
      <TooltipTrigger asChild>
        {/* use aria-label instead of aria-hidden so SRs get the name */}
        <span
          className="tiptap-button-text avatar-bubble avatar-bubble--avatar"
          aria-label={name}
        >
          {initials}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <span>{name}</span>
      </TooltipContent>
    </Tooltip>
  )
}

const sortAccessUsers = (a: ActiveUser, b: ActiveUser) => {
  const aActive = a.active !== false
  const bActive = b.active !== false

  if (aActive !== bActive) return aActive ? -1 : 1
  if ((a.isYou ? 1 : 0) !== (b.isYou ? 1 : 0)) return a.isYou ? -1 : 1

  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
}


/**
 * A button with a dropdown that lists active collaborators.
 * For now this is a read-only presence list. Wire it up to your
 * collab provider later by feeding the `users` prop.
 */
export const CollaborationStatusMenu = React.forwardRef<
  HTMLButtonElement,
  CollaborationStatusMenuProps
>(
  (
    {
      users,
      hideCurrentUser = true,
      portal = true,
      onOpenChange,
      onInviteClick,
      label = "Collaboration",
      notebookId,
      noteId,
      linkAccess: controlledLinkAccess,
      onLinkAccessChange,
      ...buttonProps
    },
    ref
  ) => {
    const [isOpen, setIsOpen] = React.useState(false)
    const [isShareOpen, setIsShareOpen] = React.useState(false)
    const [copied, setCopied] = React.useState(false)
    const [linkAccess, setLinkAccess] = React.useState<LinkAccess>(controlledLinkAccess ?? "edit")
    const [isAccessMenuOpen, setIsAccessMenuOpen] = React.useState(false)

    React.useEffect(() => {
      if (controlledLinkAccess) {
        setLinkAccess(controlledLinkAccess)
      }
    }, [controlledLinkAccess])

    const handleLinkAccessChange = (access: LinkAccess) => {
      setLinkAccess(access)
      onLinkAccessChange?.(access)
    }

    const isPublicLink = linkAccess === "view" || linkAccess === "edit"

    const resolvedShareUrl = React.useMemo(() => {
      const origin = window.location.origin
      return `${origin}/s/${notebookId}/${noteId}`
    }, [notebookId, noteId])

    const filteredUsers = React.useMemo(
      () => (hideCurrentUser ? users.filter(u => !u.isYou) : users),
      [hideCurrentUser, users]
    )

    const {
      users: sorted,
      ariaLabel,
      label: computedLabel,
    } = useCollaborationStatusMenu({
      users: filteredUsers,
      label,
      hideWhenEmpty: false,
    })

    // if (!isVisible) return null

    const handleOpenChange = (open: boolean) => {
      setIsOpen(open)
      onOpenChange?.(open)
    }

    const activeUsers = sorted.filter(u => u.active !== false)
    const visibleActiveUsers = activeUsers.slice(0, 2)
    const overflowCount = Math.max(
      0,
      activeUsers.length - visibleActiveUsers.length
    )

    const handleCopy = () => {
      if (navigator?.clipboard?.writeText) {
        navigator.clipboard.writeText(resolvedShareUrl).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }
    }

    const accessDescriptionMap: Record<typeof linkAccess, string> = {
      restricted: "Link sharing is off — only you can access this note.",
      view: "Anyone with the link can view this note.",
      edit: "Anyone with the link can view and edit this note.",
    }

    const accessOptions: {
      value: typeof linkAccess
      label: string
      description: string
      Icon: typeof RiLock2Line
    }[] = [
        {
          value: "restricted",
          label: "Restricted access",
          description: "Only you can access this note.",
          Icon: RiLock2Line,
        },
        {
          value: "view",
          label: "Anyone with the link can view",
          description: "People with the link can view the note.",
          Icon: RiEyeLine,
        },
        {
          value: "edit",
          label: "Anyone with the link can edit",
          description: "People with the link can edit the note.",
          Icon: RiEdit2Line,
        },
      ]


    const peopleWithAccess = React.useMemo(
      () => [...users].sort(sortAccessUsers),
      [users]
    )

    return (
      <DropdownMenu modal open={isOpen} onOpenChange={handleOpenChange}>
        <div className="collab-status-wrapper">
          <div className="collab-avatar-group" aria-label={ariaLabel}>
            {visibleActiveUsers.map(user => (
              <Avatar key={user.id} name={user.name} color={user.color} />
            ))}
            {overflowCount > 0 && (
              <DropdownMenuTrigger asChild>
                <OverflowBubble count={overflowCount} />
              </DropdownMenuTrigger>
            )}
          </div>

          {isPublicLink && (
            <Button
              type="button"
              role="button"
              data-style="ghost"
              aria-label={accessDescriptionMap[linkAccess]}
              tooltip={accessDescriptionMap[linkAccess]}
              onClick={() => setIsShareOpen(true)}
              {...buttonProps}
              ref={ref}
            >
              <RiGlobalLine className="tiptap-button-icon" style={{ color: "var(--tt-brand-color-300)" }} />
            </Button>
          )}

          <Button
            type="button"
            role="button"
            data-style="ghost"
            aria-label={computedLabel ?? "Share note"}
            tooltip={computedLabel ?? "Share note"}
            onClick={() => setIsShareOpen(true)}
            {...buttonProps}
            ref={ref}
          >
            <RiGroupLine className="tiptap-button-icon" />
            <span className="tiptap-button-text">Share</span>
          </Button>

          <DropdownMenuContent
            align="end"
            portal={portal}
            className="collab-dropdown-content"
          >
            {sorted.length === 0 ? (
              <div className="collab-empty">No active users</div>
            ) : (
              <div className="collab-user-list">
                {sorted.map(u => (
                  <div key={u.id} className="user-row">
                    <PresenceDot active={u.active !== false} color={u.color} />
                    <Avatar name={u.name} color={u.color} />
                    <div className="user-meta">
                      <span className="user-name">
                        {u.name}{" "}
                        {u.isYou ? <em className="user-you-tag">(you)</em> : null}
                      </span>
                      <span className="user-status">
                        {u.active === false ? "Inactive" : "Active now"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {onInviteClick && (
              <div className="invite-section">
                <Button type="button" data-style="ghost" onClick={onInviteClick}>
                  Invite…
                </Button>
              </div>
            )}
          </DropdownMenuContent>

          {isShareOpen && (
            <div
              className="share-modal-backdrop"
              onClick={() => setIsShareOpen(false)}
            >
              <div
                className="share-modal"
                onClick={e => e.stopPropagation()}
              >
                <div className="share-modal-header">
                  <div className="share-modal-heading">
                    <h3>Share note</h3>
                    <div className="share-modal-subtitle">{accessDescriptionMap[linkAccess]}</div>
                  </div>
                  <div className="share-modal-header-actions">
                    <Button
                      type="button"
                      data-style="ghost"
                      aria-label="Close"
                      tooltip="Close"
                      onClick={() => setIsShareOpen(false)}
                    >
                      <RiCloseLine className="tiptap-button-icon" />
                    </Button>
                  </div>
                </div>

                <div className="share-modal-body">
                  <div className="share-input-row">
                    <input
                      readOnly
                      value={resolvedShareUrl}
                      onFocus={e => e.currentTarget.select()}
                      data-muted={linkAccess === "restricted" || undefined}
                    />
                    <Button
                      type="button"
                      onClick={handleCopy}
                      aria-label={linkAccess === "restricted" ? "Link sharing is off" : "Copy"}
                      tooltip={linkAccess === "restricted" ? "Link sharing is off" : "Copy"}
                      disabled={linkAccess === "restricted"}
                    >
                      {copied ? "Copied!" : "Copy"}
                    </Button>
                  </div>

                  <div className="share-access-setting" aria-label="Link access">
                    <label htmlFor="link-access-select">Link access</label>
                    <DropdownMenu
                      open={isAccessMenuOpen}
                      onOpenChange={setIsAccessMenuOpen}
                    >
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          className="link-access-trigger"
                          aria-label="Select link access"
                        >
                          {React.createElement(
                            accessOptions.find(option => option.value === linkAccess)
                              ?.Icon ?? RiLock2Line,
                            { className: "tiptap-button-icon" }
                          )}
                          <span className="tiptap-button-text">
                            {accessOptions.find(option => option.value === linkAccess)
                              ?.label ?? "Select access"}
                          </span>
                          <ChevronDownIcon className="link-access-caret" />
                        </Button>
                      </DropdownMenuTrigger>

                      <DropdownMenuContent
                        className="collab-dropdown-content link-access-menu"
                        align="start"
                        portal={portal}
                      >
                        {accessOptions.map(({ value, label, description, Icon }) => (
                          <DropdownMenuItem
                            key={value}
                            className="link-access-item"
                            onSelect={() => handleLinkAccessChange(value)}
                          >
                            <Icon className="tiptap-button-icon" />
                            <div className="link-access-text">
                              <span className="link-access-label">{label}</span>
                              <span className="link-access-description">{description}</span>
                            </div>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  <div className="share-access-section" aria-label="Currently viewing">
                    <div className="share-section-header">
                      <span className="share-section-label">Currently viewing</span>
                      <span className="share-section-line" aria-hidden />
                      <span className="share-section-count">{peopleWithAccess.length}</span>
                    </div>

                    <div className="share-access-list">
                      {peopleWithAccess.map(user => (
                        <div className="share-access-row" key={user.id}>
                          <Avatar name={user.name} color={user.color} />
                          <div className="share-access-meta">
                            <span className="share-access-name">
                              {user.name} {user.isYou ? <em className="user-you-tag">(you)</em> : null}
                            </span>
                            <span className="share-access-permission">
                              {user.active === false ? "Inactive" : (user.isYou || linkAccess !== "view") ? "Can edit" : "View only"}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </DropdownMenu>
    )
  }
)

CollaborationStatusMenu.displayName = "CollaborationStatusMenu"

export default CollaborationStatusMenu
