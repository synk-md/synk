import { useEffect, useRef, useState } from "react"

type EditableTextProps = {
  value: string
  onCommit: (next: string) => void
  className?: string
  maxLength?: number
  placeholder?: string
  /**
   * When provided, a new value triggers the input to enter editing mode.
   * Use a unique number (e.g. timestamp) so repeated requests are detected.
   */
  editRequest?: number
  /** Called after the current editing session ends, either by commit or cancel. */
  onEditEnd?: (committed: boolean) => void
  /** Whether this can receive keyboard focus via Tab. Default true. */
  tabbable?: boolean
}

export function EditableText({
  value,
  onCommit,
  className,
  maxLength = 80,
  placeholder,
  editRequest,
  onEditEnd,
  tabbable = true,
}: EditableTextProps) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)
  const lastEditRequestRef = useRef<number | null>(null)

  useEffect(() => setText(value), [value])
  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  useEffect(() => {
    if (typeof editRequest === "number" && editRequest !== lastEditRequestRef.current) {
      lastEditRequestRef.current = editRequest
      setText(value)
      setEditing(true)
      const frame = window.requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })

      return () => window.cancelAnimationFrame(frame)
    }
  }, [editRequest, value])

  useEffect(() => {
    if (!editing) return

    const id = window.requestAnimationFrame(() => {
      inputRef.current?.select()
    })

    return () => window.cancelAnimationFrame(id)
  }, [editing])

  const commit = () => {
    const v = text.trim()
    setEditing(false)
    const didCommit = !!(v && v !== value)
    if (didCommit) onCommit(v)
    onEditEnd?.(didCommit)
  }

  const cancel = () => {
    setEditing(false)
    setText(value)
    onEditEnd?.(false)
  }

  return (
    <span
      className={`editable_text ${className ?? ""}`}
      role="textbox"
      aria-label="Rename"
      tabIndex={tabbable ? 0 : undefined}
      onDoubleClick={() => { /* setEditing(true) */ }}
      onKeyDown={(e) => {
        if (e.key === "F2") {
          setEditing(true)
          e.preventDefault()
        }
      }}
    >
      {editing ? (
        <span className="editable_text__input">
          <input
            ref={inputRef}
            value={text}
            maxLength={maxLength}
            placeholder={placeholder}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit()
              else if (e.key === "Escape") cancel()
            }}
            type="text"
          />
        </span>
      ) : (
        <>{value || placeholder}</>
      )}
    </span>
  )
}
