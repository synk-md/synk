import * as React from "react"

// --- Hooks ---
import { useTiptapEditor } from "@/hooks/use-tiptap-editor"

// --- Tiptap UI ---
import type { UseTableConfig } from "@/components/tiptap-ui/table-button"
import { useTable } from "@/components/tiptap-ui/table-button"

// --- UI Primitives ---
import type { ButtonProps } from "@/components/tiptap-ui-primitive/button"
import { Button } from "@/components/tiptap-ui-primitive/button"

export interface TableButtonProps
  extends Omit<ButtonProps, "type">,
    UseTableConfig {
  /**
   * Optional text to display alongside the icon.
   */
  text?: string
}

/**
 * Button that inserts a 3x3 table (with a header row) at the cursor.
 */
export const TableButton = React.forwardRef<HTMLButtonElement, TableButtonProps>(
  ({ editor: providedEditor, text, onInserted, onClick, children, ...buttonProps }, ref) => {
    const { editor } = useTiptapEditor(providedEditor)
    const { isVisible, canInsert, handleInsert, label, Icon } = useTable({
      editor,
      onInserted,
    })

    const handleClick = React.useCallback(
      (event: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        handleInsert()
      },
      [handleInsert, onClick]
    )

    if (!isVisible) {
      return null
    }

    return (
      <Button
        type="button"
        data-style="ghost"
        role="button"
        disabled={!canInsert}
        data-disabled={!canInsert}
        tabIndex={-1}
        aria-label={label}
        tooltip={label}
        onClick={handleClick}
        {...buttonProps}
        ref={ref}
      >
        {children ?? (
          <>
            <Icon className="tiptap-button-icon" />
            {text && <span className="tiptap-button-text">{text}</span>}
          </>
        )}
      </Button>
    )
  }
)

TableButton.displayName = "TableButton"
