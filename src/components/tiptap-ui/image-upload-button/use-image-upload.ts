"use client"

import * as React from "react"
import { useHotkeys } from "react-hotkeys-hook"
import { type Editor } from "@tiptap/react"

// --- Hooks ---
import { useTiptapEditor } from "@/hooks/use-tiptap-editor"
import { useIsMobile } from "@/hooks/use-mobile"

// --- Lib ---
import {
  isExtensionAvailable,
  isNodeTypeSelected,
} from "@/lib/tiptap-utils"
import type { ImageAssetReference } from "@/lib/image-assets"

// --- Icons ---
import { ImagePlusIcon } from "@/components/tiptap-icons/image-plus-icon"

export const IMAGE_UPLOAD_SHORTCUT_KEY = ""

export type ImageUploadFn = (
  file: File,
  onProgress?: (event: { progress: number }) => void,
  abortSignal?: AbortSignal
) => Promise<ImageAssetReference>

/**
 * Configuration for the image upload functionality
 */
export interface UseImageUploadConfig {
  /**
   * The Tiptap editor instance.
   */
  editor?: Editor | null
  /**
   * Whether the button should hide when insertion is not available.
   * @default false
   */
  hideWhenUnavailable?: boolean
  /**
   * Callback function called after a successful image insertion.
   */
  onInserted?: () => void
  /**
   * Uploads a single file and resolves with its persisted asset reference.
   */
  upload?: ImageUploadFn
  /**
   * Acceptable file types for the OS file picker.
   * @default "image/*"
   */
  accept?: string
}

/**
 * Checks if image can be inserted in the current editor state
 */
export function canInsertImage(editor: Editor | null): boolean {
  if (!editor || !editor.isEditable) return false
  if (
    !isExtensionAvailable(editor, "image") ||
    isNodeTypeSelected(editor, ["image"])
  )
    return false

  return editor.can().insertContent({ type: "image" })
}

/**
 * Checks if image is currently active
 */
export function isImageActive(editor: Editor | null): boolean {
  if (!editor || !editor.isEditable) return false
  return editor.isActive("image")
}

/**
 * Determines if the image button should be shown
 */
export function shouldShowButton(props: {
  editor: Editor | null
  hideWhenUnavailable: boolean
}): boolean {
  const { editor, hideWhenUnavailable } = props

  if (!editor || !editor.isEditable) return false
  if (!isExtensionAvailable(editor, "image")) return false

  if (hideWhenUnavailable && !editor.isActive("code")) {
    return canInsertImage(editor)
  }

  return true
}

/**
 * Custom hook that provides image functionality for Tiptap editor.
 *
 * Clicking the button (or its shortcut) opens the OS file picker directly -
 * there's no intermediate "click to upload or drag and drop" placeholder
 * node. Selected files are uploaded and inserted as image nodes once ready.
 *
 * @example
 * ```tsx
 * function MySimpleImageButton() {
 *   const { isVisible, handleImage, inputRef, accept, handleFileChange } = useImageUpload({
 *     upload: myUploadFn,
 *   })
 *
 *   if (!isVisible) return null
 *
 *   return (
 *     <>
 *       <button onClick={handleImage}>Add Image</button>
 *       <input
 *         ref={inputRef}
 *         type="file"
 *         accept={accept}
 *         multiple
 *         hidden
 *         onChange={handleFileChange}
 *       />
 *     </>
 *   )
 * }
 * ```
 */
export function useImageUpload(config?: UseImageUploadConfig) {
  const {
    editor: providedEditor,
    hideWhenUnavailable = false,
    onInserted,
    upload,
    accept = "image/*",
  } = config || {}

  const { editor } = useTiptapEditor(providedEditor)
  const isMobile = useIsMobile()
  const [isVisible, setIsVisible] = React.useState<boolean>(true)
  const canInsert = canInsertImage(editor)
  const isActive = isImageActive(editor)
  const inputRef = React.useRef<HTMLInputElement | null>(null)

  React.useEffect(() => {
    if (!editor) return

    const handleSelectionUpdate = () => {
      setIsVisible(shouldShowButton({ editor, hideWhenUnavailable }))
    }

    handleSelectionUpdate()

    editor.on("selectionUpdate", handleSelectionUpdate)

    return () => {
      editor.off("selectionUpdate", handleSelectionUpdate)
    }
  }, [editor, hideWhenUnavailable])

  const insertUploadedFiles = React.useCallback(
    async (files: File[]) => {
      if (!editor || !upload || files.length === 0) return

      const results = await Promise.allSettled(files.map((file) => upload(file)))

      const nodes = results.flatMap((result, index) => {
        if (result.status !== "fulfilled") {
          console.error("Failed to upload image:", result.reason)
          return []
        }
        const filename = files[index].name.replace(/\.[^/.]+$/, "") || "image"
        return [
          {
            type: "image",
            attrs: { assetId: result.value.assetId, alt: filename, title: filename },
          },
        ]
      })

      if (nodes.length > 0) {
        editor.chain().focus().insertContent(nodes).run()
        onInserted?.()
      }
    },
    [editor, upload, onInserted]
  )

  const handleFileChange = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []).filter((file) =>
        file.type.startsWith("image/")
      )
      event.target.value = ""
      if (files.length > 0) {
        void insertUploadedFiles(files)
      }
    },
    [insertUploadedFiles]
  )

  const handleImage = React.useCallback(() => {
    if (!editor || !canInsertImage(editor)) return false
    inputRef.current?.click()
    return true
  }, [editor])

  useHotkeys(
    IMAGE_UPLOAD_SHORTCUT_KEY,
    (event) => {
      event.preventDefault()
      handleImage()
    },
    {
      enabled: Boolean(IMAGE_UPLOAD_SHORTCUT_KEY) && isVisible && canInsert,
      enableOnContentEditable: !isMobile,
      enableOnFormTags: true,
    }
  )

  return {
    isVisible,
    isActive,
    handleImage,
    canInsert,
    label: "Add image",
    shortcutKeys: IMAGE_UPLOAD_SHORTCUT_KEY,
    Icon: ImagePlusIcon,
    inputRef,
    accept,
    handleFileChange,
  }
}
