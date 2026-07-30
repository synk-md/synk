import * as React from "react"

import "./editing-identity-bubble.scss"

export interface EditingIdentityBubbleProps {
  name: string
  color: string
  verb: "Editing" | "Viewing"
  onNameChange: (name: string) => void
}

const getInitials = (name: string) => {
  const parts = name.trim().split(/\s+/).slice(0, 2)
  return parts.map(p => p[0]?.toUpperCase() ?? "").join("")
}

export function EditingIdentityBubble({ name, color: _color, verb, onNameChange }: EditingIdentityBubbleProps) {
  const [isEditing, setIsEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(name)
  const inputRef = React.useRef<HTMLInputElement | null>(null)

  React.useEffect(() => {
    if (!isEditing) setDraft(name)
  }, [name, isEditing])

  const startEditing = () => {
    setDraft(name)
    setIsEditing(true)
    window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }

  const commit = () => {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== name) onNameChange(trimmed)
    setIsEditing(false)
  }

  return (
    <div className="editing-identity-bubble">
      <span className="avatar-bubble">
        {getInitials(name)}
      </span>

      {isEditing ? (
        <input
          ref={inputRef}
          className="editing-identity-bubble__input"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === "Enter") {
              e.preventDefault()
              commit()
            } else if (e.key === "Escape") {
              e.preventDefault()
              setIsEditing(false)
            }
          }}
          aria-label="Your display name"
        />
      ) : (
        <>
          <span className="editing-identity-bubble__text">
            {verb} as <strong>{name}</strong>
          </span>
          <span className="editing-identity-bubble__divider" />
          <button
            type="button"
            className="editing-identity-bubble__rename"
            onClick={startEditing}
            aria-label="Set your display name"
          >
            Rename
          </button>
        </>
      )}
    </div>
  )
}

export default EditingIdentityBubble
