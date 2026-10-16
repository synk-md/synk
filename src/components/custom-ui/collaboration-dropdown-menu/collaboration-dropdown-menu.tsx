import * as React from "react"
import type { LinkAccess } from "@/lib/note-meta"

// --- Icons ---
import { RiGroupLine, RiGlobalLine } from "@remixicon/react"

// --- Tiptap UI ---
import { useCollaborationStatusMenu, type ActiveUser } from "@/components/custom-ui/collaboration-dropdown-menu"

// --- UI Primitives ---
import type { ButtonProps } from "@/components/tiptap-ui-primitive/button"
import { Button } from "@/components/tiptap-ui-primitive/button"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
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

  /** The note's link setting, shown when a link is on. */
  linkAccess?: LinkAccess

  /** Opens the sharing dialog. */
  onShare?: () => void
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

const LINK_DESCRIPTION: Record<LinkAccess, string> = {
  restricted: "Link sharing is off",
  view: "Anyone with the link can read this note",
  edit: "Anyone with the link can edit this note",
}

/**
 * Who is here now, and the way into sharing. Sharing itself - people, the
 * link, who is looking - is one dialog, opened from here.
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
      linkAccess = "restricted",
      onShare,
      ...buttonProps
    },
    ref
  ) => {
    const [isOpen, setIsOpen] = React.useState(false)

    const filteredUsers = React.useMemo(
      () => (hideCurrentUser ? users.filter(u => !u.isYou) : users),
      [hideCurrentUser, users]
    )

    const { users: sorted, ariaLabel } = useCollaborationStatusMenu({
      users: filteredUsers,
      label,
      hideWhenEmpty: false,
    })

    const handleOpenChange = (open: boolean) => {
      setIsOpen(open)
      onOpenChange?.(open)
    }

    const activeUsers = sorted.filter(u => u.active !== false)
    const visibleActiveUsers = activeUsers.slice(0, 2)
    const overflowCount = Math.max(0, activeUsers.length - visibleActiveUsers.length)

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

          {linkAccess !== "restricted" && (
            <Button
              type="button"
              role="button"
              data-style="ghost"
              aria-label={LINK_DESCRIPTION[linkAccess]}
              tooltip={LINK_DESCRIPTION[linkAccess]}
              onClick={onShare}
              {...buttonProps}
            >
              <RiGlobalLine className="tiptap-button-icon" style={{ color: "var(--tt-brand-color-300)" }} />
            </Button>
          )}

          <Button
            type="button"
            role="button"
            data-style="ghost"
            aria-label="Share"
            tooltip="Who has access, and sharing"
            onClick={onShare}
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
        </div>
      </DropdownMenu>
    )
  }
)

CollaborationStatusMenu.displayName = "CollaborationStatusMenu"

export default CollaborationStatusMenu
